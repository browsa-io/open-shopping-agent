// Compare: one section per item with your pick on top, a sortable and filterable offer table
// (cards on a phone), swap in one click, quantity, and per-item store include/exclude.

import { h, icon, mount } from "../lib/dom.js";
import { NOT_SHOWN, formatCents, money, storeName } from "../lib/wording.js";
import {
  SORTS, conditionOf, deliveryShort, filterOffers, isSponsored, offerKey, pickWhy, shippingKnown, shippingShort, sortOffers, totalCents,
} from "../lib/model.js";

const PAGE = { wide: 8, narrow: 4 };

export function thumb(o, size = "sm") {
  const px = size === "lg" ? 64 : 44;
  // A failed image leaves an empty, dark tile (never a white box).
  return h("span", { class: `thumb ${size}` }, o.image ? h("img", {
    src: o.image, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", width: px, height: px,
    onerror: (e) => e.currentTarget.remove(),
  }) : null);
}

function tags(o, chosen) {
  const t = [];
  if (chosen) t.push(h("span", { class: "badge green" }, icon("check"), "Your pick"));
  if (isSponsored(o)) t.push(h("span", { class: "badge" }, "Sponsored"));
  if (conditionOf(o) === "used") t.push(h("span", { class: "badge amber" }, o.condition === "refurbished" ? "Refurbished" : "Used"));
  if (!o.inStock) t.push(h("span", { class: "badge red" }, "Out of stock"));
  return t.length ? h("div", { class: "tags" }, t) : null;
}

const cleanTitle = (t) => String(t || "").replace(/^Sponsored Ad\s*-\s*/i, "");

function priceCell(o) {
  return [h("span", { class: "amt" }, money(o.price)), o.listPrice && o.listPrice.cents > o.price.cents ? h("s", { class: "was" }, money(o.listPrice)) : null];
}

function totalCell(o, qty) {
  const c = formatCents(totalCents(o, qty), o.price.currency);
  return shippingKnown(o) ? h("span", { class: "amt strong" }, c) : [h("span", { class: "amt strong" }, c), h("span", { class: "sub" }, "plus shipping")];
}

function ratingCell(o) {
  if (!o.rating) return h("span", { class: "none", title: "No rating shown" }, "–");
  return h("span", { class: "stars", title: `${o.rating.stars.toFixed(1)} stars from ${o.rating.count.toLocaleString("en-US")} reviews` },
    h("span", { class: "star", "aria-hidden": "true" }, "★"), o.rating.stars.toFixed(1), " ", h("small", {}, `(${o.rating.count.toLocaleString("en-US")})`));
}

function deliveryCell(o, today) {
  const s = deliveryShort(o, today);
  return s ? h("span", { title: o.deliveryText || s }, s) : h("span", { class: "none", title: "Delivery not shown" }, "–");
}

/** The toolbar above the items: sort, filters and store visibility. */
function toolbar(ctx) {
  const { view, actions } = ctx;
  const f = view.filters;
  const sortSel = h("select", { id: "cmp-sort", "aria-label": "Sort offers", onchange: (e) => actions.setSort(e.target.value) },
    SORTS.map(([k, label]) => h("option", { value: k, selected: view.sort.key === k }, `Sort: ${label}`)));
  const cond = h("select", { id: "cmp-cond", "aria-label": "Condition", onchange: (e) => actions.setFilter({ condition: e.target.value }) },
    [["any", "Any condition"], ["new", "New only"], ["used", "Used or refurbished"]].map(([v, l]) => h("option", { value: v, selected: f.condition === v }, l)));
  const toggle = (key, label) => h("button", {
    type: "button", class: "chip toggle", "aria-pressed": f[key] ? "true" : "false", "data-key": `f-${key}`,
    onclick: () => actions.setFilter({ [key]: !f[key] }),
  }, f[key] ? icon("check") : null, label);
  const active = (f.hideSponsored ? 1 : 0) + (f.inStockOnly ? 1 : 0) + (f.condition !== "any" ? 1 : 0);
  return h("div", { class: "toolbar", role: "group", "aria-label": "Sort and filter" },
    h("div", { class: "tb-row" },
      h("div", { class: "sel" }, sortSel),
      view.sort.key !== "best" ? h("button", {
        type: "button", class: "btn sm ghost icon-only", "data-key": "sort-dir", "aria-label": view.sort.dir === 1 ? "Ascending, switch to descending" : "Descending, switch to ascending",
        onclick: () => actions.setSort(view.sort.key, -view.sort.dir),
      }, icon(view.sort.dir === 1 ? "up" : "down")) : null,
      h("div", { class: "sel" }, cond),
      toggle("hideSponsored", "Hide sponsored"),
      toggle("inStockOnly", "In stock only"),
      active ? h("button", { type: "button", class: "btn sm ghost", "data-key": "f-clear", onclick: () => actions.clearFilters() }, "Clear filters") : null));
}

