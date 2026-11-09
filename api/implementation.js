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
`;

// { serverKey: { labelName: { bg, fg } }, "*": { labelName: { bg, fg } } }
let gColors = {};
// about:3pane window -> { proto, original, style }
const gPatched = new Map();

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
  const labels = [];
  for (const label of parseLabels(raw)) {
    const name = label.startsWith("\\") ? SYSTEM_LABELS[label] : label;
    if (name) {
      labels.push({ name, color: colorFor(serverKey, name) });
    }
  }
  return labels;
}

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
    ...labels.map(({ name, color }) => {
      const chip = doc.createElement("span");
      chip.className = "gm-label-chip";
      chip.textContent = name;
      chip.title = name;
      chip.style.backgroundColor = color.bg;
      chip.style.color = color.fg;
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
      console.error("Gmail Label Chips:", e);
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
    if (isAppShutdown) {
      return;
    }
    for (const [win, patch] of gPatched) {
      try {
        unpatchWindow(win, patch);
      } catch (e) {
        console.error("Gmail Label Chips:", e);
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
            .filter(
              s =>
                s.type == "imap" &&
                s.QueryInterface(Ci.nsIImapIncomingServer).isGMailServer
            )
            .map(s => ({
              key: s.key,
              accountId: MailServices.accounts.findAccountForServer(s)?.key,
              username: s.username,
            }));
        },

        async addLabel(messageIds, label) {
          const quoted = `"${label.replace(/[\\"]/g, "\\$&")}"`;
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
