/* Experiment API: draws Gmail label chips on the cards view of the message list. */

"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

var { ExtensionError } = ExtensionUtils;

const STYLE_ID = "gmail-label-chips-style";
// Gmail's look for labels that have no color set.
const DEFAULT_COLOR = { bg: "#dddddd", fg: "#444444" };
// System labels Gmail shows as chips. The rest (\Important, \Starred, \Sent,
// \Draft, ...) are shown as icons or not at all.
const SYSTEM_LABELS = { "\\Inbox": "Inbox" };
// Labels the user files finished conversations under: Archive, Archives and
// everything below them.
const ARCHIVE_LABEL = /^Archives?(\/|$)/i;
// Wait this long after archive folders change before re-reading them.
const REINDEX_DELAY_MS = 3000;

const CSS = `
#threadTree .card-container .thread-card-dynamic-row.gm-has-labels {
  grid-template:
    "subject subject subject" max-content
    "button labels info" minmax(auto, 1fr)
    / auto minmax(0, 1fr) auto !important;
}
#threadTree.cards-row-compact .card-container .thread-card-dynamic-row.gm-has-labels {
  grid-template:
    "button subject labels info" max-content
    / auto minmax(0, 1fr) fit-content(40%) auto !important;
}
.gm-label-chips {
  grid-area: labels;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}
.thread-card-dynamic-row:not(.gm-has-labels) > .gm-label-chips {
  display: none;
}
.gm-label-chip {
  flex: 0 1 auto;
  box-sizing: border-box;
  min-width: 2.5em;
  max-width: 14em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8em;
  font-weight: normal;
  line-height: 1.5;
  padding: 0 5px;
  border-radius: 4px;
}
/* An archive label of other messages in the thread: a hint to file this one too. */
.gm-label-chip.gm-thread-hint {
  border: 1px dashed;
  background-color: transparent !important;
  color: inherit !important;
  line-height: calc(1.5em - 2px);
}
`;

// { serverKey: { labelName: { bg, fg } }, "*": { labelName: { bg, fg } } }
let gColors = {};
// about:3pane window -> { proto, original, style }
const gPatched = new Map();
// serverKey -> { byThread, byMessageId }, each Map(key -> Set(archive label)).
// Built from the archive label folders and All Mail.
const gArchiveIndex = new Map();
// serverKey -> timer id of a pending rebuild
const gReindexTimers = new Map();
// serverKey -> true while a rebuild runs, "again" if another was asked for
const gIndexing = new Map();

/**
 * Parse an IMAP X-GM-LABELS value, e.g. `"Action Required" Github "\\Inbox"`.
 */
function parseLabels(raw) {
  const labels = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let match;
  while ((match = re.exec(raw))) {
    const label =
      match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2];
    labels.push(decodeModifiedUtf7(label));
  }
  return labels;
}

/**
 * Decode IMAP modified UTF-7 (RFC 3501), leaving anything that isn't valid
 * modified UTF-7 untouched.
 */
