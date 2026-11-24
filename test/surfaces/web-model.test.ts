// The web app's pure logic: sort, filter, swap and plan, exports and the share summary, plain
// status words and friendly errors. Offers are shaped like the saved real runs.

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain ES module without types (served to the browser as is)
import * as M from "../../web/lib/model.js";
// @ts-expect-error plain ES module without types
import * as W from "../../web/lib/wording.js";

const usd = (cents: number) => ({ cents, currency: "USD" });

const ebayHub = { store: "ebay", storeDomain: "ebay.com", itemId: "item-1", title: "USB C to HDMI Adapter, 4K USB C Hub", url: "https://www.ebay.com/itm/1", price: usd(399), shipping: usd(0), deliveryText: "Free 2-4 day delivery", deliveryDate: "2026-11-23", seller: "nimodeals", condition: "new", inStock: true };
const amazonHub = { store: "amazon", storeDomain: "amazon.com", itemId: "item-1", title: "BENFEI USB C Hub 5-in-1 with 4K HDMI", url: "https://www.amazon.com/dp/B1", price: usd(999), deliveryText: "FREE delivery Monday, November 23 on orders shipped by Amazon over $35", deliveryDate: "2026-11-23", rating: { stars: 4.6, count: 8188 }, condition: "new", inStock: true };
const amazonSponsored = { ...amazonHub, title: "Sponsored Ad - USB C Hub, 7 in 1", url: "https://www.amazon.com/dp/B2", price: usd(1199), rating: { stars: 4.9, count: 26 }, sponsored: true };
const walmartHub = { store: "walmart", storeDomain: "walmart.com", itemId: "item-1", title: "UGREEN 5 in 1 USB Hub", url: "https://www.walmart.com/ip/2", price: usd(1399), deliveryText: "Shipping, arrives by tomorrow", deliveryDate: "2026-11-19", rating: { stars: 4.4, count: 226 }, condition: "new", inStock: true };
const ebayUsed = { ...ebayHub, title: "Used USB-C hub", url: "https://www.ebay.com/itm/3", price: usd(299), shipping: usd(450), condition: "used" };
const ebayOut = { ...ebayHub, title: "Sold out hub", url: "https://www.ebay.com/itm/4", price: usd(199), inStock: false };
const walmartCable = { store: "walmart", storeDomain: "walmart.com", itemId: "item-2", title: "onn 6 ft HDMI Cable with Ethernet, Black", url: "https://www.walmart.com/ip/326672935", price: usd(900), deliveryDate: "2026-11-18", rating: { stars: 4.6, count: 3920 }, condition: "new", inStock: true };
const amazonCable = { store: "amazon", storeDomain: "amazon.com", itemId: "item-2", title: "Amazon Basics HDMI Cable, 6ft", url: "https://www.amazon.com/dp/C1", price: usd(584), rating: { stars: 4.7, count: 284464 }, condition: "new", inStock: true };

const hubs = [ebayHub, amazonHub, amazonSponsored, walmartHub, ebayUsed, ebayOut];

function events(budgetCents?: number) {
  return [
    { type: "parsed", request: { prompt: "usb-c hub with hdmi and a 6 ft hdmi cable under $60", stores: ["amazon", "walmart", "ebay"], budget: budgetCents ? usd(budgetCents) : undefined,
      items: [{ id: "item-1", query: "usb-c hub hdmi", description: "usb-c hub with hdmi", quantity: 1 }, { id: "item-2", query: "6 ft hdmi cable", description: "a 6 ft hdmi cable", quantity: 1 }] } },
    { type: "offers", store: "ebay", itemId: "item-1", offers: [ebayHub, ebayUsed, ebayOut] },
    { type: "offers", store: "amazon", itemId: "item-1", offers: [amazonHub, amazonSponsored] },
    { type: "offers", store: "walmart", itemId: "item-1", offers: [walmartHub] },
    { type: "offers", store: "walmart", itemId: "item-2", offers: [walmartCable] },
    { type: "offers", store: "amazon", itemId: "item-2", offers: [amazonCable] },
    { type: "picks", total: usd(399 + 584), overBudget: false, picks: [
      { itemId: "item-1", offer: ebayHub, score: 1, reason: "Lowest delivered total of 6 offers: $3.99 delivered, free shipping", alternatives: [amazonHub, walmartHub] },
      { itemId: "item-2", offer: amazonCable, score: 1, reason: "Lowest delivered total of 2 offers: $5.84 delivered, shipping not shown", alternatives: [walmartCable] },
    ] },
  ];
}

