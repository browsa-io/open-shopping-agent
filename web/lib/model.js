// Compare, plan and export logic for the web app. Pure functions over RunEvents and offers, no DOM,
// so they are unit tested in Node (test/surfaces/web-model.test.ts).

import { NOT_SHOWN, formatCents, money, storeName } from "./wording.js";

export const offerKey = (o) => `${o.store}|${o.url}`;
export const shippingKnown = (o) => !!o.shipping && o.shipping.currency === o.price.currency;

/** Price x quantity plus shipping when the store showed it (same rule as the engine). */
export function totalCents(o, qty = 1) {
  return o.price.cents * Math.max(1, qty) + (shippingKnown(o) ? o.shipping.cents : 0);
}

// ---------- display text ----------

const DAY_FMT = { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" };

/** Short delivery text: "Mon, Nov 23", "Tomorrow", or the store's words trimmed. "" when none. */
export function deliveryShort(o, today) {
  if (o.deliveryDate && /^\d{4}-\d{2}-\d{2}/.test(o.deliveryDate)) {
    const d = new Date(o.deliveryDate.slice(0, 10) + "T00:00:00Z");
    if (today) {
      const t = new Date(today.slice(0, 10) + "T00:00:00Z");
      const days = Math.round((d - t) / 86_400_000);
      if (days === 0) return "Today";
      if (days === 1) return "Tomorrow";
    }
    return d.toLocaleDateString("en-US", DAY_FMT);
  }
  const t = String(o.deliveryText || "").trim();
  if (!t) return "";
  if (/\btomorrow\b/i.test(t)) return "Tomorrow";
  const cleaned = t
    .split(/\s+(?:Located in|on orders|on \$|Or Non-members|to \d{5})\b/i)[0]
    .replace(/\s*®/g, "")
    .replace(/^(shipping[,:]\s*)?(arrives|get it)\s+/i, "").replace(/^shipping[,:]\s*/i, "").trim();
  const short = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return short.length > 40 ? short.slice(0, 39) + "…" : short;
}

export function ratingShort(o) {
  return o.rating ? `${o.rating.stars.toFixed(1)}` : "";
}

export function shippingShort(o) {
  if (!shippingKnown(o)) return NOT_SHOWN;
  return o.shipping.cents === 0 ? "Free" : money(o.shipping);
}

/**
 * A short, honest reason for a pick. The engine's reason can say "delivered" for an offer whose
 * shipping was not shown; here "delivered" is only used when shipping is known.
 */
export function pickWhy(pick, offers = []) {
  const o = pick.offer;
  const reason = String(pick.reason || "");
  const n = /of (\d+) offers/.exec(reason)?.[1] ?? (offers.length || "");
  const lead = /^lowest delivered total/i.test(reason)
    ? (shippingKnown(o) ? `Lowest delivered total of ${n} offers` : `Lowest price of ${n} offers`)
    : /best mix of price and rating/i.test(reason) ? `Best mix of price and rating of ${n} offers`
    : reason.split(",")[0];
  const bits = [lead];
  if (o.rating) bits.push(`${o.rating.stars.toFixed(1)} stars from ${o.rating.count.toLocaleString("en-US")} reviews`);
  else bits.push("no reviews shown");
  if (shippingKnown(o)) bits.push(o.shipping.cents === 0 ? "free shipping" : `${money(o.shipping)} shipping`);
  return bits.join(", ");
}

// ---------- run model from events ----------

/** Items, offers per item, engine picks and request from the event stream. */
export function runModel(events) {
  let request = null;
  const offers = {};
  let picks = null;
  let total = null;
  let overBudget = false;
  for (const e of events) {
    if (e.type === "parsed") request = e.request;
    else if (e.type === "offers") (offers[e.itemId] ||= []).push(...e.offers);
    else if (e.type === "picks") { picks = e.picks; total = e.total; overBudget = e.overBudget; }
  }
  const items = request ? request.items.map((i) => ({ id: i.id, label: i.description || i.query, qty: i.quantity || 1, options: i.options, maxPrice: i.maxPrice }))
    : Object.keys(offers).map((id) => ({ id, label: id, qty: 1 }));
  return { request, items, offers, picks, total, overBudget };
}

// ---------- filter and sort ----------

export const DEFAULT_FILTERS = Object.freeze({ hideSponsored: false, condition: "any", inStockOnly: false, hiddenStores: [] });
export const SORTS = [
  ["best", "Best match"], ["total", "Total"], ["price", "Price"], ["rating", "Rating"], ["delivery", "Delivery"], ["store", "Store"],
];

export function isSponsored(o) {
  return !!o.sponsored || /^sponsored\b/i.test(o.title || "");
}

export function conditionOf(o) {
  return o.condition === "used" || o.condition === "refurbished" ? "used" : "new";
}

export function filterOffers(offers, f = DEFAULT_FILTERS) {
  const hidden = new Set(f.hiddenStores || []);
  return offers.filter((o) => {
    if (hidden.has(o.store)) return false;
    if (f.hideSponsored && isSponsored(o)) return false;
    if (f.inStockOnly && !o.inStock) return false;
    if (f.condition === "new" && conditionOf(o) !== "new") return false;
    if (f.condition === "used" && conditionOf(o) !== "used") return false;
    return true;
  });
}

/** Sort value; undefined means unknown, and unknowns always sort last. */
function sortValue(o, key) {
  switch (key) {
    case "price": return o.price.cents;
    case "total": return totalCents(o);
    case "rating": return o.rating ? o.rating.stars * 1e7 + Math.min(o.rating.count, 9_999_999) : undefined;
    case "delivery": return o.deliveryDate ? Date.parse(o.deliveryDate.slice(0, 10)) : undefined;
    case "store": return storeName(o.store, o.storeDomain).toLowerCase();
    default: return undefined;
  }
}

/**
 * Sort offers. key "best": the chosen offer, then the engine's alternatives in its order, then the
 * rest by total. Other keys sort by that value (dir 1 ascending, -1 descending), unknown values
 * last, ties by total then title so the order is stable while offers stream in.
 */
export function sortOffers(offers, sort = { key: "best", dir: 1 }, ctx = {}) {
  const key = sort.key || "best";
  const dir = sort.dir === -1 ? -1 : 1;
  const tie = (a, b) => totalCents(a) - totalCents(b) || String(a.title).localeCompare(String(b.title)) || String(a.url).localeCompare(String(b.url));
  if (key === "best") {
    const rank = new Map();
    if (ctx.chosenKey) rank.set(ctx.chosenKey, 0);
    (ctx.alternatives || []).forEach((o, i) => { if (!rank.has(offerKey(o))) rank.set(offerKey(o), i + 1); });
    return offers.slice().sort((a, b) => {
      const ra = rank.get(offerKey(a)) ?? Infinity;
      const rb = rank.get(offerKey(b)) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return Number(!!a.currencyMismatch) - Number(!!b.currencyMismatch) || Number(b.inStock) - Number(a.inStock) || tie(a, b);
    });
  }
  return offers.slice().sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === undefined && vb === undefined) return tie(a, b);
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return c * dir || tie(a, b);
  });
}