function decodeModifiedUtf7(str) {
  return str.replace(/&([A-Za-z0-9+,]*)-/g, (whole, b64) => {
    if (!b64) {
      return "&";
    }
    const bytes = Math.floor((b64.length * 6) / 8);
    if (bytes < 2 || bytes % 2) {
      return whole;
    }
    try {
      const padded =
        b64.replace(/,/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(padded);
      let out = "";
      for (let i = 0; i + 1 < bin.length; i += 2) {
        out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
      }
      return out;
    } catch {
      return whole;
    }
  });
}

function quoteLabel(label) {
  return `"${label.replace(/[\\"]/g, "\\$&")}"`;
}

function colorFor(serverKey, name) {
  return gColors["*"]?.[name] ?? gColors[serverKey]?.[name] ?? DEFAULT_COLOR;
}

function labelsForRow(row) {
  if (!row.view || row.dataset.properties?.split(" ").includes("dummy")) {
    return [];
  }
  let hdr;
  try {
    hdr = row.view.getMsgHdrAt(row._index);
  } catch {
    return [];
  }
  const raw = hdr?.getStringProperty("X-GM-LABELS");
  if (!raw) {
    return [];
  }
  const serverKey = hdr.folder?.server?.key;
  const own = parseLabels(raw);
  const labels = [];
  for (const label of own) {
    const name = label.startsWith("\\") ? SYSTEM_LABELS[label] : label;
    if (name) {
      labels.push({ name, color: colorFor(serverKey, name) });
    }
  }
  if (hdr.folder.getFlag(Ci.nsMsgFolderFlags.Inbox)) {
    for (const name of threadArchiveLabels(hdr, new Set(own))) {
      labels.push({ name, color: colorFor(serverKey, name), hint: true });
    }
  }
  return labels;
}

function addToIndex(map, key, label) {
  if (!key) {
    return;
  }
  let labels = map.get(key);
  if (!labels) {
    labels = new Set();
    map.set(key, labels);
  }
  labels.add(label);
}

function messageIdsOf(hdr) {
  const ids = [hdr.messageId];
  for (let i = 0; i < hdr.numReferences; i++) {
    ids.push(hdr.getStringReference(i));
  }
  return ids;
}

/** Record the archive labels of a message, plus `extra` labels it's about to get. */
function indexMessage(index, hdr, extra = []) {
  const labels = parseLabels(hdr.getStringProperty("X-GM-LABELS"))
    .filter(label => ARCHIVE_LABEL.test(label))
    .concat(extra);
  if (!labels.length) {
    return;
  }
  const thread = hdr.getStringProperty("X-GM-THRID");
  const ids = messageIdsOf(hdr);
  for (const label of labels) {
    addToIndex(index.byThread, thread, label);
    for (const id of ids) {
      addToIndex(index.byMessageId, id, label);
    }
  }
}

/**
 * The archive labels that other messages in the thread of `hdr` have and it
 * hasn't. Threads are matched by Gmail's thread id, or by Message-ID and
 * References for messages Thunderbird has no thread id for.
 */
function threadArchiveLabels(hdr, ownLabels) {
  const index = gArchiveIndex.get(hdr.folder.server.key);
  if (!index) {
    return [];
  }
  const found = new Set(index.byThread.get(hdr.getStringProperty("X-GM-THRID")));
  for (const id of messageIdsOf(hdr)) {
    for (const label of index.byMessageId.get(id) ?? []) {
      found.add(label);
    }
  }
  return [...found]
    .filter(label => !ownLabels.has(label))
    .sort((a, b) => a.localeCompare(b));
}

/** A folder's Gmail label, e.g. "Archives/Hiring". */
function folderLabel(folder) {
  const parts = [];
  for (let f = folder; f && !f.isServer; f = f.parent) {
    parts.unshift(f.name);
  }
  return parts.join("/");
}

function isAllMail(folder) {
  return (
    folder.name == "All Mail" ||
    (folder.getFlag(Ci.nsMsgFolderFlags.Archive) &&
      !ARCHIVE_LABEL.test(folderLabel(folder)))
  );
}

function isIndexedFolder(folder) {
  return ARCHIVE_LABEL.test(folderLabel(folder)) || isAllMail(folder);
}

function isGmailServer(server) {
  return (
    server.type == "imap" &&
    server.QueryInterface(Ci.nsIImapIncomingServer).isGMailServer
  );
}

/** Read the archive labels of every message Thunderbird has downloaded. */
async function buildArchiveIndex(server) {
  if (gIndexing.get(server.key)) {
    gIndexing.set(server.key, "again");
    return;
  }
  gIndexing.set(server.key, true);
  try {
    do {
      gIndexing.set(server.key, true);
      const index = { byThread: new Map(), byMessageId: new Map() };
      for (const folder of server.rootFolder.descendants) {
        if (!isIndexedFolder(folder) || !folder.summaryFile?.exists()) {
          continue;
        }
        const label = folderLabel(folder);
        // Gmail leaves out the label of the folder a message is in.
        const extra = ARCHIVE_LABEL.test(label) ? [label] : [];
        const weOpenedDB = !folder.databaseOpen;
        try {
          let count = 0;
          for (const hdr of folder.msgDatabase.enumerateMessages()) {
            indexMessage(index, hdr, extra);
            // Let Thunderbird stay responsive while reading big folders.
            if (++count % 500 == 0) {
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        } catch (e) {
          console.error(`Label chips for Gmail: couldn't read ${folder.URI}`, e);
        }
        if (weOpenedDB && !isFolderShown(folder)) {
          try {
            folder.msgDatabase.forceClosed();
            folder.msgDatabase = null;
          } catch {}
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      gArchiveIndex.set(server.key, index);
      refreshAll();
    } while (gIndexing.get(server.key) == "again");
  } finally {
    gIndexing.delete(server.key);
  }
}

/** Whether a mail tab shows the folder, so its database must stay open. */
function isFolderShown(folder) {
  for (const win of gPatched.keys()) {
    if (win.gFolder == folder) {
      return true;
    }
  }
  return false;
}

function scheduleReindex(server) {
  clearTimeout(gReindexTimers.get(server.key));
  gReindexTimers.set(
    server.key,
    setTimeout(() => {
      gReindexTimers.delete(server.key);
      buildArchiveIndex(server);
    }, REINDEX_DELAY_MS)
  );
}

function indexAllServers() {
  for (const server of MailServices.accounts.allServers) {
    if (isGmailServer(server) && !gArchiveIndex.has(server.key)) {
      // Mark it so another mail tab doesn't start a second build.
      gArchiveIndex.set(server.key, { byThread: new Map(), byMessageId: new Map() });
      buildArchiveIndex(server);
    }
  }
}

const gFolderListener = {
  watched(folder) {
    return (
      folder &&
      !folder.isServer &&
      gArchiveIndex.has(folder.server.key) &&
      isIndexedFolder(folder)
    );
  },
  msgAdded(hdr) {
    if (this.watched(hdr.folder)) {
      scheduleReindex(hdr.folder.server);
    }
  },
  msgsDeleted(hdrs) {
    if (this.watched(hdrs[0]?.folder)) {
      scheduleReindex(hdrs[0].folder.server);
    }
  },
  msgsMoveCopyCompleted(isMove, srcHdrs, destFolder) {
    if (this.watched(srcHdrs[0]?.folder)) {
      scheduleReindex(srcHdrs[0].folder.server);
    }
    if (!this.watched(destFolder)) {
      return;
    }
    // Show the label right away; the copies in the archive folder may only be
    // downloaded later.
    const index = gArchiveIndex.get(destFolder.server.key);
    const label = folderLabel(destFolder);
    const extra = ARCHIVE_LABEL.test(label) ? [label] : [];
    for (const hdr of srcHdrs) {
      indexMessage(index, hdr, extra);
    }
    refreshAll();
  },
  folderDeleted(folder) {
    if (this.watched(folder)) {
      scheduleReindex(folder.server);
    }
  },
  folderRenamed(oldFolder, newFolder) {
    if (gArchiveIndex.has(newFolder.server.key)) {
      scheduleReindex(newFolder.server);
    }
  },
};
let gListening = false;

function renderChips(row) {
  const dynamicRow = row.querySelector(".thread-card-dynamic-row");
  if (!dynamicRow) {
    return;
  }
  const doc = row.ownerDocument;
  let box = dynamicRow.querySelector(".gm-label-chips");
  if (!box) {
    box = doc.createElement("div");
    box.className = "gm-label-chips";
    dynamicRow.insertBefore(
      box,
      dynamicRow.querySelector(".thread-card-icon-info")
    );
  }

  const labels = labelsForRow(row);
  box.replaceChildren(
    ...labels.map(({ name, color, hint }) => {
      const chip = doc.createElement("span");
      chip.className = "gm-label-chip";
      chip.textContent = name;
      chip.title = name;
      chip.style.backgroundColor = color.bg;
      chip.style.color = color.fg;
      if (hint) {
        chip.classList.add("gm-thread-hint");
        chip.textContent = `→ ${name.replace(ARCHIVE_LABEL, "") || name}`;
        chip.title = `Other messages in this conversation are in ${name}`;
        chip.style.borderColor = color.bg == DEFAULT_COLOR.bg ? "" : color.bg;
      }
      return chip;
    })
  );
  dynamicRow.classList.toggle("gm-has-labels", labels.length > 0);
}

async function waitFor3Pane(browser) {
  for (let i = 0; i < 100; i++) {
    const win = browser.contentWindow;
    if (
      win?.location.href.startsWith("about:3pane") &&
      win.document.readyState == "complete" &&
      win.threadTree
    ) {
      return win;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

async function patchWindow(win) {
  if (gPatched.has(win)) {
    return;
  }
  await win.customElements.whenDefined("thread-card");
  if (gPatched.has(win)) {
    return;
  }

  const proto = win.customElements.get("thread-card").prototype;
  const original = proto.fillRow;
  proto.fillRow = function (...args) {
    original.apply(this, args);
    try {
      renderChips(this);
    } catch (e) {
      console.error("Label chips for Gmail:", e);
    }
  };

  const style = win.document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  win.document.head.appendChild(style);

  gPatched.set(win, { proto, original, style });
  win.addEventListener("unload", () => gPatched.delete(win), { once: true });
  win.threadTree.invalidate();
}

function unpatchWindow(win, { proto, original, style }) {
  proto.fillRow = original;
  style.remove();
  for (const box of win.document.querySelectorAll(".gm-label-chips")) {
    box.parentElement.classList.remove("gm-has-labels");
    box.remove();
  }
  win.threadTree?.invalidate();
}

function refreshAll() {
  for (const win of gPatched.keys()) {
    win.threadTree?.invalidate();
  }
}

function getServer(serverKey) {
  const server = MailServices.accounts.getIncomingServer(serverKey);
  if (!server) {
    throw new ExtensionError(`Unknown account: ${serverKey}`);
  }
  return server;
}

var gmailLabelChips = class extends ExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (gListening) {
      MailServices.mfn.removeListener(gFolderListener);
      gListening = false;
    }
    for (const timer of gReindexTimers.values()) {
      clearTimeout(timer);
    }
    gReindexTimers.clear();
    gArchiveIndex.clear();
    if (isAppShutdown) {
      return;
    }
    for (const [win, patch] of gPatched) {
      try {
        unpatchWindow(win, patch);
      } catch (e) {
        console.error("Label chips for Gmail:", e);
      }
    }
    gPatched.clear();
  }

  getAPI(context) {
    return {
      gmailLabelChips: {
        async inject(tabId) {
          const nativeTab = context.extension.tabManager.get(tabId).nativeTab;
          if (nativeTab.mode?.name != "mail3PaneTab") {
            return;
          }
          if (!gListening) {
            const flags = Ci.nsIMsgFolderNotificationService;
            MailServices.mfn.addListener(
              gFolderListener,
              flags.msgAdded |
                flags.msgsDeleted |
                flags.msgsMoveCopyCompleted |
                flags.folderDeleted |
                flags.folderRenamed
            );
            gListening = true;
          }
          indexAllServers();
          const win = await waitFor3Pane(nativeTab.chromeBrowser);
          if (win) {
            await patchWindow(win);
          }
        },

        async setColors(colors) {
          gColors = colors;
          refreshAll();
        },

        async listGmailServers() {
          return MailServices.accounts.allServers
            .filter(isGmailServer)
            .map(s => ({
              key: s.key,
              accountId: MailServices.accounts.findAccountForServer(s)?.key,
              username: s.username,
            }));
        },

        async getLabels(messageIds) {
          return messageIds.map(messageId => {
            const hdr = context.extension.messageManager.get(messageId);
            return hdr
              ? parseLabels(hdr.getStringProperty("X-GM-LABELS")).filter(
                  label => !label.startsWith("\\")
                )
              : [];
          });
        },

        async removeLabel(messageIds, label) {
          for (const messageId of messageIds) {
            const hdr = context.extension.messageManager.get(messageId);
            if (!hdr) {
              continue;
            }
            const labels = parseLabels(hdr.getStringProperty("X-GM-LABELS"));
            if (labels.includes(label)) {
              hdr.setStringProperty(
                "X-GM-LABELS",
                labels.filter(l => l != label).map(quoteLabel).join(" ")
              );
            }
          }
          refreshAll();
        },

        async addLabel(messageIds, label) {
          const quoted = quoteLabel(label);
          for (const messageId of messageIds) {
            const hdr = context.extension.messageManager.get(messageId);
            if (!hdr) {
              continue;
            }
            const raw = hdr.getStringProperty("X-GM-LABELS");
            if (!parseLabels(raw).includes(label)) {
              hdr.setStringProperty(
                "X-GM-LABELS",
                raw ? `${raw} ${quoted}` : quoted
              );
            }
          }
          refreshAll();
        },

        async getAccessToken(serverKey) {
          const server = getServer(serverKey);
          const { OAuth2Module } = ChromeUtils.importESModule(
            "resource:///modules/OAuth2Module.sys.mjs"
          );
          const oauth = new OAuth2Module();
          if (!oauth.initFromMail(server)) {
            throw new ExtensionError(
              `${server.username} doesn't sign in with OAuth`
            );
          }
          return new Promise((resolve, reject) =>
            oauth.getAccessToken({
              onSuccess: resolve,
              onFailure: () =>
                reject(new ExtensionError("Couldn't get a Google access token")),
            })
          );
        },

        async listLabelNames(serverKey) {
          const names = [];
          const walk = (folder, prefix) => {
            for (const sub of folder.subFolders) {
              if (sub.name == "[Gmail]") {
                continue;
              }
              const name = prefix ? `${prefix}/${sub.name}` : sub.name;
              if (!(sub.flags & Ci.nsMsgFolderFlags.Inbox)) {
                names.push(name);
              }
              walk(sub, name);
            }
          };
          walk(getServer(serverKey).rootFolder, "");
          return names;
        },
      },
    };
  }
};