test("sort: unknown values last in both directions, stable ties", () => {
  const byRating = M.sortOffers(hubs, { key: "rating", dir: -1 });
  assert.equal(byRating[0].url, amazonSponsored.url);
  assert.ok(byRating.slice(-3).every((o: { rating?: unknown }) => !o.rating), "offers without a rating go last");
  const byRatingUp = M.sortOffers(hubs, { key: "rating", dir: 1 });
  assert.ok(byRatingUp.slice(-3).every((o: { rating?: unknown }) => !o.rating), "still last when ascending");
  assert.deepEqual(M.sortOffers(hubs, { key: "price", dir: 1 }).map((o: { price: { cents: number } }) => o.price.cents), [199, 299, 399, 999, 1199, 1399]);
  // total adds known shipping only
  assert.equal(M.sortOffers(hubs, { key: "total", dir: 1 })[1].url, ebayHub.url);
  assert.equal(M.sortOffers(hubs, { key: "delivery", dir: 1 })[0].url, walmartHub.url);
  assert.equal(M.sortOffers(hubs, { key: "store", dir: 1 })[0].store, "amazon");
});

test("sort best: chosen first, then the engine's alternatives in order", () => {
  const out = M.sortOffers(hubs, { key: "best" }, { chosenKey: M.offerKey(walmartHub), alternatives: [amazonHub, ebayHub] });
  assert.deepEqual(out.slice(0, 3).map((o: { url: string }) => o.url), [walmartHub.url, amazonHub.url, ebayHub.url]);
  assert.equal(out.at(-1).url, ebayOut.url, "out of stock last");
});

test("filter: sponsored (flag or title), condition, in stock, stores", () => {
  assert.ok(!M.filterOffers(hubs, { ...M.DEFAULT_FILTERS, hideSponsored: true }).some((o: { url: string }) => o.url === amazonSponsored.url));
  assert.ok(M.isSponsored({ title: "Sponsored Ad - HDMI Cable" }));
  assert.deepEqual(M.filterOffers(hubs, { ...M.DEFAULT_FILTERS, condition: "used" }).map((o: { url: string }) => o.url), [ebayUsed.url]);
  assert.equal(M.filterOffers(hubs, { ...M.DEFAULT_FILTERS, condition: "new" }).length, 5);
  assert.ok(!M.filterOffers(hubs, { ...M.DEFAULT_FILTERS, inStockOnly: true }).some((o: { inStock: boolean }) => !o.inStock));
  assert.ok(M.filterOffers(hubs, { ...M.DEFAULT_FILTERS, hiddenStores: ["amazon"] }).every((o: { store: string }) => o.store !== "amazon"));
});

test("plan: engine picks, totals and plus-shipping", () => {
  const model = M.runModel(events());
  const plan = M.computePlan(model, {});
  assert.equal(plan.changed, false);
  assert.equal(plan.totalCents, 399 + 584);
  assert.equal(plan.shippingUnknown, true, "the Amazon cable shows no shipping");
  assert.deepEqual(plan.stores.map((s: { store: string }) => s.store).sort(), ["amazon", "ebay"]);
});

test("plan: swap updates the total and the cart plan", () => {
  const model = M.runModel(events());
  const plan = M.computePlan(model, { "item-2": { offerKey: M.offerKey(walmartCable) } });
  assert.equal(plan.changed, true);
  assert.equal(plan.items[1].source, "you");
  assert.equal(plan.totalCents, 399 + 900);
  assert.deepEqual(plan.stores.map((s: { store: string }) => s.store).sort(), ["ebay", "walmart"]);
  assert.deepEqual(M.planChoices(plan), [
    { itemId: "item-1", offerKey: M.offerKey(ebayHub), quantity: 1, skip: false },
    { itemId: "item-2", offerKey: M.offerKey(walmartCable), quantity: 1, skip: false },
  ]);
  // an out-of-stock offer cannot be chosen: the engine pick stays
  assert.equal(M.computePlan(model, { "item-1": { offerKey: M.offerKey(ebayOut) } }).items[0].offer.url, ebayHub.url);
});

test("plan: quantity multiplies the price, not the shipping; budget check", () => {
  const model = M.runModel(events(1500));
  const plan = M.computePlan(model, { "item-1": { quantity: 3 } });
  assert.equal(plan.items[0].quantity, 3);
  assert.equal(plan.totalCents, 399 * 3 + 0 + 584);
  assert.equal(plan.overBudget, true);
  assert.equal(M.computePlan(model, { "item-1": { quantity: 500 } }).items[0].quantity, 99);
});

