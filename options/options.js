"use strict";

const DEFAULT_COLOR = { bg: "#dddddd", fg: "#444444" };

const statusEl = document.getElementById("status");
const syncButton = document.getElementById("sync");
const table = document.getElementById("labels");

function showStatus(syncStatus) {
  statusEl.replaceChildren();
  if (!syncStatus) {
    statusEl.textContent = "Not synced yet.";
    return;
  }
  const time = new Date(syncStatus.time).toLocaleString();
  if (!syncStatus.results.length) {
    statusEl.textContent = `No Gmail accounts found (checked ${time}).`;
    return;
  }
  for (const { username, count, error } of syncStatus.results) {
    const line = document.createElement("div");
    if (error) {
      line.className = "error";
      line.textContent = `${username}: sync failed (${time}): ${error}`;
    } else {
      line.textContent = `${username}: ${count} label colors synced (${time}).`;
    }
    statusEl.append(line);
  }
}

async function render() {
  const { synced = {}, overrides = {}, syncStatus } =
    await browser.storage.local.get(["synced", "overrides", "syncStatus"]);
  showStatus(syncStatus);

  const fromGmail = Object.assign({}, ...Object.values(synced).reverse());
  const names = await browser.runtime.sendMessage({ type: "listLabels" });
  for (const name of Object.keys(fromGmail)) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  if (!names.includes("Inbox")) {
    names.unshift("Inbox");
  }

  table.replaceChildren(
    ...names.map(name => {
      const color = overrides[name] ?? fromGmail[name] ?? DEFAULT_COLOR;
      const row = document.createElement("tr");

      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = name;
      chip.title = name;
      chip.style.backgroundColor = color.bg;
      chip.style.color = color.fg;

      const pickers = ["bg", "fg"].map(part => {
        const input = document.createElement("input");
        input.type = "color";
        input.value = color[part];
        input.title = part == "bg" ? "Background color" : "Text color";
        input.addEventListener("change", () => setOverride(name, part, input.value, color));
        return input;
      });

      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "Use Gmail color";
      reset.hidden = !overrides[name];
      reset.addEventListener("click", () => clearOverride(name));

      for (const content of [chip, ...pickers, reset]) {
        const cell = document.createElement("td");
        cell.append(content);
        row.append(cell);
      }
      return row;
    })
  );
}

async function setOverride(name, part, value, current) {
  const { overrides = {} } = await browser.storage.local.get("overrides");
  overrides[name] = { ...current, ...overrides[name], [part]: value };
  await browser.storage.local.set({ overrides });
  render();
}

async function clearOverride(name) {
  const { overrides = {} } = await browser.storage.local.get("overrides");
  delete overrides[name];
  await browser.storage.local.set({ overrides });
  render();
}

const menuList = document.getElementById("menu-labels");

async function renderMenuLabels() {
  const choices = await browser.runtime.sendMessage({ type: "listMenuLabels" });
  menuList.replaceChildren(
    ...choices.map(({ label, shown }) => {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = shown;
      checkbox.dataset.label = label;
      checkbox.addEventListener("change", () =>
        setMenuVisibility([label], checkbox.checked)
      );
      const row = document.createElement("label");
      row.append(checkbox, ` ${label}`);
      return row;
    })
  );
}

async function setMenuVisibility(labels, shown) {
  const { menuVisibility = {} } = await browser.storage.local.get("menuVisibility");
  for (const label of labels) {
    menuVisibility[label] = shown;
  }
  await browser.storage.local.set({ menuVisibility });
}

for (const [id, shown] of [["menu-all", true], ["menu-none", false]]) {
  document.getElementById(id).addEventListener("click", async () => {
    const boxes = [...menuList.querySelectorAll("input[type=checkbox]")];
    for (const box of boxes) {
      box.checked = shown;
    }
    await setMenuVisibility(boxes.map(box => box.dataset.label), shown);
  });
}

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  statusEl.textContent = "Syncing…";
  try {
    await browser.runtime.sendMessage({ type: "sync" });
  } finally {
    syncButton.disabled = false;
    render();
  }
});

renderMenuLabels();
render();
