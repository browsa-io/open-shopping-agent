// History: every run, newest first, with search by words, store or status.

import { ago, api, h, icon } from "../lib/dom.js";
import { money, storeName } from "../lib/wording.js";
import { searchRuns } from "../lib/model.js";

const STATUS = { running: ["green", "Running"], cancelled: ["red", "Cancelled"], failed: ["red", "Did not finish"] };

export async function historyView(main) {
  document.title = "History - Open Shopping Agent";
  const runs = await api("/api/runs?limit=200");
  const list = h("div", { class: "card pad0" });
  const q = h("input", { type: "search", id: "h-search", placeholder: "Search history", "aria-label": "Search history", "data-slash": "1", autocomplete: "off" });
  const count = h("span", { class: "count", "aria-live": "polite" });
  const draw = () => {
    const shown = searchRuns(runs, q.value);
    count.textContent = q.value ? `${shown.length} of ${runs.length}` : runs.length ? `${runs.length}` : "";
    list.replaceChildren(shown.length ? h("ul", { class: "list" }, shown.map((r) => {
      const [tone, label] = STATUS[r.status] || [];
      return h("li", {},
        h("a", { class: "rowlink", href: `#/run/${encodeURIComponent(r.runId)}` },
          h("div", { class: "grow" },
            h("div", { class: "title" }, r.prompt),
            h("div", { class: "sub" }, [ago(r.startedAt), r.stores?.length ? r.stores.map((s) => storeName(s)).join(", ") : null].filter(Boolean).join(". "))),
          r.orders ? h("span", { class: "badge green" }, `${r.orders} order${r.orders > 1 ? "s" : ""}`) : null,
          label ? h("span", { class: `badge ${tone}` }, r.status === "running" ? h("span", { class: "dot pulse" }) : null, label) : null,
          h("span", { class: "amt" }, r.picksTotal ? money(r.picksTotal) : h("span", { class: "faint" }, "No picks"))));
    })) : runs.length
      ? h("div", { class: "empty" }, `Nothing matches "${q.value}". `, h("button", { type: "button", class: "linkish", onclick: () => { q.value = ""; draw(); q.focus(); } }, "Clear search"))
      : h("div", { class: "empty" }, h("p", {}, "No searches yet."), h("p", {}, h("a", { class: "btn primary", href: "#/" }, "Start your first search"))));
  };
  q.addEventListener("input", draw);
  main.append(
    h("div", { class: "page-head" }, h("h1", {}, "History"), count, h("span", { class: "spacer" }), h("a", { class: "btn sm", href: "#/" }, "New search")),
    runs.length ? h("div", { class: "search-box" }, icon("search"), q, h("kbd", { class: "kbd-hint", "aria-hidden": "true" }, "/")) : null,
    list,
  );
  draw();
}
