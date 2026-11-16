"use strict";

const DEFAULT_COLOR = { bg: "#dddddd", fg: "#444444" };

const table = document.getElementById("labels");

async function render() {
  const { labelColors = {} } = await browser.storage.local.get("labelColors");
  const names = await browser.runtime.sendMessage({ type: "listLabels" });
  if (!names.includes("Inbox")) {
    names.unshift("Inbox");
  }

  table.replaceChildren(
    ...names.map(name => {
      const color = labelColors[name] ?? DEFAULT_COLOR;
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
        input.addEventListener("change", () => setColor(name, part, input.value, color));
        return input;
      });

      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "Reset to gray";
      reset.hidden = !labelColors[name];
      reset.addEventListener("click", () => clearColor(name));

      for (const content of [chip, ...pickers, reset]) {
        const cell = document.createElement("td");
        cell.append(content);
        row.append(cell);
      }
      return row;
    })
  );
}

async function setColor(name, part, value, current) {
  const { labelColors = {} } = await browser.storage.local.get("labelColors");
  labelColors[name] = { ...current, ...labelColors[name], [part]: value };
  await browser.storage.local.set({ labelColors });
  render();
}

async function clearColor(name) {
  const { labelColors = {} } = await browser.storage.local.get("labelColors");
  delete labelColors[name];
  await browser.storage.local.set({ labelColors });
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

renderMenuLabels();
render();