// ---------- plan: the person's choices on top of the engine picks ----------

/**
 * plan[itemId] = { offerKey?: string, quantity?: number, skip?: boolean, excludedStores?: string[] }
 * Returns what will go to the carts:
 * { items: [{ itemId, label, quantity, offer, source, excluded }], stores: [{ store, domain, lines, cents, shippingUnknown }],
 *   totalCents, currency, shippingUnknown, changed, overBudget, budgetCents }
 * source: "engine" (the agent's pick), "you" (a swap), "next" (the next best after a store was excluded).
 */
export function computePlan(model, plan = {}) {
  const out = [];
  let changed = false;
  for (const item of model.items) {
    const p = plan[item.id] || {};
    const pick = model.picks?.find((x) => x.itemId === item.id);
    const engineQty = item.qty || 1;
    const quantity = clampQty(p.quantity ?? engineQty);
    const excluded = new Set(p.excludedStores || []);
    const offers = (model.offers[item.id] || []);
    const eligible = offers.filter((o) => o.inStock && !o.subscription && !o.currencyMismatch && (o.price?.currency || "USD") === "USD" && !excluded.has(o.store));
    let offer = null;
    let source = "engine";
    if (p.skip) {
      source = "skip";
    } else if (p.offerKey && eligible.some((o) => offerKey(o) === p.offerKey)) {
      offer = eligible.find((o) => offerKey(o) === p.offerKey);
      source = pick && offerKey(pick.offer) === p.offerKey ? "engine" : "you";
    } else if (pick && !excluded.has(pick.offer.store)) {
      offer = pick.offer;
    } else if (pick || excluded.size) {
      const alts = (pick?.alternatives || []).filter((o) => !excluded.has(o.store) && o.inStock);
      offer = alts[0] || eligible.slice().sort((a, b) => totalCents(a, quantity) - totalCents(b, quantity))[0] || null;
      source = offer ? "next" : "none";
    } else {
      source = "none";
    }
    if (source === "you" || source === "next" || source === "skip" || quantity !== engineQty) changed = true;
    out.push({ itemId: item.id, label: item.label, quantity, offer, source, excluded: [...excluded], enginePick: pick?.offer || null });
  }
  const byStore = new Map();
  let cents = 0;
  let currency = "USD";
  let shippingUnknown = false;
  for (const it of out) {
    if (!it.offer) continue;
    const o = it.offer;
    currency = o.price.currency || currency;
    const k = `${o.store}|${o.storeDomain}`;
    if (!byStore.has(k)) byStore.set(k, { store: o.store, domain: o.storeDomain, lines: [], cents: 0, shippingUnknown: false });
    const s = byStore.get(k);
    const line = totalCents(o, it.quantity);
    s.lines.push({ itemId: it.itemId, title: o.title, quantity: it.quantity, unit: o.price, cents: o.price.cents * it.quantity, url: o.url });
    s.cents += line;
    if (!shippingKnown(o)) { s.shippingUnknown = true; shippingUnknown = true; }
    cents += line;
  }
  const budgetCents = model.request?.budget?.cents;
  return {
    items: out, stores: [...byStore.values()], totalCents: cents, currency, shippingUnknown, changed,
    budgetCents, overBudget: budgetCents !== undefined && cents > budgetCents,
  };
}

