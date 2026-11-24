// Accessories never win for a named product. Live run 2026-11-24 ("AirPods Pro 3", Amazon, Walmart,
// Best Buy, Target): the pick was "ESR for AirPods Pro 3 Case" at $13.59 and the cart got the case.
// Second live run (09:51 UTC, with that fix): Target's heyday "AirPods Pro (1/2 Generation) Silicone
// Airpods Case with Clip" at $10.00, a case with no "for" and for another model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessoryOf, asksForAccessory, hasModel, modelTokens, pickAll, pickForItem, scoreOffers, titleMatch } from "../../src/core/rank.js";
import { ShoppingAgent } from "../../src/core/engine.js";
import type { ItemRequest, RunEvent, ShoppingRequest } from "../../src/core/types.js";
import { FakeAdapter, fakeBrowsers, offer, usd } from "./fake-adapter.js";
import * as M from "../../web/lib/model.js";

const NOW = new Date("2026-11-24T09:35:00Z");
const item = (query: string, extra: Partial<ItemRequest> = {}): ItemRequest => ({ id: "item-1", query, description: query, quantity: 1, ...extra });

// Titles from the live run.
const ESR = "ESR for AirPods Pro 3 Case (2025), Magnetic Lid";
const WALMART = "Apple AirPods Pro 3";
const BESTBUY = "Apple - AirPods Pro 3, Wireless Active Noise Cancelling Earbuds with Heart Rate Sensing, Hearing Aid Feature, USB-C Charging - White";

const airpods = () => [
  offer("amazon", ESR, 13.59, { rating: { stars: 4.6, count: 2100 } }),
  offer("amazon", "Silicone Case Cover Compatible with AirPods Pro 3 (2025), Shockproof with Keychain", 7.99, { rating: { stars: 4.4, count: 310 } }),
  offer("target", "Replacement Ear Tips for AirPods Pro 3, 4 Pairs", 9.99),
  offer("amazon", "AirPods Pro 3 Case Cover, Clear Soft TPU", 6.49),
  offer("walmart", WALMART, 149, { rating: { stars: 4.7, count: 1450 } }),
  offer("bestbuy", BESTBUY, 149.99, { rating: { stars: 4.7, count: 1450 } }),
];

test("accessoryOf: the live run's case is an accessory; the AirPods are not", () => {
  const q = "AirPods Pro 3";
  assert.equal(accessoryOf(q, ESR), true);
  assert.equal(accessoryOf(q, "Silicone Case Cover Compatible with AirPods Pro 3 (2025)"), true);
  assert.equal(accessoryOf(q, "Replacement Ear Tips for AirPods Pro 3, 4 Pairs"), true);
  assert.equal(accessoryOf(q, "AirPods Pro 3 Case Cover, Clear Soft TPU"), true);
  assert.equal(accessoryOf(q, "AirPods Pro 3 Silicone Case with Lanyard"), true);
  assert.equal(accessoryOf("apple airpods pro 3", "AirPods Pro 3 Case"), true, "brand left out of the title");
  assert.equal(accessoryOf(q, WALMART), false);
  assert.equal(accessoryOf(q, BESTBUY), false);
  assert.equal(accessoryOf(q, "Apple AirPods Pro 3 Wireless Earbuds, Active Noise Cancellation, with MagSafe Charging Case (USB-C)"), false);
  assert.equal(accessoryOf(q, "Apple AirPods Pro 3 Earbuds, Hearing Aid Feature for Mild to Moderate Hearing Loss"), false);
});