function qtyStepper(item, qty, ctx) {
  const set = (q) => ctx.actions.setQty(item.id, q);
  const dis = ctx.locked;
  return h("div", { class: "qty", role: "group", "aria-label": `Quantity for ${item.label}` },
    h("button", { type: "button", class: "qbtn", "aria-label": "One less", disabled: dis || qty <= 1, "data-key": `qm-${item.id}`, onclick: () => set(qty - 1) }, icon("minus")),
    h("input", {
      type: "number", min: 1, max: 99, inputmode: "numeric", value: String(qty), "aria-label": "Quantity", disabled: dis, "data-key": `qi-${item.id}`,
      onchange: (e) => set(e.target.value),
    }),
    h("button", { type: "button", class: "qbtn", "aria-label": "One more", disabled: dis || qty >= 99, "data-key": `qp-${item.id}`, onclick: () => set(qty + 1) }, icon("plus")));
}

function storeChips(item, offers, planItem, ctx) {
  const stores = [...new Set(offers.map((o) => o.store))];
  if (stores.length < 2 && !planItem.excluded.length) return null;
  const ex = new Set(planItem.excluded);
  return h("div", { class: "item-stores", role: "group", "aria-label": `Stores for ${item.label}` },
    h("span", { class: "tb-label" }, "Buy from"),
    stores.map((s) => h("button", {
      type: "button", class: "chip toggle sm", "aria-pressed": ex.has(s) ? "false" : "true", disabled: ctx.locked, "data-key": `ex-${item.id}-${s}`,
      title: ex.has(s) ? `Include ${storeName(s)} for this item` : `Exclude ${storeName(s)} for this item`,
      onclick: () => ctx.actions.toggleItemStore(item.id, s),
    }, ex.has(s) ? null : icon("check"), storeName(s))));
}

const SOURCE = { engine: ["green", "Best pick"], you: ["blue", "Your choice"], next: ["amber", "Next best"] };

function pickPanel(item, planItem, ctx, offers) {
  const o = planItem.offer;
  const running = ctx.run.status === "running";
  if (!o) {
    if (planItem.source === "skip") return h("div", { class: "pick empty" }, h("span", { class: "muted" }, "Skipped. Choose an offer below to buy it."));
    if (!offers.length) {
      return h("div", { class: "pick empty" }, running && !ctx.model.picks
        ? [h("span", { class: "dot pulse", "aria-hidden": "true" }), h("span", { class: "muted" }, "Looking for offers")]
        : h("span", { class: "muted" }, ctx.run.status === "failed" || ctx.run.status === "cancelled"
          ? "No offers. The search ended before the stores finished."
          : "Nothing found for this item. Try simpler words, or another store."));
    }
    return h("div", { class: "pick empty" }, running && !ctx.model.picks
      ? [h("span", { class: "dot pulse", "aria-hidden": "true" }), h("span", { class: "muted" }, `Comparing ${offers.length} offers as they arrive`)]
      : h("span", { class: "muted" }, planItem.excluded.length ? "No offer left from the stores you kept. Include a store again." : "No offer fits the request. Choose one below if one works for you."));
  }
  const pick = ctx.model.picks?.find((p) => p.itemId === item.id);
  // After "Fill carts" with a swap, the engine's pick is the person's choice ("Your choice").
  const source = planItem.source === "engine" && pick?.reason === "Your choice" ? "you" : planItem.source;
  const [tone, label] = SOURCE[source] || SOURCE.engine;
  const why = source === "engine" && pick ? pickWhy(pick, offers) : source === "next" ? "Next best after the stores you excluded" : "You chose this offer";
  const priceBlock = (cls) => h("div", { class: `pick-price ${cls}` },
    h("div", { class: "big" }, formatCents(totalCents(o, planItem.quantity), o.price.currency)),
    h("div", { class: "sub" }, [planItem.quantity > 1 ? `${planItem.quantity} x ${money(o.price)}` : null,
      shippingKnown(o) ? (o.shipping.cents === 0 ? "free shipping" : `incl. ${money(o.shipping)} shipping`) : "plus shipping"].filter(Boolean).join(", ")));
  return h("div", { class: "pick" },
    thumb(o, "lg"),
    h("div", { class: "pick-main" },
      h("div", { class: "pick-top" }, h("span", { class: `badge ${tone}` }, label), h("span", { class: "pick-store" }, storeName(o.store, o.storeDomain))),
      h("a", { class: "pick-title clamp2", href: o.url, target: "_blank", rel: "noopener noreferrer", title: cleanTitle(o.title) }, cleanTitle(o.title)),
      priceBlock("inline"),
      h("p", { class: "why", title: pick?.reason || "" }, why),
      h("div", { class: "pick-actions" },
        h("a", { class: "btn sm ghost", href: o.url, target: "_blank", rel: "noopener noreferrer" }, icon("ext"), `Open at ${storeName(o.store, o.storeDomain)}`),
        h("button", { type: "button", class: "btn sm ghost", "data-key": `watch-pick-${item.id}`, onclick: () => ctx.actions.watch(o, item.label) }, icon("bell"), "Watch this price"))),
    priceBlock("side"));
}