export function clampQty(n) {
  const q = Math.round(Number(n));
  return Number.isFinite(q) ? Math.min(99, Math.max(1, q)) : 1;
}

/** Plan choices the server applies before filling carts: [{ itemId, offerKey, quantity, skip }]. */
export function planChoices(planResult) {
  return planResult.items.map((it) => ({
    itemId: it.itemId,
    offerKey: it.offer ? offerKey(it.offer) : undefined,
    quantity: it.quantity,
    skip: !it.offer,
  }));
}

// ---------- export and share ----------

const CSV_COLUMNS = ["item", "store", "title", "price", "shipping", "total", "delivery", "rating", "reviews", "seller", "condition", "in_stock", "sponsored", "chosen", "url"];

function csvCell(v) {
  const s = v === undefined || v === null ? "" : String(v);
  // Neutralise spreadsheet formulas in store-supplied text.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const dollars = (cents) => (cents / 100).toFixed(2);

/** Every offer of every item as CSV (one header row). Money in dollars with 2 decimals. */
export function toCSV(model, planResult) {
  const chosen = new Set((planResult?.items || []).filter((i) => i.offer).map((i) => `${i.itemId}|${offerKey(i.offer)}`));
  const rows = [CSV_COLUMNS.join(",")];
  for (const item of model.items) {
    for (const o of sortOffers(model.offers[item.id] || [], { key: "total", dir: 1 })) {
      rows.push([
        item.label, storeName(o.store, o.storeDomain), o.title, dollars(o.price.cents),
        shippingKnown(o) ? dollars(o.shipping.cents) : "", dollars(totalCents(o)), o.deliveryDate || o.deliveryText || "",
        o.rating ? o.rating.stars : "", o.rating ? o.rating.count : "", o.seller || "", o.condition || "new",
        o.inStock ? "yes" : "no", isSponsored(o) ? "yes" : "no", chosen.has(`${item.id}|${offerKey(o)}`) ? "yes" : "no", o.url,
      ].map(csvCell).join(","));
    }
  }
  return rows.join("\n") + "\n";
}

/** The run as JSON: request, the plan and every offer (raw adapter extras removed). */
export function toJSON(run, model, planResult) {
  const clean = (o) => { const { raw: _raw, ...rest } = o; return rest; };
  return JSON.stringify({
    runId: run.id, prompt: run.prompt, startedAt: run.startedAt, request: model.request,
    plan: planResult ? {
      total: { cents: planResult.totalCents, currency: planResult.currency }, shippingUnknown: planResult.shippingUnknown,
      items: planResult.items.map((i) => ({ itemId: i.itemId, label: i.label, quantity: i.quantity, source: i.source, offer: i.offer ? clean(i.offer) : null })),
    } : null,
    offers: model.items.map((i) => ({ itemId: i.id, label: i.label, offers: (model.offers[i.id] || []).map(clean) })),
  }, null, 2);
}

/** A plain-text summary to paste anywhere: picks, prices, links and the run link. */
export function summaryText(run, model, planResult, link) {
  const lines = [`${run.prompt}`, ""];
  for (const it of planResult.items) {
    if (!it.offer) { lines.push(`- ${it.label}: no pick`); continue; }
    const o = it.offer;
    const price = formatCents(totalCents(o, it.quantity), o.price.currency);
    lines.push(`- ${it.quantity > 1 ? `${it.quantity} x ` : ""}${o.title}`);
    lines.push(`  ${storeName(o.store, o.storeDomain)}, ${price}${shippingKnown(o) ? (o.shipping.cents === 0 ? " with free shipping" : " with shipping") : " plus shipping"}`);
    lines.push(`  ${o.url}`);
  }
  lines.push("", `Total ${formatCents(planResult.totalCents, planResult.currency)}${planResult.shippingUnknown ? " plus shipping" : ""}, before tax.`);
  if (link) lines.push(`Run: ${link}`);
  return lines.join("\n");
}

// ---------- history ----------

/** Filter history runs by words in the prompt, store names or status. */
export function searchRuns(runs, q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return runs;
  return runs.filter((r) => {
    const hay = [r.prompt, r.status, ...(r.stores || []).map((s) => storeName(s))].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A price watch prefilled from an offer: notify a bit below today's price. */
export function watchFromOffer(o, label) {
  const below = Math.max(1, Math.floor(o.price.cents * 0.9));
  return { kind: "price_drop", item: label || o.title, url: o.url, below: { cents: below, currency: o.price.currency }, stores: [o.store] };
}