test("plan: excluding a store moves the item to the next best; skip removes it", () => {
  const model = M.runModel(events());
  const ex = M.computePlan(model, { "item-1": { excludedStores: ["ebay"] } });
  assert.equal(ex.items[0].offer.url, amazonHub.url, "first engine alternative not excluded");
  assert.equal(ex.items[0].source, "next");
  const both = M.computePlan(model, { "item-1": { excludedStores: ["ebay", "amazon", "walmart"] } });
  assert.equal(both.items[0].offer, null);
  const skip = M.computePlan(model, { "item-2": { skip: true } });
  assert.equal(skip.items[1].offer, null);
  assert.equal(skip.totalCents, 399);
  assert.equal(M.planChoices(skip)[1].skip, true);
});

test("CSV: header, one row per offer, quoting and formula guard", () => {
  const model = M.runModel([...events(), { type: "offers", store: "ebay", itemId: "item-2", offers: [{ ...walmartCable, store: "ebay", url: "https://www.ebay.com/itm/9", title: '=HYPERLINK("x"), "6 ft"', seller: "a,b" }] }]);
  const csv = M.toCSV(model, M.computePlan(model, {}));
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "item,store,title,price,shipping,total,unit_price,same_item,delivery,rating,reviews,seller,condition,in_stock,sponsored,chosen,url");
  assert.equal(lines.length, 1 + 6 + 3);
  assert.ok(csv.includes(`"'=HYPERLINK(""x""), ""6 ft"""`), "formula neutralised and quotes doubled");
  assert.ok(csv.includes('"a,b"'));
  const chosenRow = lines.find((l: string) => l.includes(ebayHub.url))!;
  assert.match(chosenRow, /,yes,https:\/\/www\.ebay\.com\/itm\/1$/);
  assert.match(lines.find((l: string) => l.includes(amazonCable.url))!, /,5\.84,,5\.84,/, "unknown shipping is an empty cell, never 0");
});

test("JSON export drops raw adapter extras and carries the plan", () => {
  const model = M.runModel(events());
  const plan = M.computePlan(model, { "item-2": { offerKey: M.offerKey(walmartCable) } });
  const j = JSON.parse(M.toJSON({ id: "run-1", prompt: "p", startedAt: "2026-11-18T08:00:00Z" }, model, plan));
  assert.equal(j.runId, "run-1");
  assert.equal(j.plan.total.cents, 399 + 900);
  assert.equal(j.plan.items[1].source, "you");
  assert.equal(j.offers[0].offers.length, 6);
});

