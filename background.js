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
});

browser.runtime.onMessage.addListener(message => {
  if (message?.type == "sync") {
    return syncColors();
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
  for (const tab of await browser.tabs.query({ type: "mail" })) {
    injectTab(tab);
  }
  syncColors();
  setInterval(syncColors, SYNC_INTERVAL_MS);
})();