test("accessoryOf: other product and accessory pairs", () => {
  const pairs: [string, string, boolean][] = [
    ["iPhone 17 Pro", "Spigen Ultra Hybrid Designed for iPhone 17 Pro Case (2025) - Crystal Clear", true],
    ["iPhone 17 Pro", "Apple iPhone 17 Pro 256GB Cosmic Orange (Unlocked)", false],
    ["iPhone 17 Pro", "iPhone 17 Pro Case with MagSafe, Military Grade Drop Protection", true],
    ["iPhone 17 Pro", "Tempered Glass Screen Protector for iPhone 17 Pro, 3 Pack", true],
    ["Apple Watch Series 11", "Sport Band Compatible with Apple Watch Series 11 46mm", true],
    ["Apple Watch Series 11", "Apple Watch Series 11 Band, Nylon Sport Loop", true],
    ["Apple Watch Series 11", "Apple Watch Series 11 [GPS 46mm] Smartwatch with Jet Black Aluminum Case with Black Sport Band", false],
    ["Nintendo Switch 2", "Carrying Case for Nintendo Switch 2, Hard Shell Travel Case", true],
    ["Nintendo Switch 2", "Nintendo Switch 2 + Mario Kart World Bundle", false],
    ["Kindle Paperwhite", "Kindle Paperwhite Cover, Water-Safe Fabric", true],
    ["Kindle Paperwhite", "Amazon Kindle Paperwhite 16GB, 7\" Glare-Free Display, Black", false],
    ["Sony WH-1000XM6", "Replacement Ear Pads Cushions for Sony WH-1000XM6 Headphones", true],
    ["Sony WH-1000XM6", "Sony WH-1000XM6 Wireless Noise Canceling Headphones, Black", false],
    ["MacBook Air M4", "Apple 2025 MacBook Air 13-inch Laptop with M4 chip, Works with iPhone and iPad", false],
    ["MacBook Air M4", "Laptop Sleeve for MacBook Air M4 13 inch", true],
  ];
  for (const [q, t, want] of pairs) assert.equal(accessoryOf(q, t), want, `${q} / ${t}`);
});

test("a query that asks for an accessory leaves nothing out", () => {
  for (const q of ["airpods pro 3 case", "case for airpods pro 3", "usb-c hub hdmi", "6 ft hdmi cable", "65w usb c charger", "iphone 17 pro screen protector"]) {
    assert.equal(asksForAccessory(q), true, q);
    assert.equal(accessoryOf(q, ESR), false, q);
  }
  assert.equal(asksForAccessory("AirPods Pro 3"), false);
  const p = pickForItem(item("airpods pro 3 case"), airpods(), { now: NOW })!;
  assert.equal(p.offer.title, "AirPods Pro 3 Case Cover, Clear Soft TPU", "the cheapest case when a case is asked for");
});

test("best pick for \"AirPods Pro 3\" is the AirPods, not the $13.59 case", () => {
  const p = pickForItem(item("AirPods Pro 3"), airpods(), { now: NOW })!;
  assert.equal(p.offer.title, WALMART);
  assert.match(p.reason, /of the 2 offers compared/);
  assert.match(p.reason, /6 found, 4 left out: 4 accessories \(not the item itself\)/);
  assert.deepEqual(p.alternatives.map((o) => o.title), [BESTBUY]);
  assert.equal(p.notTheItem?.length, 4);
  for (const goal of ["cheapest", "top_rated", "fastest"] as const) {
    const g = pickForItem(item("AirPods Pro 3"), airpods(), { now: NOW, goal })!;
    assert.ok([WALMART, BESTBUY].includes(g.offer.title), `${goal}: ${g.offer.title}`);
  }
  const scored = scoreOffers(item("AirPods Pro 3"), airpods(), { now: NOW });
  assert.equal(scored.filter((s) => s.excluded === "accessory, not the item itself").length, 4);
});

test("only accessories found: nothing is left out (the pick is the best of what there is)", () => {
  const onlyCases = airpods().filter((o) => o.store === "amazon");
  const p = pickForItem(item("AirPods Pro 3"), onlyCases, { now: NOW })!;
  assert.ok(p);
  assert.equal(p.notTheItem, undefined);
  assert.doesNotMatch(p.reason, /left out/);
});

test("generic queries rank as before", () => {
  const hubs = [
    offer("amazon", "Anker USB C Hub, 7-in-1 Adapter with 4K HDMI, 100W PD, for MacBook Pro, USB C laptops", 29.99, { rating: { stars: 4.5, count: 9000 } }),
    offer("walmart", "USB C Hub for MacBook Pro Air, 7 in 1 USB C Adapter with HDMI", 18.99, { rating: { stars: 4.3, count: 800 } }),
    offer("bestbuy", "Insignia USB-C to HDMI Adapter", 24.99),
  ];
  const p = pickForItem(item("usb-c hub hdmi", { maxPrice: usd(40) }), hubs, { now: NOW, goal: "cheapest" })!;
  assert.equal(p.offer.store, "walmart");
  assert.equal(p.notTheItem, undefined);
  assert.equal(scoreOffers(item("usb-c hub hdmi"), hubs, { now: NOW }).filter((s) => s.excluded).length, 0);
  // A product query whose titles say "for" about something else keeps every offer.
  const food = [
    offer("amazon", "Purina Pro Plan Dry Dog Food for Adult Dogs, Chicken and Rice, 35 lb", 64.98),
    offer("walmart", "Blue Buffalo Life Protection Dry Dog Food for Adult Dogs, 30 lb", 59.98),
  ];
  assert.equal(scoreOffers(item("dry dog food"), food, { now: NOW }).filter((s) => s.excluded).length, 0);
});