test("share summary: honest shipping words and the run link", () => {
  const model = M.runModel(events());
  const text = M.summaryText({ id: "run-1", prompt: "usb-c hub" }, model, M.computePlan(model, { "item-1": { quantity: 2 } }), "http://localhost:4319/#/run/run-1/summary");
  assert.match(text, /2 x USB C to HDMI Adapter/);
  assert.match(text, /eBay, \$7\.98 with free shipping/);
  assert.match(text, /Amazon, \$5\.84 plus shipping/);
  assert.match(text, /Total \$13\.82 plus shipping, before tax\./);
  assert.match(text, /Run: http:\/\/localhost:4319\/#\/run\/run-1\/summary/);
  assert.doesNotMatch(text, /delivered/);
});

test("display: delivery short text, pick reason never says delivered without shipping", () => {
  assert.equal(M.deliveryShort(walmartHub, "2026-11-18T08:00:00Z"), "Tomorrow");
  assert.equal(M.deliveryShort(amazonHub), "Mon, Nov 23");
  assert.equal(M.deliveryShort({ deliveryText: "Free FedEx Ground Economy ® Located in: Fort Lauderdale" }), "Free FedEx Ground Economy");
  assert.equal(M.deliveryShort({}), "");
  const why = M.pickWhy({ offer: amazonCable, reason: "Lowest delivered total of 23 offers: $5.84 delivered, shipping not shown" });
  assert.match(why, /^Lowest price of 23 offers/);
  assert.match(M.pickWhy({ offer: ebayHub, reason: "Lowest delivered total of 25 offers: $3.99 delivered" }), /^Lowest delivered total of 25 offers, no reviews shown, free shipping$/);
});

test("history search and watch from an offer", () => {
  const runs = [{ prompt: "usb-c hub", status: "done", stores: ["ebay"] }, { prompt: "65W charger", status: "cancelled", stores: ["bestbuy"] }];
  assert.equal(M.searchRuns(runs, "best buy").length, 1);
  assert.equal(M.searchRuns(runs, "HUB ebay").length, 1);
  assert.equal(M.searchRuns(runs, "").length, 2);
  const w = M.watchFromOffer(amazonCable, "a 6 ft hdmi cable");
  assert.deepEqual(w, { kind: "price_drop", item: "a 6 ft hdmi cable", url: amazonCable.url, below: usd(525), stores: ["amazon"] });
});

test("wording: friendly errors from real engine messages", () => {
  const cases: [string, string, string][] = [
    ["page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.amazon.com/s?k=6+ft+hdmi+cable", "search", "Could not connect"],
    ["page.goto: Timeout 45000ms exceeded.", "search", "Too slow"],
    ["store timed out after 240s", "search", "Too slow"],
    ["this workspace is using all 6 of its browser slots (each running browser and each saved identity takes one).", "search", "No free browser"],
    ["target browser can cost up to 5 credits; this run has 0 of its 20 left (raise maxCreditsPerRun to allow it)", "search", "Run limit reached"],
    ["\"USB C to HDMI\": eBay refused the page twice (Error Page | eBay, status 403) at https://www.ebay.com/itm/297", "cart", "Blocked at the cart (403)"],
    ["eBay cart is empty", "checkout", "Cart came back empty"],
    ["page.content: Target page, context or browser has been closed", "cart", "Browser closed"],
    ["something else", "search", "Did not finish"],
  ];
  for (const [raw, stage, title] of cases) {
    const f = W.friendlyError(raw, stage, "amazon");
    assert.equal(f.title, title, raw);
    assert.doesNotMatch(f.hint, /lease|CDP|adapter|maxCredits|ERR_/i);
  }
  assert.equal(W.shortRaw("page.goto: Timeout 45000ms exceeded.\nCall log: x"), "Timeout 45000ms exceeded.");
});

test("wording: plain status words per store", () => {
  const ev = events();
  const red = W.reduceStores([...ev, { type: "store_failed", store: "walmart", stage: "search", error: "store timed out after 240s" }]);
  const ctx = { running: true, picked: true, gates: new Set(), answered: new Set() };
  assert.equal(W.storeStatus(red.stores.get("ebay"), ctx).word, "Found 3 offers");
  assert.equal(W.storeStatus(red.stores.get("walmart"), ctx).word, "Too slow");
  const early = W.reduceStores(ev.slice(0, 2));
  assert.equal(W.storeStatus(early.stores.get("ebay"), { ...ctx, picked: false }).word, "Reading prices");
  assert.equal(W.storeStatus(early.stores.get("amazon"), { ...ctx, picked: false }).word, "Starting");
  assert.equal(W.storeStatus(early.stores.get("amazon"), { ...ctx, picked: false, answered: new Set() }).tone, "busy");
  const filling = W.storeStatus(red.stores.get("ebay"), { ...ctx, answered: new Set(["cart:ebay"]) });
  assert.equal(filling.word, "Filling cart");
  const needs = W.reduceStores([...ev, { type: "needs_user", store: "walmart", needs: { reason: "sign_in", message: "Walmart asks you to sign in" } }]);
  assert.equal(W.storeStatus(needs.stores.get("walmart"), ctx).word, "Needs you");
  assert.equal(W.money(undefined), "not shown");
});

test("wording: a store that is starting does not name Phantom (it may be your own Chrome)", () => {
  const s = W.storeStatus({ store: "walmart", offers: 0, started: false, failures: [] }, { running: true, picked: false });
  assert.equal(s.word, "Starting");
  assert.doesNotMatch(s.detail, /Phantom/);
});

// ---------- same item and unit price (added in v1 discovery) ----------

const HUB_GTIN = "00042100005264";
const hubA = { ...amazonHub, url: "https://www.amazon.com/dp/H1", ids: { gtin: HUB_GTIN, brand: "northbay", mpn: "NBH7100" } };
const hubW = { ...walmartHub, url: "https://www.walmart.com/ip/H2", ids: { gtin: HUB_GTIN } };
const hubE = { ...ebayHub, url: "https://www.ebay.com/itm/H3", ids: { brand: "northbay", mpn: "NBH7100" } };
const hubSilver = { ...walmartHub, url: "https://www.walmart.com/ip/H4", ids: { gtin: "00042100005332", brand: "northbay", mpn: "NBH7100" } };

test("same item: exact by GTIN or brand + MPN, relative to the chosen offer; never dropped by default", () => {
  assert.deepEqual(M.sameItemAs(hubA, hubW), { match: "exact", by: "gtin" });
  assert.deepEqual(M.sameItemAs(hubA, hubE), { match: "exact", by: "brand_mpn" });
  assert.deepEqual(M.sameItemAs(hubA, hubSilver), { match: "similar" }, "another GTIN is another item");
  assert.deepEqual(M.sameItemAs(hubA, ebayHub), { match: "similar" }, "no ids: not proven the same");
  assert.equal(M.sameItemAs(hubA, hubA), null);
  assert.equal(M.sameItemAs(null, hubW), null);
  assert.match(M.matchTitle({ match: "exact", by: "gtin" }), /GTIN/);
  const all = [hubA, hubW, hubE, hubSilver, ebayHub];
  assert.equal(M.filterOffers(all, M.DEFAULT_FILTERS, hubA).length, 5, "similar offers stay unless the person filters");
  assert.deepEqual(M.filterOffers(all, { ...M.DEFAULT_FILTERS, sameOnly: true }, hubA).map((o: { url: string }) => o.url), [hubA.url, hubW.url, hubE.url]);
  assert.equal(M.filterOffers(all, { ...M.DEFAULT_FILTERS, sameOnly: true }, null).length, 5, "nothing chosen yet: the filter does nothing");
});

test("unit price: a sort the person picks, in the unit most offers share, unknown last", () => {
  const per = (o: object, cents: number, unit = "count") => ({ ...o, perUnit: { cents, currency: "USD", per: unit, text: `$${(cents / 100).toFixed(2)} / ${unit}`, source: "title" } });
  const a = per({ ...amazonCable, url: "https://a/1" }, 42);
  const b = { ...walmartCable, url: "https://w/1", contents: { count: 48, source: "title", text: "48 count" } }; // 900 / 48 = 18.75
  const c = per({ ...amazonCable, url: "https://a/2", price: usd(200) }, 200);
  const d = { ...walmartCable, url: "https://w/2" }; // unknown
  assert.equal(M.commonPer([a, b, c, d]), "count");
  assert.equal(M.unitCents(b, "count"), 18.75);
  assert.deepEqual(M.sortOffers([d, c, a, b], { key: "unit", dir: 1 }).map((o: { url: string }) => o.url), ["https://w/1", "https://a/1", "https://a/2", "https://w/2"]);
  assert.ok(M.SORTS.some(([k]: [string]) => k === "unit"));
  assert.equal(M.sortOffers([d, c, a, b])[0].url, "https://a/2", "the default sort (best match) stays on the total, not the unit price");
  assert.match(M.pickWhy({ offer: a, reason: "Lowest delivered total of 3 offers: $5.84" }), /\$0\.42 \/ count/);
});

test("CSV: unit price and same-item columns relative to the chosen offer", () => {
  const model = M.runModel([
    { type: "parsed", request: { prompt: "hub", stores: ["amazon", "walmart"], items: [{ id: "item-1", query: "hub", description: "hub", quantity: 1 }] } },
    { type: "offers", store: "amazon", itemId: "item-1", offers: [{ ...hubA, perUnit: { cents: 2500, currency: "USD", per: "count", text: "$25.00 / count", source: "title" } }] },
    { type: "offers", store: "walmart", itemId: "item-1", offers: [hubW, hubSilver] },
  ]);
  const plan = M.computePlan(model, { "item-1": { offerKey: M.offerKey(hubA) } });
  const lines = M.toCSV(model, plan).trim().split("\n");
  assert.match(lines.find((l: string) => l.includes(hubA.url))!, /,\$25\.00 \/ count,,/, "the chosen offer has no same-item label");
  assert.match(lines.find((l: string) => l.includes(hubW.url))!, /,,exact,/);
  assert.match(lines.find((l: string) => l.includes(hubSilver.url))!, /,,similar,/);
});

test("hub: the last order state is per Shopify shop, per store elsewhere", async () => {
  const { lastOrderState } = await import("../../src/web/session.js");
  const at = "2026-11-19T10:00:00.000Z";
  const ev = [
    { type: "order_state", store: "shopify", domain: "a.example", state: "placed", at },
    { type: "order", result: { store: "shopify", placed: true, state: "placed", orderId: "1001" } },
    { type: "order_state", store: "amazon", state: "unknown", at },
  ] as never[];
  assert.equal(lastOrderState(ev, "shopify", "a.example"), "placed");
  assert.equal(lastOrderState(ev, "shopify", "b.example"), undefined, "another shop is not blocked");
  assert.equal(lastOrderState(ev, "amazon"), "unknown");
});

test("wording: order states per store (placing, placed, not placed, check the store)", () => {
  const at = "2026-11-19T10:00:00.000Z";
  const base = [
    { type: "parsed", request: { prompt: "x", items: [], stores: ["amazon"] } },
    { type: "order_state", store: "amazon", state: "awaiting_approval", at },
    { type: "order_state", store: "amazon", state: "placing", at },
  ];
  const placing = W.reduceStores(base).stores.get("amazon");
  assert.equal(W.orderStateOf(placing, true), "placing");
  assert.equal(W.storeStatus(placing, { running: true, picked: true }).word, "Placing order");
  // A saved run that stopped while placing: check the store.
  assert.equal(W.orderStateOf(placing, false), "unknown");
  const stopped = W.storeStatus(placing, { running: false, picked: true });
  assert.equal(stopped.word, "Check the store");
  assert.match(stopped.detail, /stopped while placing.*Check your orders on Amazon/);

  const unknown = W.reduceStores([...base, { type: "order_state", store: "amazon", state: "unknown", at },
    { type: "order", result: { store: "amazon", placed: false, state: "unknown", checkMessage: "Amazon may have taken this order. Check your orders on Amazon (https://www.amazon.com/gp/css/order-history) before you try again.", ordersUrl: "https://www.amazon.com/gp/css/order-history" } }]).stores.get("amazon");
  assert.equal(W.orderStateOf(unknown, false), "unknown");
  const u = W.storeStatus(unknown, { running: false, picked: true });
  assert.equal(u.word, "Check the store");
  assert.equal(u.tone, "warn");
  assert.match(u.detail, /Check your orders on Amazon before you try again/);

  const placed = W.reduceStores([...base, { type: "order", result: { store: "amazon", placed: true, state: "placed", orderId: "111-2222222-3333333" } }]).stores.get("amazon");
  assert.equal(W.orderStateOf(placed, false), "placed");
  assert.equal(W.storeStatus(placed, { running: false, picked: true }).detail, "Order 111-2222222-3333333");
  const failed = W.reduceStores([...base, { type: "order", result: { store: "amazon", placed: false, state: "failed", error: "Amazon total is now $33.00" } }]).stores.get("amazon");
  assert.equal(W.orderStateOf(failed, false), "failed");
  assert.equal(W.storeStatus(failed, { running: false, picked: true }).word, "Not ordered");
});

test("best match lists offers left out as not the item (cases, other models) after the item's own", () => {
  const o = (title: string, cents: number) => ({ store: "target", storeDomain: "target.com", title, url: `https://t/${cents}`, price: { cents, currency: "USD" }, inStock: true });
  const pick = o("Apple AirPods Pro 3", 14999), alt = o("AirPods Pro 3 Open Box", 16900), item2 = o("AirPods Pro 3rd Gen", 24900);
  const case1 = o("AirPods Pro 3 Case", 1000), earpods = o("Apple EarPods", 1999);
  const rows = M.sortOffers([case1, item2, earpods, alt, pick], { key: "best", dir: 1 }, {
    chosenKey: M.offerKey(pick), alternatives: [alt], notTheItem: [M.offerKey(case1), M.offerKey(earpods)],
  });
  assert.deepEqual(rows.map((r: { price: { cents: number } }) => r.price.cents), [14999, 16900, 24900, 1000, 1999]);
});

test("one Shopify card for several shops: no single shop's name, the shops listed", () => {
  const off = (d: string) => ({ store: "shopify", storeDomain: d, title: "x", url: `https://${d}/p`, price: { cents: 100, currency: "USD" }, inStock: true });
  const one = W.reduceStores([{ type: "offers", store: "shopify", itemId: "i", offers: [off("a.com")] }]).stores.get("shopify");
  assert.equal(one.domain, "a.com");
  const two = W.reduceStores([
    { type: "offers", store: "shopify", itemId: "i", offers: [off("a.com")] },
    { type: "offers", store: "shopify", itemId: "i", offers: [off("b.com")] },
    { type: "store_started", store: "shopify", domain: "b.com" },
  ]).stores.get("shopify");
  assert.equal(two.domain, "");
  assert.deepEqual(two.shops, ["a.com", "b.com"]);
});
