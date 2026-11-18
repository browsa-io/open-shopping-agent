// Watches: price-drop and back-in-stock alerts. Also created from any offer ("Watch this price").

import { api, h, toast } from "../lib/dom.js";
import { ALL_STORES, STORE_NAMES, money } from "../lib/wording.js";

const WATCH_STATUS = { saved: "Not checked yet", active: "Watching", triggered: "Alert sent", paused: "Paused" };

export async function watchesView(main, app) {
  document.title = "Watches - Open Shopping Agent";
  const meta = app.meta;
  const list = h("div", { class: "card pad0" });
  const load = async () => {
    const watches = await api("/api/watches");
    list.replaceChildren(watches.length ? h("ul", { class: "list" }, watches.map((w) => h("li", {},
      h("div", { class: "rowitem" },
        h("div", { class: "grow" },
          w.url ? h("a", { class: "title", href: w.url, target: "_blank", rel: "noopener noreferrer", title: w.item }, w.item) : h("div", { class: "title", title: w.item }, w.item),
          h("div", { class: "sub" }, [
            w.kind === "price_drop" ? `At or below ${money(w.below)}` : "Back in stock",
            w.stores?.length ? w.stores.map((s) => STORE_NAMES[s]).join(", ") : "All your stores",
            w.lastPrice ? `Last seen ${money(w.lastPrice)}${w.lastStore ? ` at ${STORE_NAMES[w.lastStore]}` : ""}` : null,
            w.lastError ? `Last check did not finish` : null,
          ].filter(Boolean).join(". "))),
        h("span", { class: `badge ${w.status === "triggered" ? "green" : ""}` }, WATCH_STATUS[w.status] || w.status),
        meta.canCheckWatches ? h("button", {
          class: "btn sm", "aria-label": `Check ${w.item} now`,
          onclick: async (ev) => {
            const b = ev.currentTarget;
            b.disabled = true;
            b.textContent = "Checking";
            try {
              const r = await api(`/api/watches/${encodeURIComponent(w.id)}/check`, { method: "POST", body: {} });
              toast(r.lastError ? "The check did not finish. Try again later." : r.lastPrice ? `Best price now ${money(r.lastPrice)}` : "Checked. Not in stock yet.", !!r.lastError);
              load();
            } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = "Check now"; }
          },
        }, "Check now") : null,
        h("button", {
          class: "btn sm ghost", "aria-label": `Delete watch ${w.item}`,
          onclick: async () => { try { await api(`/api/watches/${encodeURIComponent(w.id)}`, { method: "DELETE" }); toast("Watch deleted"); load(); } catch (e) { toast(e.message, true); } },
        }, "Delete"))))) : h("div", { class: "empty" },
      h("p", {}, "No watches yet."),
      h("p", { class: "faint small" }, "Add one below, or press Watch this price next to any offer in a search.")));
  };

  const item = h("input", { type: "text", id: "w-item", required: true, maxlength: 300, placeholder: "6 ft HDMI 2.1 cable, or a product link" });
  const below = h("input", { type: "number", id: "w-below", min: "0.01", step: "0.01", inputmode: "decimal", placeholder: "49.99" });
  const belowWrap = h("div", { class: "field" }, h("label", { for: "w-below" }, "Alert at or below ($)"), below);
  const form = h("form", {
    class: "card stack",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const kind = form.querySelector("input[name=kind]:checked").value;
      const stores = [...form.querySelectorAll("input[name=wstore]:checked")].map((i) => i.value);
      const text = item.value.trim();
      if (!text) { item.focus(); return; }
      if (kind === "price_drop" && !below.value) { below.focus(); toast("Add the price to watch for", true); return; }
      try {
        await api("/api/watches", { method: "POST", body: { kind, item: text, url: /^https:\/\//.test(text) ? text : undefined, below: kind === "price_drop" ? below.value : undefined, stores: stores.length ? stores : undefined } });
        item.value = ""; below.value = "";
        toast("Watch saved");
        load();
      } catch (e) { toast(e.message, true); }
    },
  },
    h("h2", {}, "New watch"),
    h("fieldset", {}, h("legend", {}, "Alert me when"),
      h("div", { class: "checks" },
        h("label", { class: "check" }, h("input", { type: "radio", name: "kind", value: "price_drop", checked: true, onchange: () => (belowWrap.hidden = false) }), "The price drops"),
        h("label", { class: "check" }, h("input", { type: "radio", name: "kind", value: "back_in_stock", onchange: () => (belowWrap.hidden = true) }), "It is back in stock"))),
    h("div", { class: "grid2" }, h("div", { class: "field" }, h("label", { for: "w-item" }, "Item"), item), belowWrap),
    h("fieldset", {}, h("legend", {}, "Stores (none checked means all)"),
      h("div", { class: "checks" }, ALL_STORES.map((s) => h("label", { class: "check" }, h("input", { type: "checkbox", name: "wstore", value: s }), STORE_NAMES[s])))),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Save watch"),
      h("span", { class: "faint small" }, meta.alertsDemo ? "Saved on this computer. Checks start when the alerts service runs." :
        meta.canCheckWatches ? "Checks run with osa watch run, about 1 credit per store." : "Add a Browsa API key in Settings to check watches.")),
  );
  main.append(h("div", { class: "page-head" }, h("h1", {}, "Watches")), h("div", { class: "section-head first" }, h("h2", {}, "Your watches")), list, h("div", { class: "spacer-lg" }), form);
  await load();
}