test("pickAll (CLI, MCP and web picks) leaves the case out too", () => {
  const req: ShoppingRequest = { prompt: "AirPods Pro 3", stores: ["amazon", "walmart", "bestbuy", "target"], items: [item("AirPods Pro 3")] };
  const r = pickAll(req, airpods().map((o) => ({ ...o, itemId: "item-1" })), { now: NOW });
  assert.equal(r.picks[0].offer.title, WALMART);
  assert.deepEqual(r.total, usd(149));
});

test("engine: a run for \"AirPods Pro 3\" fills the cart with the AirPods, not the case", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-test-"));
  const fb = fakeBrowsers();
  const pick = (store: "amazon" | "walmart" | "bestbuy" | "target") => new FakeAdapter(store, { catalog: { airpods: airpods().filter((o) => o.store === store) } });
  const adapters = { amazon: pick("amazon"), walmart: pick("walmart"), bestbuy: pick("bestbuy"), target: pick("target") };
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir, adapters, openBrowser: fb.open, watchLinks: false });
  const run = await agent.run("AirPods Pro 3 on amazon, walmart, best buy or target", { onEvent: (e) => events.push(e), until: "review" });
  const picks = events.find((e) => e.type === "picks");
  assert.ok(picks && picks.type === "picks");
  assert.equal(picks.picks[0].offer.title, WALMART);
  assert.equal(adapters.amazon.cart.length, 0, "no case in the Amazon cart");
  assert.equal(adapters.walmart.cart.length, 1);
  await run.close();
});

test("web plan: excluding the pick's store never falls back to an accessory", () => {
  const offers = airpods().map((o) => ({ ...o, itemId: "item-1" }));
  const p = pickForItem(item("AirPods Pro 3"), offers, { now: NOW })!;
  const model = M.runModel([
    { type: "parsed", request: { prompt: "AirPods Pro 3", stores: ["amazon", "walmart", "bestbuy", "target"], items: [item("AirPods Pro 3")] } },
    { type: "offers", store: "amazon", itemId: "item-1", offers },
    { type: "picks", total: usd(149), overBudget: false, picks: [{ ...p, alternatives: [] }] },
  ]);
  const plan = M.computePlan(model, { "item-1": { excludedStores: ["walmart"] } });
  assert.equal(plan.items[0].offer.title, BESTBUY);
  assert.equal(plan.items[0].source, "next");
});

test("web pick reason keeps the engine's count of offers compared", () => {
  const p = pickForItem(item("AirPods Pro 3"), airpods(), { now: NOW })!;
  assert.match(M.pickWhy(p, airpods()), /^Lowest delivered total of 2 offers/);
});

// ---------- second live run, 2026-11-24 09:51 UTC ----------

const HEYDAY_12 = "AirPods Pro (1/2 Generation) Silicone Airpods Case with Clip - heyday™";
const HEYDAY_3 = "AirPods Pro (3rd Generation) Case with Clip - heyday™ Peri-Blue";
const HEYDAY_12_BLACK = "AirPods Pro (1/2 generation) Silicone Case with Clip - heyday™ Black with Silver";
const BESTBUY_SHORT = "Apple - AirPods Pro 3, Wireless Active Noise Cancelling Earbuds with Heart Rate...";
const EARPODS = "Apple EarPods (USB-C)";
const AIRPODS_5 = "Apple AirPods 5 Wireless Earbuds with Active Noise Cancellation";

const run2 = () => [
  offer("target", HEYDAY_12, 10, { rating: { stars: 4.6, count: 900 } }),
  offer("target", HEYDAY_3, 10, { rating: { stars: 4.5, count: 40 } }),
  offer("target", HEYDAY_12_BLACK, 10, { rating: { stars: 4.6, count: 900 } }),
  offer("bestbuy", BESTBUY_SHORT, 149.99, { rating: { stars: 4.7, count: 1450 } }),
  offer("walmart", WALMART, 149, { listPrice: usd(249), rating: { stars: 4.7, count: 1450 } }),
  offer("target", EARPODS, 19.99, { rating: { stars: 4.5, count: 3000 } }),
  offer("walmart", AIRPODS_5, 129, { rating: { stars: 4.6, count: 700 } }),
];

