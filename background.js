/* Adds the chips to every mail tab and the label menus. */

"use strict";

// Stored in storage.local:
//   labelColors: { labelName: { bg, fg } } - colors picked on the options page

async function pushColors() {
  const { labelColors = {} } = await browser.storage.local.get("labelColors");
  await browser.gmailLabelChips.setColors(labelColors);
}

/**
 * Versions before 1.8 synced colors from Gmail and kept hand-picked ones apart.
 * Keep the colors labels had then as picked colors, and drop the old data.
 */
async function migrateColors() {
  const old = await browser.storage.local.get(["labelColors", "synced", "overrides"]);
  if (!old.synced && !old.overrides) {
    return;
  }
  if (!old.labelColors) {
    // With more than one account, the first account's color wins.
    const synced = Object.assign({}, ...Object.values(old.synced ?? {}).reverse());
    await browser.storage.local.set({
      labelColors: { ...synced, ...old.overrides },
    });
  }
  await browser.storage.local.remove(["synced", "overrides", "syncStatus"]);
}

async function injectTab(tab) {
  if (tab.type != "mail") {
    return;
  }
  try {
    await browser.gmailLabelChips.inject(tab.id);
  } catch (e) {
    console.error("Label chips for Gmail: couldn't add chips to tab", tab.id, e);
  }
}

browser.tabs.onCreated.addListener(injectTab);
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status == "complete") {
    injectTab(tab);
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area == "local" && changes.labelColors) {
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
const BUTTON_PREFIX = "gm-label-button:";
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
  gMenuBuild = run.catch(e => console.error("Label chips for Gmail:", e));
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
    // A single "&" marks a menu access key.
    const title = label.replaceAll("&", "&&");
    // Checkboxes, ticked in onShown for labels the messages already have.
    browser.menus.create({
      id: MENU_PREFIX + label,
      parentId: MENU_ROOT,
      type: "checkbox",
      title,
      contexts: ["message_list"],
    });
    // The Label button in the header of an open message.
    browser.menus.create({
      id: BUTTON_PREFIX + label,
      type: "checkbox",
      title,
      contexts: ["message_display_action_menu"],
    });
  }
  if (!labels.length) {
    browser.menus.create({
      id: BUTTON_PREFIX,
      title: "No labels chosen in the add-on’s options",
      contexts: ["message_display_action_menu"],
      enabled: false,
    });
  }
  return true;
}

async function allMessages(messageList) {
  const messages = [...messageList.messages];
  while (messageList.id) {
    messageList = await browser.messages.continueList(messageList.id);
    messages.push(...messageList.messages);
  }
  return messages;
}

/**
 * In Gmail's IMAP, deleting a message from a label's folder (without moving it
 * to Trash) removes just that label; the message stays in All Mail.
 */
async function removeLabel(label, messages) {
  const copiesToDelete = new Set();
  const relabeled = [];
  for (const message of messages) {
    const folderId = gLabelFolders.get(message.folder?.accountId)?.get(label);
    if (!folderId) {
      continue;
    }
    if (message.folder.id == folderId) {
      copiesToDelete.add(message.id);
      continue;
    }
    relabeled.push(message.id);
    const copies = message.headerMessageId
      ? await allMessages(
          await browser.messages.query({
            folderId,
            headerMessageId: message.headerMessageId,
          })
        )
      : [];
    if (!copies.length) {
      console.warn(
        `Label chips for Gmail: no copy of "${message.subject}" found in "${label}"; open that folder once so Thunderbird downloads its message list, then try again.`
      );
    }
    for (const copy of copies) {
      copiesToDelete.add(copy.id);
    }
  }
  try {
    if (copiesToDelete.size) {
      await browser.messages.delete([...copiesToDelete], {
        deletePermanently: true,
      });
    }
    await browser.gmailLabelChips.removeLabel(relabeled, label);
  } catch (e) {
    console.error(`Label chips for Gmail: removing label "${label}" failed`, e);
  }
}

async function addLabel(label, messages) {
  // folderId -> messageIds
  const copies = new Map();
  for (const message of messages) {
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
      console.error(`Label chips for Gmail: adding label "${label}" failed`, e);
    }
  }
}

/** The menu labels that every one of the messages already has. */
async function appliedLabels(messages) {
  if (!messages.length) {
    return new Set();
  }
  const lists = await browser.gmailLabelChips.getLabels(messages.map(m => m.id));
  const labelSets = messages.map((message, i) => {
    const labels = new Set(lists[i]);
    // Gmail leaves out the label of the folder a message is in.
    const folderLabel = message.folder?.path.slice(1);
    if (gLabelFolders.get(message.folder?.accountId)?.has(folderLabel)) {
      labels.add(folderLabel);
    }
    return labels;
  });
  return new Set(
    gMenuLabels.filter(label => labelSets.every(labels => labels.has(label)))
  );
}

browser.menus.onShown.addListener(async (info, tab) => {
  let prefix;
  let messages = [];
  if (info.contexts.includes("message_list")) {
    prefix = MENU_PREFIX;
    if (info.selectedMessages) {
      messages = await allMessages(info.selectedMessages);
    }
  } else if (info.contexts.includes("message_display_action_menu")) {
    prefix = BUTTON_PREFIX;
    if (tab) {
      messages = await browser.messageDisplay.getDisplayedMessages(tab.id);
    }
  } else {
    return;
  }

  await buildMenu();
  const applied = await appliedLabels(messages);
  await Promise.all(
    gMenuLabels.map(label =>
      browser.menus.update(prefix + label, { checked: applied.has(label) })
    )
  );
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;
  if (typeof id != "string") {
    return;
  }
  // Selecting a ticked label removes it, an unticked one adds it.
  const apply = info.wasChecked ? removeLabel : addLabel;
  if (id.startsWith(MENU_PREFIX) && info.selectedMessages) {
    apply(id.slice(MENU_PREFIX.length), await allMessages(info.selectedMessages));
  } else if (id.startsWith(BUTTON_PREFIX) && tab) {
    apply(
      id.slice(BUTTON_PREFIX.length),
      await browser.messageDisplay.getDisplayedMessages(tab.id)
    );
  }
});

browser.runtime.onMessage.addListener(message => {
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
  await migrateColors();
  await pushColors();
  buildMenu();
  for (const tab of await browser.tabs.query({ type: "mail" })) {
    injectTab(tab);
  }
})();