function headerCell(label, key, ctx, cls = "") {
  const { view, actions } = ctx;
  const on = view.sort.key === key;
  const sortAttr = on ? (view.sort.dir === 1 ? "ascending" : "descending") : "none";
  return h("th", { scope: "col", class: cls, "aria-sort": key ? sortAttr : null },
    key ? h("button", {
      type: "button", class: `th-sort${on ? " on" : ""}`,
      onclick: () => actions.setSort(key, on ? -view.sort.dir : key === "rating" ? -1 : 1),
    }, label, on ? icon(view.sort.dir === 1 ? "up" : "down") : null) : label);
}

function offerRow(item, o, planItem, ctx) {
  const k = offerKey(o);
  const chosen = planItem.offer && offerKey(planItem.offer) === k;
  const canChoose = !ctx.locked && o.inStock && !o.subscription && !chosen;
  const rowKey = `row-${item.id}-${k}`;
  return h("tr", {
    class: [chosen ? "chosen" : "", o.inStock ? "" : "out"].join(" ").trim() || null,
    tabindex: "-1", "data-row": "1", "data-key": rowKey, "data-item": item.id, "data-offer": k,
    "aria-selected": chosen ? "true" : "false",
  },
    h("td", { class: "c-prod" },
      h("div", { class: "prod" }, thumb(o),
        h("div", { class: "prod-text" },
          h("a", { href: o.url, target: "_blank", rel: "noopener noreferrer", class: "clamp2", title: cleanTitle(o.title) }, cleanTitle(o.title)),
          h("div", { class: "seller" }, o.seller ? o.seller : ""),
          tags(o, chosen)))),
    h("td", { class: "c-store" }, storeName(o.store, o.storeDomain)),
    h("td", { class: "c-price num" }, priceCell(o)),
    h("td", { class: "c-ship num" }, shippingKnown(o) ? shippingShort(o) : h("span", { class: "none" }, NOT_SHOWN)),
    h("td", { class: "c-total num" }, totalCell(o, 1)),
    h("td", { class: "c-del" }, deliveryCell(o, ctx.today)),
    h("td", { class: "c-rate" }, ratingCell(o)),
    h("td", { class: "c-act" },
      chosen ? h("span", { class: "chosen-mark" }, icon("check"), "Chosen")
        : ctx.locked ? null : h("button", {
          type: "button", class: "btn sm", disabled: !canChoose, "data-key": `choose-${item.id}-${k}`,
          "aria-label": `Choose ${cleanTitle(o.title).slice(0, 60)} at ${storeName(o.store, o.storeDomain)}`,
          onclick: () => ctx.actions.choose(item.id, k),
        }, "Choose"),
      h("button", {
        type: "button", class: "btn sm ghost icon-only", "data-key": `watch-${item.id}-${k}`,
        "aria-label": `Watch the price of ${cleanTitle(o.title).slice(0, 60)}`, title: "Watch this price",
        onclick: () => ctx.actions.watch(o, item.label),
      }, icon("bell"))));
}

