import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commonPer, explainContents, formatUnitCents, perUnitFromStore, readContents, sortByUnitPrice, withUnits,
} from "../../src/core/units.js";
import { pickForItem, scoreOffers } from "../../src/core/rank.js";
import type { ItemRequest } from "../../src/core/types.js";
import { offer, usd } from "./fake-adapter.js";

const c = (title: string) => {
  const x = readContents(title);
  return x ? { count: x.count, ml: x.ml, g: x.g } : undefined;
};

test("units: pack counts in the common spellings", () => {
  for (const t of ["Amazon Basics AA Batteries, Pack of 24", "AA Batteries 24 Pack", "AA Batteries, 24-Pack", "AA Batteries 24pk", "Duracell AA 24 Count", "AA batteries 24 ct", "24 pcs AA batteries", "Set of 24 AA batteries"]) {
    assert.deepEqual(c(t), { count: 24, ml: undefined, g: undefined }, t);
  }
  assert.equal(c("Coffee Pods, 12 Count (Pack of 2)")?.count, 24, "a count times the outer pack");
  assert.equal(c("AA Batteries, 24 Count (Pack of 1)")?.count, 24);
  assert.equal(c("Pack of 24 AA batteries, 24 count")?.count, 24, "the same number twice is one count");
  assert.equal(c("Sparkling Water 24 Cans")?.count, 24);
});

test("units: sizes and multipacks, metric and US", () => {
  assert.deepEqual(c("Smartwater 2 x 1L"), { count: 2, ml: 2000, g: undefined });
  assert.deepEqual(c("Spring Water 500ml x 6"), { count: 6, ml: 3000, g: undefined });
  assert.deepEqual(c("Spring Water 6 x 500 ml (3 L)"), { count: 6, ml: 3000, g: undefined }, "the total written out agrees");
  assert.equal(c("Fiji Water 500 ml")?.ml, 500);
  assert.equal(c("Olive Oil 1.5 L")?.ml, 1500);
  assert.equal(c("Milk 1 Gallon")?.ml, 3785.41);
  assert.equal(Math.round(c("Coca-Cola 12 fl oz, 12 Pack")!.ml!), Math.round(144 * 29.5735), "a size next to a pack is per piece");
  assert.equal(c("Coca-Cola 12 fl oz, 12 Pack")?.count, 12);
  assert.equal(Math.round(c("Ground Coffee 12 oz")!.g!), 340, "oz is weight; fl oz is volume");
  assert.equal(Math.round(c("Rice 2 lb")!.g!), 907);
  assert.equal(c("Protein Powder 2 lbs (907 g)")?.g, 907.184, "two spellings of one weight");
  assert.equal(Math.round(c("Perfume 3.4 fl oz / 100 ml")!.ml!), 101, "two spellings of one volume");
  assert.equal(c("Water 2 x 1L (Pack of 3)")?.ml, 6000);
});

test("units: refuses to guess when it is ambiguous", () => {
  const refused = (t: string) => explainContents(t).refused;
  assert.equal(refused("Water 500 ml / 1 L"), "ambiguous_size", "two different sizes");
  assert.equal(refused("Shampoo 12 oz and 24 oz"), "ambiguous_size");
  assert.equal(refused("AA Batteries 24 or 48 Count"), "range", "a choice");
  assert.equal(refused("Coffee Pods 12-24 count"), "range");
  assert.equal(refused("Paper Towels, 6 Rolls, 120 Sheets per Roll"), "ambiguous_count", "two unrelated counts");
  assert.equal(refused("Pods 12 Count, 24 Pack"), "ambiguous_count", "two counts, neither an outer (Pack of N)");
  assert.equal(refused("Detergent Pods, Assorted Sizes"), "ambiguous_size");
  assert.equal(readContents("Water 500 ml / 1 L"), undefined);
  assert.equal(readContents("Samsung Galaxy 5G phone, 128GB"), undefined, "5G is not 5 grams, 128GB is not a size");
  assert.equal(readContents("USB-C Hub 7 in 1, 4K HDMI, 100W"), undefined);
  assert.equal(readContents("HDMI Cable 6 ft"), undefined, "lengths are not unit-priced");
});

