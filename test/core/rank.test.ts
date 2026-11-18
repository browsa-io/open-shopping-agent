import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bayesianRating, deliveredTotal, exclusionReason, missingRequirements, pickAll, pickForItem, scoreOffers, titleMatch,
} from "../../src/core/rank.js";
import type { ItemRequest, ShoppingRequest } from "../../src/core/types.js";
import { offer, usd } from "./fake-adapter.js";

const item = (extra: Partial<ItemRequest> = {}): ItemRequest => ({ id: "item-1", query: "usb c hub", description: "a usb c hub", quantity: 1, ...extra });
const NOW = new Date("2026-11-18T12:00:00Z");

test("deliveredTotal: price x quantity + shipping; unknown shipping counts 0", () => {
  assert.deepEqual(deliveredTotal(offer("amazon", "x", 10, { shipping: usd(5) }), 3), usd(35));
  assert.deepEqual(deliveredTotal(offer("amazon", "x", 10, { shipping: undefined }), 2), usd(20));
});

test("bayesianRating: many reviews beat few perfect ones", () => {
  const few = bayesianRating({ stars: 5, count: 3 });
  const many = bayesianRating({ stars: 4.6, count: 10_000 });
  assert.ok(many > few, `${many} > ${few}`);
  assert.equal(bayesianRating(undefined), 3.8);
  assert.equal(bayesianRating({ stars: 4, count: 0 }), 3.8);
});

test("titleMatch and missingRequirements", () => {
  assert.equal(titleMatch("usb c hub", "Anker USB-C Hub 7-in-1"), 1);
  assert.ok(titleMatch("usb c hub", "Phone case") < 0.34);
  const i = item({ mustHave: ["HDMI 4K60", "100W"] });
  assert.deepEqual(missingRequirements(i, offer("amazon", "USB-C Hub, HDMI 4K@60Hz, 100W PD", 30)), []);
  assert.deepEqual(missingRequirements(i, offer("amazon", "USB-C Hub with HDMI 4K30", 30)), ["HDMI 4K60", "100W"]);
});

test("exclusions: out of stock, subscription, membership, over max price, other currency", () => {
  const i = item({ maxPrice: usd(40) });
  assert.equal(exclusionReason(i, offer("amazon", "hub", 30, { inStock: false })), "out of stock");
  assert.equal(exclusionReason(i, offer("amazon", "hub", 30, { subscription: true })), "subscription offer");
  assert.equal(exclusionReason(i, offer("amazon", "Amazon Prime membership free trial", 0.01)), "membership or trial offer");
  assert.equal(exclusionReason(i, offer("amazon", "hub", 41)), "over $40.00 each");
  assert.equal(exclusionReason(i, offer("amazon", "hub", 30, { price: { cents: 3000, currency: "EUR" } })), "priced in EUR");
  assert.equal(exclusionReason(i, offer("amazon", "hub", 40)), undefined);
});

test("cheapest picks the lowest delivered total, shipping included", () => {
  const offers = [
    offer("amazon", "USB-C Hub A", 20, { shipping: usd(8) }),
    offer("walmart", "USB-C Hub B", 25, { shipping: usd(0) }),
    offer("ebay", "USB-C Hub C", 24, { shipping: usd(3) }),
  ];
  const p = pickForItem(item({ quantity: 2 }), offers, { goal: "cheapest", now: NOW })!;
  assert.equal(p.offer.title, "USB-C Hub A"); // 48 vs 50 vs 51
  assert.match(p.reason, /^Lowest delivered total of 3 offers: \$48\.00 for 2 delivered/);
  assert.equal(p.alternatives.length, 2);
});

test("best value weighs rating confidence; sponsored is penalized", () => {
  const offers = [
    offer("amazon", "USB-C Hub perfect", 30, { rating: { stars: 5, count: 2 } }),
    offer("walmart", "USB-C Hub trusted", 31, { rating: { stars: 4.7, count: 8000 } }),
  ];
  assert.equal(pickForItem(item(), offers, { now: NOW })!.offer.title, "USB-C Hub trusted");
  const same = [
    offer("amazon", "USB-C Hub ad", 30, { sponsored: true }),
    offer("walmart", "USB-C Hub organic", 30),
  ];
  assert.equal(pickForItem(item(), same, { now: NOW })!.offer.title, "USB-C Hub organic");
});