test("accessoryOf: a case named after the product, no \"for\" (heyday)", () => {
  for (const t of [HEYDAY_12, HEYDAY_3, HEYDAY_12_BLACK]) assert.equal(accessoryOf("AirPods Pro 3", t), true, t);
  for (const t of [WALMART, BESTBUY_SHORT, EARPODS, AIRPODS_5]) assert.equal(accessoryOf("AirPods Pro 3", t), false, t);
  // A case that comes with the product is not an accessory.
  const products: [string, string][] = [
    ["AirPods Pro 3", "Apple AirPods Pro 3 Wireless Earbuds, Active Noise Cancellation, MagSafe Charging Case (USB-C)"],
    ["AirPods Pro 3", "Apple AirPods Pro 3 Wireless Earbuds with USB-C Charging Case"],
    ["AirPods 4", "Apple AirPods 4 Wireless Earbuds, Bluetooth Headphones, Charging Case Included"],
    ["AirPods 4", "Apple AirPods 4 Wireless Earbuds, Charging Case, Personalized Spatial Audio"],
    ["Apple Watch Series 11", "Apple Watch Series 11 (GPS) 46mm Jet Black Aluminum Case with Black Sport Band - M/L"],
    ["Apple Watch Ultra 3", "Apple Watch Ultra 3 GPS + Cellular 49mm Natural Titanium Case with Black Ocean Band"],
    ["Sony WH-1000XM6", "Sony WH-1000XM6 Wireless Noise Canceling Headphones, Black, Carrying Case Included"],
    ["Dell XPS 13", "Dell XPS 13 Laptop, 13.4 inch FHD, Intel Core Ultra 7, 16GB RAM, 512GB SSD, Backlit Keyboard"],
  ];
  for (const [q, t] of products) assert.equal(accessoryOf(q, t), false, t);
  assert.equal(accessoryOf("iPhone 17 Pro", "iPhone 17 Pro Silicone Case with MagSafe - Black"), true);
  assert.equal(accessoryOf("Galaxy S25 Ultra", "Galaxy S25 Ultra Leather Folio Cover with Card Slots"), true);
});

test("model words: \"AirPods Pro 3\" needs pro and 3 (or 3rd generation)", () => {
  assert.deepEqual(modelTokens("AirPods Pro 3"), ["3", "pro"]);
  assert.deepEqual(modelTokens("iPhone 17 Pro Max"), ["17", "pro", "max"]);
  assert.deepEqual(modelTokens("ps5"), ["ps5"]);
  assert.deepEqual(modelTokens("AirPods Pro"), [], "no model number: no model rule");
  for (const q of ["usb-c hub with hdmi", "dry dog food 30 lb", "27 inch 4k monitor 144hz", "65w usb c charger", "mini fridge", "running shoes size 10", "2 pack socks"]) {
    assert.deepEqual(modelTokens(q), [], q);
  }
  const t = modelTokens("AirPods Pro 3");
  assert.equal(hasModel(t, WALMART), true);
  assert.equal(hasModel(t, BESTBUY_SHORT), true);
  assert.equal(hasModel(t, HEYDAY_3), true, "3rd Generation names model 3");
  assert.equal(hasModel(t, "AirPods Pro (Third Generation)"), true);
  assert.equal(hasModel(t, HEYDAY_12), false);
  assert.equal(hasModel(t, AIRPODS_5), false);
  assert.equal(hasModel(t, EARPODS), false);
  assert.equal(titleMatch("AirPods Pro 3", HEYDAY_3), 1);
});

test("second run: the pick is Walmart's AirPods Pro 3 at $149.00 for every goal", () => {
  for (const goal of ["best_value", "cheapest", "top_rated", "fastest"] as const) {
    const p = pickForItem(item("AirPods Pro 3"), run2(), { now: NOW, goal })!;
    assert.ok([WALMART, BESTBUY_SHORT].includes(p.offer.title), `${goal}: ${p.offer.title}`);
  }
  const p = pickForItem(item("AirPods Pro 3"), run2(), { now: NOW })!;
  assert.equal(p.offer.title, WALMART);
  assert.deepEqual(p.alternatives.map((o) => o.title), [BESTBUY_SHORT]);
  assert.equal(p.notTheItem?.length, 5);
  assert.match(p.reason, /^Lowest delivered total of the 2 offers compared: \$149\.00 delivered/);
  assert.match(p.reason, /7 found, 5 left out: 3 accessories \(not the item itself\), 2 other models/);
  const cheapest = pickForItem(item("AirPods Pro 3"), run2(), { now: NOW, goal: "cheapest" })!;
  assert.equal(cheapest.offer.title, WALMART);
});