test("units: price per unit, formatted like the stores", () => {
  const o = withUnits(offer("amazon", "AA Batteries, Pack of 24", 9.99));
  assert.deepEqual(o.perUnit, { cents: 41.625, currency: "USD", per: "count", text: "$0.42 / count", source: "title" });
  assert.equal(withUnits(offer("walmart", "Sparkling Water 12 fl oz, 12 Pack", 5.99)).perUnit?.text, "$0.042 / fl oz");
  assert.equal(formatUnitCents(41.625), "$0.42");
  assert.equal(formatUnitCents(4.16), "$0.042");
  assert.equal(formatUnitCents(0.41), "$0.0041");
  const plain = offer("amazon", "USB-C hub", 25);
  assert.equal(withUnits(plain), plain, "nothing to add: the same offer");
});

test("units: a unit price the store shows wins, in comparable units", () => {
  assert.deepEqual(perUnitFromStore({ amount: usd(0.5), per: "count" }), { cents: 50, currency: "USD", per: "count", text: "$0.50 / count", source: "store" });
  assert.equal(perUnitFromStore({ amount: usd(12), per: "100 Count" })?.cents, 12);
  assert.equal(perUnitFromStore({ amount: usd(1.6), per: "lb" })?.per, "oz");
  assert.equal(perUnitFromStore({ amount: usd(1.6), per: "lb" })?.cents, 10, "$1.60 / lb is $0.10 / oz");
  assert.equal(perUnitFromStore({ amount: usd(0.25), per: "Fl Oz" })?.per, "fl oz");
  assert.equal(perUnitFromStore({ amount: usd(0.25), per: "furlong" }), undefined);
  const o = withUnits(offer("amazon", "AA Batteries, Pack of 24", 9.99, { unitPrice: { amount: usd(0.41), per: "count" } }));
  assert.equal(o.perUnit?.source, "store");
  assert.equal(o.perUnit?.text, "$0.41 / count");
});

test("units: sort by unit price in the unit most offers share; unknown last", () => {
  const offers = [
    offer("amazon", "AA Batteries, Pack of 24", 9.99),
    offer("walmart", "AA Batteries 48 Count", 16.99),
    offer("ebay", "AA batteries", 3),
    offer("target", "AA Batteries 8 Pack", 4.49),
  ].map(withUnits);
  assert.equal(commonPer(offers), "count");
  assert.deepEqual(sortByUnitPrice(offers).map((o) => o.store), ["walmart", "amazon", "target", "ebay"]);
});

const batteries: ItemRequest = { id: "item-1", query: "aa batteries", description: "aa batteries", quantity: 1 };

test("rank: unit price only breaks exact ties; the default ranking does not change", () => {
  // Same price, rating, shipping and title words: the bigger pack wins the tie.
  const tie = [offer("amazon", "AA Batteries Pack of 24", 12), offer("walmart", "AA Batteries Pack of 48", 12)].map(withUnits);
  const scored = scoreOffers(batteries, tie);
  assert.equal(scored[0].score, scored[1].score);
  assert.equal(scored[0].offer.store, "walmart");
  assert.equal(scoreOffers(batteries, [...tie].reverse())[0].offer.store, "walmart", "independent of input order");

  // A cheaper pack per unit but a higher total does not win by default.
  const notTie = [offer("amazon", "AA Batteries Pack of 8", 4.49), offer("walmart", "AA Batteries Pack of 48", 16.99)].map(withUnits);
  const p = pickForItem(batteries, notTie)!;
  assert.equal(p.offer.store, "amazon");
  assert.match(p.reason, /\$0\.56 \/ count/, "the reason shows the pick's unit price");
});
