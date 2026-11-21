// 0.2.1: the pick reason. It is never cut mid-word, and its count is the offers that were
// compared: when some of the offers found were left out, it says how many and why.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clipWords, leftOutText, pickForItem, scoreOffers } from "../../src/core/rank.js";
import type { ItemRequest } from "../../src/core/types.js";
import { offer, usd } from "./fake-adapter.js";

const item = (extra: Partial<ItemRequest> = {}): ItemRequest => ({ id: "item-1", query: "usb c cable", description: "6 ft usb-c cable", quantity: 1, ...extra });

test("clipWords cuts at a word boundary and marks the cut", () => {
  assert.equal(clipWords("Arrives Tomorrow", 60), "Arrives Tomorrow");
  const long = "FREE delivery Thu, Nov 26 on orders shipped by the seller over $35";
  const cut = clipWords(long, 40);
  assert.equal(cut, "FREE delivery Thu, Nov 26 on orders…");
  assert.ok([...cut].length <= 41);
  // every word of the cut text is a whole word of the original
  for (const w of cut.replace("…", "").split(" ")) assert.ok(long.split(" ").includes(w), w);
  assert.equal(clipWords("a  b\n c", 60), "a b c");
});

test("the reason keeps whole words of a long delivery text (it used to end \"…on ord\")", () => {
  const deliveryText = "FREE delivery Thu, Nov 26 on orders shipped by the seller over $35 or fastest delivery Tomorrow";
  const p = pickForItem(item(), [
    offer("amazon", "USB C cable 6 ft", 9, { deliveryText }),
    offer("walmart", "USB C cable 6 ft", 12),
  ])!;
  assert.doesNotMatch(p.reason, /on ord(,|$)/);
  assert.match(p.reason, /FREE delivery Thu, Nov 26 on orders shipped by the seller…, Amazon$/);
});

test("the count is what was compared; the rest is named with why it was left out", () => {
  const offers = [
    ...Array.from({ length: 12 }, (_, i) => offer(i % 2 ? "amazon" : "ebay", `USB C cable 6 ft model ${i}`, 7 + i, { shipping: undefined })),
    ...Array.from({ length: 5 }, (_, i) => offer("target", `USB C cable 6 ft sold out ${i}`, 5, { inStock: false })),
    ...Array.from({ length: 4 }, (_, i) => offer("walmart", `USB C cable 6 ft braided ${i}`, 19 + i)),
  ];
  assert.equal(offers.length, 21);
  const it = item({ maxPrice: usd(15) });
  // 12 can be picked... except those over $15: models 9, 10, 11 cost 16, 17, 18.
  const scored = scoreOffers(it, offers);
  const compared = scored.filter((s) => !s.excluded).length;
  assert.equal(compared, 9);
  assert.equal(leftOutText(scored), "12 left out: 7 over $15.00 each, 5 out of stock");
  const p = pickForItem(it, offers)!;
  assert.match(p.reason, /^Lowest price of the 9 offers compared: \$7\.00 plus shipping/);
  assert.match(p.reason, /\. 21 found, 12 left out: 7 over \$15\.00 each, 5 out of stock$/);
  assert.doesNotMatch(p.reason, /of 21 offers|of 9 offers:/);
});

test("nothing left out: no \"found\" tail; another currency is named", () => {
  const p = pickForItem(item(), [offer("amazon", "USB C cable 6 ft", 9), offer("walmart", "USB C cable 6 ft", 12)])!;
  assert.match(p.reason, /^Lowest delivered total of the 2 offers compared/);
  assert.doesNotMatch(p.reason, /found|left out/);
  const q = pickForItem(item(), [
    offer("amazon", "USB C cable 6 ft", 9),
    offer("walmart", "USB C cable 6 ft", 12),
    offer("ebay", "USB C cable 6 ft", 8, { price: { cents: 800, currency: "EUR" } }),
  ])!;
  assert.match(q.reason, /3 found, 1 left out: 1 priced in EUR, not USD$/);
});