test("fastest prefers the soonest delivery", () => {
  const offers = [
    offer("amazon", "USB-C Hub slow", 20, { deliveryDate: "2026-11-25" }),
    offer("bestbuy", "USB-C Hub fast", 26, { deliveryDate: "2026-11-19", deliveryText: "Tomorrow" }),
  ];
  const p = pickForItem(item(), offers, { goal: "fastest", now: NOW })!;
  assert.equal(p.offer.title, "USB-C Hub fast");
  assert.match(p.reason, /^Soonest delivery of 2 offers/);
  assert.match(p.reason, /Tomorrow/);
  assert.match(p.reason, /Best Buy$/);
});

test("top_rated prefers the best weighted rating", () => {
  const offers = [
    offer("amazon", "USB-C Hub ok", 20, { rating: { stars: 4.1, count: 900 } }),
    offer("target", "USB-C Hub great", 35, { rating: { stars: 4.8, count: 2500 } }),
  ];
  assert.equal(pickForItem(item(), offers, { goal: "top_rated", now: NOW })!.offer.title, "USB-C Hub great");
});

test("must-haves are hard when some offer meets them, soft otherwise", () => {
  const i = item({ mustHave: ["HDMI"] });
  const hard = [offer("amazon", "USB-C Hub no video", 10), offer("walmart", "USB-C Hub HDMI", 30)];
  const p = pickForItem(i, hard, { goal: "cheapest", now: NOW })!;
  assert.equal(p.offer.title, "USB-C Hub HDMI");
  assert.match(p.reason, /lists HDMI/);
  const soft = [offer("amazon", "USB-C Hub one", 10), offer("walmart", "USB-C Hub two", 30)];
  const q = pickForItem(i, soft, { goal: "cheapest", now: NOW })!;
  assert.equal(q.offer.title, "USB-C Hub one");
  assert.match(q.reason, /title does not list HDMI/);
});

test("used and refurbished lose to new unless asked for", () => {
  const offers = [offer("ebay", "USB-C Hub used", 15, { condition: "used" }), offer("amazon", "USB-C Hub", 17)];
  assert.equal(pickForItem(item(), offers, { now: NOW })!.offer.title, "USB-C Hub");
  assert.equal(pickForItem(item({ query: "used usb c hub" }), offers, { goal: "cheapest", now: NOW })!.offer.title, "USB-C Hub used");
});

test("no pick when everything is excluded; excluded offers sort last", () => {
  const offers = [offer("amazon", "USB-C Hub", 10, { inStock: false }), offer("walmart", "USB-C Hub", 12, { subscription: true })];
  assert.equal(pickForItem(item(), offers), undefined);
  const s = scoreOffers(item(), [...offers, offer("ebay", "USB-C Hub", 50)]);
  assert.equal(s[0].offer.store, "ebay");
  assert.ok(s.slice(1).every((x) => x.excluded && x.score === -1));
});

test("duplicates collapse; alternatives are at most 4", () => {
  const many = Array.from({ length: 8 }, (_, n) => offer("amazon", `USB-C Hub ${n}`, 20 + n));
  many.push({ ...many[0] });
  const p = pickForItem(item(), many, { now: NOW })!;
  assert.equal(p.alternatives.length, 4);
  assert.ok(!p.alternatives.some((a) => a.url === p.offer.url));
});

test("pickAll adds totals, flags over budget and lists unpicked items", () => {
  const req: ShoppingRequest = {
    prompt: "p", stores: ["amazon"], budget: usd(50),
    items: [item(), { id: "item-2", query: "hdmi cable", description: "cable", quantity: 2 }, { id: "item-3", query: "unicorn", description: "u", quantity: 1 }],
  };
  const offers = [
    { ...offer("amazon", "USB-C Hub", 30), itemId: "item-1" },
    { ...offer("amazon", "HDMI cable 6ft", 12, { shipping: usd(2) }), itemId: "item-2" },
  ];
  const r = pickAll(req, offers);
  assert.equal(r.picks.length, 2);
  assert.deepEqual(r.total, usd(56));
  assert.equal(r.overBudget, true);
  assert.deepEqual(r.unpicked, [{ itemId: "item-3", reason: "no offers found" }]);
});

test("an unknown shipping cost is never called delivered", () => {
  const offers = [
    offer("walmart", "USB-C Hub A", 10, { shipping: undefined }),
    offer("walmart", "USB-C Hub B", 12, { shipping: undefined }),
  ];
  const p = pickForItem(item(), offers, { goal: "cheapest", now: NOW })!;
  assert.doesNotMatch(p.reason, /delivered/);
  assert.match(p.reason, /plus shipping/);
});
