import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import adapter, {
  buyableCombos, chooseCombo, isErrorPage, lastDate, matchOptions, type Msku, parseCart, parseCheckout, parseItem, parseSearch, parseSeller, parseShipping,
  searchUrlFor, variationFor, warmQueryFor,
} from "../../src/stores/ebay.js";
import { sameOption } from "../../src/stores/util.js";
import type { StoreContext } from "../../src/stores/adapter.js";

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/ebay/${name}`, import.meta.url)), "utf8");
const NOW = new Date("2026-11-18T12:00:00Z");

test("ebay: search URL has Buy It Now, condition and ZIP filters", () => {
  const u = new URL(searchUrlFor("usb c hub", { zip: "10001" }));
  assert.equal(u.searchParams.get("_nkw"), "usb c hub");
  assert.equal(u.searchParams.get("LH_BIN"), "1");
  assert.equal(u.searchParams.get("LH_ItemCondition"), "1000");
  assert.equal(u.searchParams.get("_stpos"), "10001");
  assert.equal(new URL(searchUrlFor("x", { condition: "used" })).searchParams.get("LH_ItemCondition"), "3000");
  assert.equal(new URL(adapter.searchUrl("x", "ebay.com")).searchParams.get("LH_BIN"), "1");
});

test("ebay: search results parse into Buy It Now offers", () => {
  const offers = parseSearch(fx("search.html"), "item-1", NOW);
  assert.equal(offers.length, 8, "the 'Shop on eBay' placeholder card is skipped");
  const first = offers[0];
  assert.equal(first.store, "ebay");
  assert.equal(first.itemId, "item-1");
  assert.equal(first.productId, "395253841129");
  assert.equal(first.url, "https://www.ebay.com/itm/395253841129");
  assert.match(first.title, /^Apple USB-C to USB Adapter/);
  assert.deepEqual(first.price, { cents: 1219, currency: "USD" });
  assert.deepEqual(first.shipping, { cents: 0, currency: "USD" });
  assert.equal(first.deliveryText, "Free delivery in 2-4 days");
  assert.equal(first.condition, "new");
  assert.equal(first.raw?.sellerName, "wishmedeals");
  assert.equal(first.raw?.sellerPositivePercent, 99.7);
  assert.equal(first.raw?.sellerFeedbackCount, 9700);
  assert.equal(first.rating?.stars, 5);
  const second = offers[1];
  assert.deepEqual(second.listPrice, { cents: 599, currency: "USD" }, "strikethrough price is the was-price");
  assert.equal(second.raw?.bestOffer, true);
  assert.equal(second.seller, "acemagic-direct (99.9% positive, 1400 ratings)");
  for (const o of offers) {
    assert.ok(o.price.cents > 0);
    assert.ok(o.inStock);
    assert.equal(o.raw?.buyItNow, true);
  }
});

test("ebay: variation listings are flagged with a price range", () => {
  const offers = parseSearch(fx("search-variations.html"), "item-2", NOW);
  const v = offers.find((o) => o.productId === "384161224121");
  assert.ok(v);
  assert.equal(v.raw?.priceRange, true);
  assert.deepEqual(v.price, { cents: 1149, currency: "USD" }, "the low end of the range");
  const single = offers.find((o) => o.productId === "276459363133");
  assert.equal(single?.raw?.priceRange, undefined);
});

test("ebay: auction cards are skipped", () => {
  const auction = `<ul><li data-listingid="123456789012"><div role="heading" class="s-card__title"><span>Old USB hub lot</span></div>
    <div class="s-card__subtitle"><span>Pre-Owned</span></div><span class="s-card__price">$4.50</span><span>3 bids</span><span>Time left 2h</span></li>
    <li data-listingid="223456789012"><div role="heading" class="s-card__title"><span>New USB hub</span></div>
    <div class="s-card__subtitle"><span>Brand New</span></div><span class="s-card__price">$9.99</span><span>Buy It Now</span><span>+$3.25 delivery</span></li></ul>`;
  const offers = parseSearch(auction, "i", NOW);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].productId, "223456789012");
  assert.deepEqual(offers[0].shipping, { cents: 325, currency: "USD" });
});

test("ebay: item page gives JSON-LD price, seller feedback and the MSKU variations", () => {
  const it = parseItem(fx("item-variation.html"));
  assert.match(it.title ?? "", /^4K HIGH SPEED HDMI CABLE/);
  assert.deepEqual(it.price, { cents: 599, currency: "USD" });
  assert.equal(it.condition, "new");
  assert.equal(it.buyItNow, true);
  assert.equal(it.auctionOnly, false);
  assert.deepEqual(it.shipping, { cents: 0, currency: "USD" });
  assert.match(it.deliveryText ?? "", /Nov 20 and Mon, Nov 23/);
  assert.deepEqual(it.seller, { name: "custom-sign", positivePercent: 99.1, feedbackCount: 255247 });
  assert.ok(it.msku);
  assert.equal(it.msku.menus.length, 1);
  assert.equal(it.msku.menus[0].label, "Cable Length");
  assert.deepEqual(it.msku.menus[0].values.map((v) => v.name), ["5 ft", "10 ft", "15 ft", "20 ft", "30 ft", "50 ft"]);
  assert.equal(it.msku.menus[0].values[0].outOfStock, true);
});

test("ebay: options map to the variation id; bad or missing options are reported", () => {
  const msku = parseItem(fx("item-variation.html")).msku!;
  const ok = matchOptions(msku, { length: "10 FT" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.chosen[0].value.name, "10 ft");
  assert.equal(variationFor(msku, ok.chosen.map((c) => c.value.id)), 504792382401);
  assert.match(matchOptions(msku, { length: "6 ft" }).problems[0], /"6 ft" is not offered/);
  assert.match(matchOptions(msku, { length: "5 ft" }).problems[0], /out of stock/);
  assert.match(matchOptions(msku, {}).problems[0], /^choose Cable Length/);
  // A value alone (no matching key) still finds its menu.
  assert.equal(matchOptions(msku, { size: "20 ft" }).chosen[0].value.name, "20 ft");
});

test("ebay: only buyable combinations are offered; impossible pairs are refused", () => {
  const msku = parseItem(fx("item-variation.html")).msku!;
  const combos = buyableCombos(msku);
  assert.equal(combos.length, 5, "the out-of-stock 5 ft variation is left out");
  assert.deepEqual(combos[0], { "Cable Length": "10 ft" });
  const two: Msku = {
    menus: [
      { id: 1, label: "Model", values: [{ id: 0, name: "AA", outOfStock: false }, { id: 1, name: "AAA", outOfStock: false }] },
      { id: 2, label: "QTY", values: [{ id: 2, name: "12 PCS", outOfStock: false }, { id: 3, name: "60 PCS", outOfStock: false }] },
    ],
    combinations: { "0_2": 100, "0_3": 101, "1_2": 102 },
    prices: {}, inStock: { 100: true, 101: false, 102: true },
  };
  assert.match(matchOptions(two, { Model: "AAA", QTY: "60 PCS" }).problems[0], /not offered together/);
  assert.match(matchOptions(two, { Model: "AA", QTY: "60 PCS" }).problems[0], /out of stock/);
  assert.deepEqual(matchOptions(two, { Model: "AAA", QTY: "12 pcs" }).problems, []);
  assert.deepEqual(buyableCombos(two), [{ Model: "AA", QTY: "12 PCS" }, { Model: "AAA", QTY: "12 PCS" }]);
});

test("ebay: options are chosen only from the combinations eBay sells", () => {
  const combos = [{ Model: "AA", QTY: "12 PCS" }, { Model: "AA", QTY: "24 PCS" }, { Model: "AAA", QTY: "12 PCS" }];
  assert.deepEqual(chooseCombo(combos, { model: "AAA" }).combo, { Model: "AAA", QTY: "12 PCS" }, "a partial wish is completed from a sold combination");
  assert.deepEqual(chooseCombo(combos, { qty: "24 pcs" }).combo, { Model: "AA", QTY: "24 PCS" });
  assert.deepEqual(chooseCombo(combos, { size: "24 PCS" }).combo, { Model: "AA", QTY: "24 PCS" }, "matched by value when the name differs");
  assert.deepEqual(chooseCombo(combos, { condition: "used" }).combo, combos[0], "condition is not a listing option");
  const no = chooseCombo(combos, { Model: "AAA", QTY: "24 PCS" });
  assert.equal(no.combo, undefined);
  assert.match(no.problem!, /Model "AAA" \+ QTY "24 PCS" is not sold; eBay sells: AA \/ 12 PCS; AA \/ 24 PCS; AAA \/ 12 PCS/);
  assert.match(chooseCombo([], {}).problem!, /sells no combination/);
  // With no wish: the combination at the compared price, else the cheapest.
  const prices: Record<string, number> = { "12 PCS": 999, "24 PCS": 1599 };
  const of = (c: Record<string, string>) => (c.Model === "AA" ? prices[c.QTY] : 1299);
  assert.deepEqual(chooseCombo(combos, {}, { of, offerCents: 1599 }).combo, { Model: "AA", QTY: "24 PCS" });
  assert.deepEqual(chooseCombo(combos, {}, { of, offerCents: 5 }).combo, { Model: "AA", QTY: "12 PCS" });
  // The fixture listing: 5 ft is out of stock, so it is never chosen.
  const sold = buyableCombos(parseItem(fx("item-variation.html")).msku!);
  assert.match(chooseCombo(sold, { "Cable Length": "5 ft" }).problem!, /is not sold/);
  assert.deepEqual(chooseCombo(sold, { length: "20 feet" }).combo, { "Cable Length": "20 ft" });
});

test("ebay: cart parses item id, variation, options and subtotal", () => {
  const c = parseCart(fx("cart.html"));
  assert.equal(c.lines.length, 1);
  const l = c.lines[0];
  assert.equal(l.productId, "204216513185");
  assert.equal(l.variationId, "504792382401");
  assert.equal(l.quantity, 1);
  assert.deepEqual(l.price, { cents: 599, currency: "USD" });
  assert.deepEqual(Object.values(l.options ?? {}), ["10 ft"]);
  assert.deepEqual(c.subtotal, { cents: 599, currency: "USD" });
  assert.deepEqual(parseCart("<html><body>Your cart is empty</body></html>").lines, []);
});

test("ebay: guest checkout review needs an address and keeps Confirm and pay disabled", () => {
  const co = parseCheckout(fx("checkout-guest.html"));
  assert.equal(co.needs, "address");
  assert.equal(co.confirmEnabled, false);
  assert.deepEqual(co.total, { cents: 599, currency: "USD" });
  assert.deepEqual(co.subtotal, { cents: 599, currency: "USD" });
  assert.deepEqual(co.shipping, { cents: 0, currency: "USD" });
  assert.equal(co.lines.length, 1);
  assert.deepEqual(co.lines[0].options, { "Cable Length": "10 ft" });
});

test("ebay: small parsers", () => {
  assert.deepEqual(parseShipping("+$5.99 delivery"), { cents: 599, currency: "USD" });
  assert.deepEqual(parseShipping("Free delivery in 2-4 days"), { cents: 0, currency: "USD" });
  assert.equal(parseShipping("Shipping not specified"), undefined);
  assert.equal(lastDate("Get it between Fri, Nov 20 and Mon, Nov 23", NOW), "2026-11-23");
  assert.equal(lastDate("Arrives Jan 4", NOW), "2027-01-04");
  assert.deepEqual(parseSeller(["shop-x", "98.5% positive (1.2K)"]), { name: "shop-x", positivePercent: 98.5, feedbackCount: 1200 });
  assert.ok(sameOption("6 ft", "6FT") && sameOption("6 Feet", "6 ft") && !sameOption("6 ft", "10 ft"));
  assert.ok(isErrorPage("<p>SORRY Something went wrong on our end</p>", "Error Page | eBay"));
});

function fakeCtx(html: string, url: string): StoreContext & { logs: string[] } {
  const logs: string[] = [];
  const page: any = {
    url: () => url,
    content: async () => html,
    reload: async () => null,
    waitForTimeout: async () => {},
    title: async () => "Checkout | eBay",
    locator: () => { throw new Error("must not click anything"); },
  };
  return {
    store: "ebay", domain: "ebay.com", page, agentId: "agt_test", logs,
    aiTask: async () => { throw new Error("no AI in unit tests"); },
    liveLink: async () => "https://browsa.io/live?agent=agt_test",
    log: (m: string) => logs.push(m),
    signal: new AbortController().signal,
  } as any;
}

test("ebay: placeOrder aborts when the total differs from the approval", async () => {
  const ctx = fakeCtx(fx("checkout-guest.html"), "https://pay.ebay.com/rgxo?action=view&sessionid=1");
  const r = await adapter.placeOrder(ctx, { store: "ebay", approvedTotal: { cents: 500, currency: "USD" }, approvedAt: NOW.toISOString(), by: "user" });
  assert.equal(r.placed, false);
  assert.match(r.error ?? "", /eBay total is now 5.99 USD, approved 5 USD; not placing the order/);
  assert.deepEqual(r.total, { cents: 599, currency: "USD" });
});

test("ebay: placeOrder with the right total still stops for the address, without clicking", async () => {
  const ctx = fakeCtx(fx("checkout-guest.html"), "https://pay.ebay.com/rgxo?action=view&sessionid=1");
  const r = await adapter.placeOrder(ctx, { store: "ebay", approvedTotal: { cents: 599, currency: "USD" }, approvedAt: NOW.toISOString(), by: "user" });
  assert.equal(r.placed, false);
  assert.equal(r.needsUser?.reason, "address");
  assert.equal(r.needsUser?.liveUrl, "https://browsa.io/live?agent=agt_test");
});

test("ebay: the warm-up search for a refused item page uses the first words of the title", () => {
  const o = { title: "USB C to HDMI Adapter, 4K USB-C Hub (6 in 1) for MacBook", url: "https://www.ebay.com/itm/1" } as never;
  assert.equal(warmQueryFor(o), "USB C to HDMI Adapter 4K");
});
