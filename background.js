/* Keeps label colors in sync with Gmail and adds the chips to every mail tab. */

"use strict";

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Stored in storage.local:
//   synced:    { serverKey: { labelName: { bg, fg } } } - colors from Gmail
//   overrides: { labelName: { bg, fg } }                - colors set by hand
//   syncStatus: { time, results: [{ username, count?, error? }] }

async function pushColors() {
  const { synced = {}, overrides = {} } = await browser.storage.local.get([
    "synced",
    "overrides",
  ]);
  await browser.gmailLabelChips.setColors({ ...synced, "*": overrides });
}

async function fetchGmailColors(serverKey) {
  const token = await browser.gmailLabelChips.getAccessToken(serverKey);
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      `Gmail API ${response.status}: ${body?.error?.message ?? response.statusText}`
    );
  }
  const { labels = [] } = await response.json();
  const colors = {};
  for (const label of labels) {
    if (label.color?.backgroundColor) {
      colors[label.name] = {
        bg: label.color.backgroundColor,
        fg: label.color.textColor,
      };
    }
  }
  return colors;
}

async function syncColors() {
  const servers = await browser.gmailLabelChips.listGmailServers();
  const { synced = {} } = await browser.storage.local.get("synced");
  const results = [];
  for (const { key, username } of servers) {
    try {
      synced[key] = await fetchGmailColors(key);
      results.push({ username, count: Object.keys(synced[key]).length });
    } catch (e) {
      // Keep colors from an earlier successful sync.
      console.error(`Gmail Label Chips: syncing ${username} failed`, e);
      results.push({ username, error: e.message });
    }
  }
  const syncStatus = { time: Date.now(), results };
  await browser.storage.local.set({ synced, syncStatus });
  await pushColors();
  return syncStatus;
}

async function injectTab(tab) {
  if (tab.type != "mail") {
    return;
  }
  try {
    await browser.gmailLabelChips.inject(tab.id);
  } catch (e) {
    console.error("Gmail Label Chips: couldn't add chips to tab", tab.id, e);
  }
}

browser.tabs.onCreated.addListener(injectTab);
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status == "complete") {
    injectTab(tab);
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area == "local" && changes.overrides) {
    pushColors();
  }
  if (area == "local" && changes.menuVisibility) {
    buildMenu();
  }
});

// Right-click menu on the message list for adding a label. In Gmail's IMAP,
// copying a message to a label's folder adds that label to the message.

const MENU_ROOT = "gm-label-as";
const MENU_PREFIX = "gm-label:";
// Labels left out of the menu until the options page says otherwise: Archive,
// Archives and everything below them.
const HIDDEN_BY_DEFAULT = /^Archives?(\/|$)/i;

// storage.local menuVisibility: { labelName: boolean } - choices made on the
// options page. Labels not in it use HIDDEN_BY_DEFAULT.
async function menuLabelChoices() {
  const labels = await loadLabelFolders();
  const { menuVisibility = {} } = await browser.storage.local.get("menuVisibility");
  return labels.map(label => ({
    label,
    shown: menuVisibility[label] ?? !HIDDEN_BY_DEFAULT.test(label),
  }));
}

// accountId -> Map(labelName -> folderId)
let gLabelFolders = new Map();
let gMenuLabels = [];

async function loadLabelFolders() {
  const labelFolders = new Map();
  for (const { accountId } of await browser.gmailLabelChips.listGmailServers()) {
    const labels = new Map();
    for (const folder of await browser.folders.query({ accountId, isRoot: false })) {
      const label = folder.path.slice(1);
      if (
        // Inbox, Sent, Drafts, Trash, Spam, All Mail, ...
        folder.specialUse?.length ||
        label == "INBOX" ||
        label.startsWith("[Gmail]")
      ) {
        continue;
      }
      labels.set(label, folder.id);
    }
    labelFolders.set(accountId, labels);
  }
  gLabelFolders = labelFolders;
  return [...new Set([...labelFolders.values()].flatMap(m => [...m.keys()]))].sort(
    (a, b) => a.localeCompare(b)
  );
}

let gMenuBuild = Promise.resolve();

/** Rebuild the menu if the labels changed. Returns true if it was rebuilt. */
function buildMenu() {
  // One at a time, so two rebuilds don't create the same items twice.
  const run = gMenuBuild.then(rebuildMenu);
  gMenuBuild = run.catch(e => console.error("Gmail Label Chips:", e));
  return run;
}

async function rebuildMenu() {
  const labels = (await menuLabelChoices())
    .filter(choice => choice.shown)
    .map(choice => choice.label);
  if (labels.join("\n") == gMenuLabels.join("\n")) {
    return false;
  }
  gMenuLabels = labels;
  await browser.menus.removeAll();
  browser.menus.create({
    id: MENU_ROOT,
    title: "Add Gmail Label",
    contexts: ["message_list"],
    enabled: labels.length > 0,
  });
  for (const label of labels) {
    browser.menus.create({
      id: MENU_PREFIX + label,
      parentId: MENU_ROOT,
      // A single "&" marks a menu access key.
      title: label.replaceAll("&", "&&"),
      contexts: ["message_list"],
    });
  }
  return true;
}

async function selectedMessages(messageList) {
  const messages = [...messageList.messages];
  while (messageList.id) {
    messageList = await browser.messages.continueList(messageList.id);
    messages.push(...messageList.messages);
  }
  return messages;
}

async function addLabel(label, messageList) {
  // folderId -> messageIds
  const copies = new Map();
  for (const message of await selectedMessages(messageList)) {
    const folderId = gLabelFolders.get(message.folder?.accountId)?.get(label);
    // Skip non-Gmail messages and messages already in that label's folder.
    if (!folderId || folderId == message.folder.id) {
      continue;
    }
    if (!copies.has(folderId)) {
      copies.set(folderId, []);
    }
    copies.get(folderId).push(message.id);
  }
  for (const [folderId, messageIds] of copies) {
    try {
      await browser.messages.copy(messageIds, folderId);
      await browser.gmailLabelChips.addLabel(messageIds, label);
    } catch (e) {
      console.error(`Gmail Label Chips: adding label "${label}" failed`, e);
    }
  }
}

browser.menus.onShown.addListener(async info => {
  if (info.contexts.includes("message_list") && (await buildMenu())) {
    browser.menus.refresh();
  }
});

browser.menus.onClicked.addListener(info => {
  if (
    typeof info.menuItemId == "string" &&
    info.menuItemId.startsWith(MENU_PREFIX) &&
    info.selectedMessages
  ) {
    addLabel(info.menuItemId.slice(MENU_PREFIX.length), info.selectedMessages);
  }
});

browser.runtime.onMessage.addListener(message => {
  if (message?.type == "sync") {
    return syncColors();
  }
  if (message?.type == "listMenuLabels") {
    return menuLabelChoices();
  }
  if (message?.type == "listLabels") {
    return browser.gmailLabelChips
      .listGmailServers()
      .then(servers =>
        Promise.all(
          servers.map(s => browser.gmailLabelChips.listLabelNames(s.key))
        )
      )
      .then(lists => [...new Set(lists.flat())].sort());
  }
  return undefined;
});

(async () => {
  await pushColors();
  buildMenu();
  for (const tab of await browser.tabs.query({ type: "mail" })) {
    injectTab(tab);
  }
  syncColors();
  setInterval(syncColors, SYNC_INTERVAL_MS);
})();