test("both live runs together: Walmart's AirPods Pro 3", () => {
  const p = pickForItem(item("AirPods Pro 3"), [...airpods(), ...run2()], { now: NOW })!;
  assert.equal(p.offer.title, WALMART);
});

test("price sanity: an offer far below the named model's price is not the item", () => {
  const offers = [
    offer("walmart", WALMART, 149),
    offer("bestbuy", BESTBUY_SHORT, 149.99),
    offer("amazon", "AirPods Pro 3 Ear Hooks Anti-Slip Silicone, 3 Pairs", 8.99),
  ];
  const scored = scoreOffers(item("AirPods Pro 3"), offers, { now: NOW });
  assert.equal(scored.find((s) => s.offer.store === "amazon")!.excluded, "priced far below the item, not the item itself");
  const p = pickForItem(item("AirPods Pro 3"), offers, { now: NOW })!;
  assert.match(p.reason, /1 priced far below the item/);
  // With only the AirPods and the ear hooks, the median of the two still leaves the hooks out.
  const two = scoreOffers(item("AirPods Pro 3"), offers.filter((o) => o.store !== "bestbuy"), { now: NOW });
  assert.deepEqual(two.filter((s) => s.excluded).map((s) => s.offer.store), ["amazon"]);
  // A real offer below the others (open box at $99) is kept: the line is 40% of the median.
  const kept = scoreOffers(item("AirPods Pro 3"), [...offers.slice(0, 2), offer("ebay", "Apple AirPods Pro 3 - Open Box", 99, { condition: "used" })], { now: NOW });
  assert.equal(kept.filter((s) => s.excluded).length, 0);
});

test("no offer names the model: other models stay in (nothing better to pick)", () => {
  const offers = [offer("walmart", AIRPODS_5, 129), offer("target", EARPODS, 19.99), offer("target", HEYDAY_12, 10)];
  const scored = scoreOffers(item("AirPods Pro 3"), offers, { now: NOW });
  assert.equal(scored.filter((s) => s.excluded === "another model, not the item itself").length, 0);
});

test("accessory queries and generic queries are unchanged by the model and price rules", () => {
  const p = pickForItem(item("airpods pro 3 case"), run2(), { now: NOW, goal: "cheapest" })!;
  assert.equal(p.notTheItem, undefined);
  assert.equal(p.offer.price.cents, 1000);
  const hubs = [
    offer("amazon", "Anker USB C Hub, 7-in-1 Adapter with 4K HDMI, 100W PD", 29.99),
    offer("walmart", "USB C Hub 5 in 1 with HDMI", 9.99),
    offer("bestbuy", "Insignia USB-C to HDMI Adapter", 24.99),
  ];
  const h = pickForItem(item("usb-c hub with hdmi", { maxPrice: usd(40) }), hubs, { now: NOW, goal: "cheapest" })!;
  assert.equal(h.offer.store, "walmart");
  assert.equal(scoreOffers(item("usb-c hub with hdmi"), hubs, { now: NOW }).filter((s) => s.excluded).length, 0);
});

test("engine (second run): the cart gets Walmart's AirPods Pro 3, not the heyday case", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-test-"));
  const fb = fakeBrowsers();
  const mk = (store: "amazon" | "walmart" | "bestbuy" | "target") => new FakeAdapter(store, { catalog: { airpods: run2().filter((o) => o.store === store) } });
  const adapters = { amazon: mk("amazon"), walmart: mk("walmart"), bestbuy: mk("bestbuy"), target: mk("target") };
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir, adapters, openBrowser: fb.open, watchLinks: false });
  const run = await agent.run("AirPods Pro 3 on amazon, walmart, best buy or target", { onEvent: (e) => events.push(e), until: "review" });
  const picks = events.find((e) => e.type === "picks");
  assert.ok(picks && picks.type === "picks");
  assert.equal(picks.picks[0].offer.title, WALMART);
  assert.equal(adapters.target.cart.length, 0, "no case in the Target cart");
  assert.equal(adapters.walmart.cart.length, 1);
  await run.close();
});
