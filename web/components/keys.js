// Keyboard shortcuts: / focus the input, j and k move through offers, Enter chooses, ? shows help.

import { h } from "../lib/dom.js";

const SHORTCUTS = [
  ["/", "Focus the search box"],
  ["j", "Next offer"],
  ["k", "Previous offer"],
  ["Enter", "Choose the focused offer"],
  ["w", "Watch the focused offer's price"],
  ["g h", "Go to History"],
  ["g n", "New search"],
  ["?", "Show these shortcuts"],
  ["Esc", "Close a dialog or leave a field"],
];

function helpDialog() {
  let d = document.getElementById("keys-help");
  if (d) return d;
  d = h("dialog", { id: "keys-help", "aria-labelledby": "keys-title" },
    h("form", { method: "dialog" },
      h("h2", { id: "keys-title" }, "Keyboard shortcuts"),
      h("dl", { class: "keys" }, SHORTCUTS.map(([k, v]) => [h("dt", {}, k.split(" ").map((p) => h("kbd", {}, p))), h("dd", {}, v)])),
      h("div", { class: "row end" }, h("button", { value: "close", class: "btn" }, "Close"))));
  document.body.append(d);
  return d;
}

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

function rows() {
  return [...document.querySelectorAll("tr[data-row]")].filter((r) => r.offsetParent !== null);
}

function moveRow(step) {
  const list = rows();
  if (!list.length) return;
  const i = list.indexOf(document.activeElement?.closest?.("tr[data-row]"));
  const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? (step > 0 ? 0 : list.length - 1) : i + step))];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: "nearest" });
}

export function installShortcuts() {
  let g = 0;
  for (const b of document.querySelectorAll(".kbd-btn")) b.addEventListener("click", () => helpDialog().showModal());
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (document.querySelector("dialog[open]") && e.key !== "Escape") return;
    if (typing(e.target)) {
      if (e.key === "Escape" && e.target.tagName !== "SELECT") e.target.blur();
      return;
    }
    const row = document.activeElement?.closest?.("tr[data-row]");
    if (g && Date.now() - g < 1200) {
      g = 0;
      if (e.key === "h") { location.hash = "#/history"; e.preventDefault(); }
      else if (e.key === "n") { location.hash = "#/"; e.preventDefault(); }
      return;
    }
    switch (e.key) {
      case "/": {
        const t = document.querySelector("[data-slash]");
        if (t) { e.preventDefault(); t.focus(); t.select?.(); }
        break;
      }
      case "?": e.preventDefault(); helpDialog().showModal(); break;
      case "j": e.preventDefault(); moveRow(1); break;
      case "k": e.preventDefault(); moveRow(-1); break;
      case "g": g = Date.now(); break;
      case "Enter":
        if (row && document.activeElement === row) { e.preventDefault(); row.querySelector("button[data-key^='choose-']")?.click(); }
        break;
      case "w":
        if (row) { e.preventDefault(); row.querySelector("button[data-key^='watch-']")?.click(); }
        break;
    }
  });
}