function itemSection(item, planItem, ctx) {
  const { model, view, ui } = ctx;
  const all = model.offers[item.id] || [];
  const excluded = new Set(planItem.excluded);
  const visible = filterOffers(all, view.filters).filter((o) => !excluded.has(o.store));
  const pick = model.picks?.find((p) => p.itemId === item.id);
  const rows = sortOffers(visible, view.sort, { chosenKey: planItem.offer ? offerKey(planItem.offer) : undefined, alternatives: pick?.alternatives });
  const open = ui.expanded.has(item.id);
  const limit = ctx.narrow ? PAGE.narrow : PAGE.wide;
  const shown = open ? rows : rows.slice(0, limit);
  const hiddenCount = all.length - visible.length;
  const running = ctx.run.status === "running" && !model.picks;
  return h("section", { class: "card pad0 item", "aria-labelledby": `h-${item.id}` },
    h("div", { class: "item-head" },
      h("div", { class: "item-title" },
        h("h3", { id: `h-${item.id}` }, item.label),
        h("span", { class: "count" }, all.length ? `${all.length} offer${all.length === 1 ? "" : "s"}${hiddenCount ? `, ${hiddenCount} hidden` : ""}` : running ? "Searching" : "No offers")),
      h("div", { class: "item-ctl" }, qtyStepper(item, planItem.quantity, ctx))),
    storeChips(item, all, planItem, ctx),
    pickPanel(item, planItem, ctx, all),
    rows.length ? h("div", { class: "tablewrap" }, h("table", { class: "cmp" },
      h("caption", { class: "sr" }, `Offers for ${item.label}`),
      h("thead", {}, h("tr", {},
        headerCell("Product", null, ctx, "c-prod"), headerCell("Store", "store", ctx), headerCell("Price", "price", ctx, "num"),
        headerCell("Shipping", null, ctx, "num"), headerCell("Total", "total", ctx, "num"), headerCell("Delivery", "delivery", ctx),
        headerCell("Rating", "rating", ctx), h("th", { scope: "col", class: "c-act" }, h("span", { class: "sr" }, "Actions")))),
      h("tbody", {}, shown.map((o) => offerRow(item, o, planItem, ctx))))) :
      all.length ? h("div", { class: "empty small" }, "No offer matches the filters. ", h("button", { type: "button", class: "linkish", onclick: () => ctx.actions.clearFilters() }, "Clear filters")) :
      running ? h("div", { class: "skeleton-rows", "aria-hidden": "true" }, [0, 1, 2].map(() => h("div", { class: "sk-row" }, h("span", { class: "sk sk-img" }), h("span", { class: "sk sk-line" }), h("span", { class: "sk sk-num" })))) : null,
    rows.length > limit ? h("div", { class: "more" }, h("button", {
      type: "button", class: "btn sm ghost", "data-key": `more-${item.id}`, "aria-expanded": open ? "true" : "false",
      onclick: () => ctx.actions.toggleExpanded(item.id),
    }, open ? "Show fewer" : `Show all ${rows.length}`)) : null);
}

export function renderCompare(el, ctx) {
  const { model, plan, view, ui, run } = ctx;
  const offerCount = Object.values(model.offers).reduce((n, l) => n + l.length, 0);
  const sig = JSON.stringify([
    model.items.map((i) => [i.id, i.label, (model.offers[i.id] || []).length]), !!model.picks, model.picks?.map((p) => offerKey(p.offer)),
    plan.items.map((i) => [i.offer ? offerKey(i.offer) : null, i.quantity, i.source, i.excluded]), view, [...ui.expanded], ctx.locked, ctx.narrow, run.status === "running",
  ]);
  mount(el, sig, () => {
    if (!model.items.length) return null;
    return [
      h("div", { class: "section-head" }, h("h2", {}, "Compare"),
        h("span", { class: "count" }, `${model.items.length} item${model.items.length === 1 ? "" : "s"}, ${offerCount} offer${offerCount === 1 ? "" : "s"}`)),
      offerCount ? toolbar(ctx) : null,
      model.items.map((item) => itemSection(item, plan.items.find((p) => p.itemId === item.id), ctx)),
    ];
  });
}
