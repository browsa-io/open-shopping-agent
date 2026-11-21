// Non-USD prices (0.1.1): a store that shows another currency is never read as dollars, never
// ranked and never added to a total. Seen live 2026-11-19: a store showed another currency to a visitor and
// 0.1.0 read that number as dollars.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currencyNote, detectCurrency, formatMoney, parseMoney } from "../../src/stores/util.js";
import { exclusionReason, markCurrency, pickAll, pickEveryStore, scoreOffers } from "../../src/core/rank.js";
import { foreignCurrency, parseAmazonCart, parseAmazonSearch } from "../../src/stores/amazon.js";
import { dp1WithUsBuyer, parseShipping } from "../../src/stores/ebay.js";
import { usd as targetUsd } from "../../src/stores/target.js";
import { applyChoices } from "../../src/web/plan.js";
import { compareFromEvents } from "../../src/web/format.js";
import { ShoppingAgent } from "../../src/core/engine.js";
import type { ItemRequest, Offer, RunEvent, ShoppingRequest } from "../../src/core/types.js";
import { FakeAdapter, fakeBrowsers, offer, usd } from "./fake-adapter.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "..", "fixtures", name), "utf8");
const money = (cents: number, currency: string) => ({ cents, currency });

test("parseMoney: currency from the symbol or code, never dollars for another currency", () => {
  const cases: [string, number, string][] = [
    // A currency code before the amount, with and without the no-break space.
    ["EUR 1,827.04", 182704, "EUR"],
    ["EUR 1,552.71", 155271, "EUR"],
    ["EUR52.87 to EUR132.18", 5287, "EUR"],
    // EUR: Amazon's en_US and de_DE formats, and a code after the number.
    ["EUR 1,234.56", 123456, "EUR"],
    ["€1,234.56", 123456, "EUR"],
    ["1.234,56 €", 123456, "EUR"],
    ["1.234,56 €", 123456, "EUR"],
    ["12,99 €", 1299, "EUR"],
    ["1 234,56 EUR", 123456, "EUR"],
    // GBP
    ["£1,049.00", 104900, "GBP"],
    ["GBP 12.50", 1250, "GBP"],
    // JPY has no decimals: "1,980" is one thousand nine hundred eighty, never 1.98.
    ["¥1,980", 198000, "JPY"],
    ["￥12,345", 1234500, "JPY"],
    ["JPY 1,234", 123400, "JPY"],
    ["JPY 980", 98000, "JPY"],
    // INR with lakh grouping.
    ["₹1,23,456.78", 12345678, "INR"],
    ["INR 1,299.00", 129900, "INR"],
    ["Rs. 499", 49900, "INR"],
    // USD with a code, eBay's "US $" and plain dollars.
    ["USD 1,234.56", 123456, "USD"],
    ["1,234.56 USD", 123456, "USD"],
    ["US $14.99", 1499, "USD"],
    ["$1,299.99", 129999, "USD"],
    ["$12.99 ($0.65/count)", 1299, "USD"],
    ["Pack of 2 $12.99", 1299, "USD"],
    ["$5.99 100 pack", 599, "USD"],
    ["CHF 1'234.50", 123450, "CHF"],
    ["C$19.99", 1999, "CAD"],
  ];
  for (const [text, cents, currency] of cases) {
    assert.deepEqual(parseMoney(text), { cents, currency }, text);
  }
  // No symbol: the caller's currency. A bare "$" in a Canadian shop is CAD.
  assert.deepEqual(parseMoney("12.99"), usd(12.99));
  assert.deepEqual(parseMoney("$19.99", "CAD"), money(1999, "CAD"));
  assert.deepEqual(parseMoney("$19.99", "EUR"), usd(19.99));
  assert.deepEqual(parseMoney("Free"), usd(0));
  assert.equal(parseMoney("no price here"), undefined);
});

test("parseMoney: thousands and decimal separators by locale", () => {
  assert.deepEqual(parseMoney("$1,234"), usd(1234));          // comma thousands
  assert.deepEqual(parseMoney("€1.234"), money(123400, "EUR")); // dot thousands
  assert.deepEqual(parseMoney("€1.234.567,89"), money(123456789, "EUR"));
  assert.deepEqual(parseMoney("$1,234,567.89"), usd(1234567.89));
  assert.deepEqual(parseMoney("€ 0,99"), money(99, "EUR"));
  assert.deepEqual(parseMoney("€12,5"), money(1250, "EUR"));
  assert.deepEqual(parseMoney("1 234,56 €"), money(123456, "EUR")); // narrow no-break space (fr-FR)
});

test("detectCurrency and formatMoney", () => {
  assert.equal(detectCurrency("EUR 1,827.04"), "EUR");
  assert.equal(detectCurrency("$9.99"), "USD");
  assert.equal(detectCurrency("12.99"), undefined);
  assert.equal(formatMoney(money(198000, "JPY")), "JPY 1,980");
  assert.equal(formatMoney(money(182704, "CHF")), "CHF 1,827.04");
  assert.equal(formatMoney(usd(9.99)), "$9.99");
  assert.match(currencyNote("Amazon", "EUR"), /^Amazon showed prices in EUR from your location; set a US delivery ZIP or use a US connection\./);
});

test("Amazon search in EUR (synthetic page): offers keep EUR, never USD", async () => {
  const offers = parseAmazonSearch(await fixture("amazon/search-usb-c-cable-eur.html"), "item-1");
  assert.ok(offers.length >= 3, `parsed ${offers.length}`);
  for (const o of offers) assert.equal(o.price.currency, "EUR", o.title);
  assert.ok(offers.some((o) => o.price.cents === 1099), "EUR 10.99");
  assert.equal(foreignCurrency(offers), "EUR");
  // The USD fixture is unchanged.
  const us = parseAmazonSearch(await fixture("amazon/search-usb-c-hub.html"), "item-1");
  assert.ok(us.length > 0);
  for (const o of us) assert.equal(o.price.currency, "USD");
  assert.equal(foreignCurrency(us), undefined);
});

test("Amazon cart: data-price takes the currency the line shows", () => {
  const html = `<div id="sc-active-cart"><div data-itemtype="active" data-asin="B0TEST0001" data-quantity="1" data-price="1827.04" data-producttitle="Cable">
    <span class="a-price"><span class="a-offscreen">EUR&nbsp;1,827.04</span></span></div></div>
    <span id="sc-subtotal-amount-activecart">EUR&nbsp;1,827.04</span>`;
  const cart = parseAmazonCart(html);
  assert.deepEqual(cart.lines[0].price, money(182704, "EUR"));
  assert.deepEqual(cart.subtotal, money(182704, "EUR"));
});

test("eBay: dp1 buyer location set to the US, converted shipping read with its currency", () => {
  assert.equal(dp1WithUsBuyer("bbl/DEen-US6ec12539^"), "bbl/USen-US6ec12539^");
  assert.equal(dp1WithUsBuyer("bbl/USen-US6ec12539^"), undefined);
  assert.match(dp1WithUsBuyer(undefined, 1_800_000_000)!, /^bbl\/USen-US[0-9a-f]{8}\^$/);
  assert.match(dp1WithUsBuyer("u1f/x6ec12539^", 1_800_000_000)!, /^u1f\/x6ec12539\^bbl\/USen-US[0-9a-f]{8}\^$/);
  assert.deepEqual(parseShipping("+EUR46.80 delivery"), money(4680, "EUR"));
  assert.deepEqual(parseShipping("+$5.99 delivery"), usd(5.99));
  assert.deepEqual(parseShipping("Free delivery"), usd(0));
});

test("Target: a price text in another currency is not read as dollars", () => {
  assert.deepEqual(targetUsd("12.99"), usd(12.99));
  assert.deepEqual(targetUsd(12.99), usd(12.99));
  assert.equal(targetUsd("EUR 1,827.04")?.currency, "EUR");
});

const item = (extra: Partial<ItemRequest> = {}): ItemRequest => ({ id: "item-1", query: "usb-c cable 6 ft", description: "6 ft usb-c cable", quantity: 1, ...extra });
const eur = (store: Offer["store"], title: string, cents: number, extra: Partial<Offer> = {}): Offer =>
  offer(store, title, 0, { price: money(cents, "EUR"), shipping: money(0, "EUR"), itemId: "item-1", ...extra });

test("ranking: an offer in another currency is never ranked, even when its number is lower", () => {
  // 9,99 EUR (as cents 999) is a smaller number than $12.99: it must still not win.
  const offers = [eur("amazon", "USB-C cable 6ft", 999), offer("walmart", "USB-C cable 6ft", 12.99, { itemId: "item-1" })];
  const scored = scoreOffers(item(), offers);
  assert.equal(scored[0].offer.store, "walmart");
  const amz = scored.find((s) => s.offer.store === "amazon")!;
  assert.match(amz.excluded!, /^currency_mismatch: priced in EUR, not USD$/);
  assert.equal(amz.score, -1);
  assert.match(exclusionReason(item(), { ...offers[1], currencyMismatch: true })!, /^currency_mismatch/);
});

test("picks and totals: USD only; every offer in EUR gives no pick and a plain reason", () => {
  const req: ShoppingRequest = { prompt: "x", items: [item()], stores: ["amazon", "walmart"], budget: usd(15) };
  const mixed = [eur("amazon", "USB-C cable 6ft", 155271), offer("walmart", "USB-C cable 6ft", 7.97, { itemId: "item-1" })];
  const r = pickAll(req, mixed);
  assert.equal(r.picks.length, 1);
  assert.equal(r.picks[0].offer.store, "walmart");
  assert.deepEqual(r.total, usd(7.97));
  assert.equal(r.overBudget, false);
  assert.ok(!r.picks[0].alternatives.some((o) => o.price.currency !== "USD"), "no EUR alternative");

  const onlyEur = pickAll(req, [eur("amazon", "USB-C cable 6ft", 155271), eur("amazon", "USB-C cable 2 pack", 91443)]);
  assert.equal(onlyEur.picks.length, 0);
  assert.deepEqual(onlyEur.total, usd(0));
  assert.equal(onlyEur.overBudget, false, "EUR numbers never count against a USD budget");
  assert.match(onlyEur.unpicked[0].reason, /every offer was priced in EUR, not USD/);

  const every = pickEveryStore(req, mixed);
  assert.deepEqual(every.picks.map((p) => p.offer.store), ["walmart"]);
  assert.deepEqual(every.total, usd(7.97));
});

test("markCurrency: marks other currencies, drops a shipping cost in another currency", () => {
  const { offers, shown } = markCurrency([
    eur("amazon", "a", 100),
    offer("ebay", "b", 5, { shipping: money(4680, "EUR") }),
    offer("walmart", "c", 5),
  ]);
  assert.deepEqual(shown, ["EUR"]);
  assert.equal(offers[0].currencyMismatch, true);
  assert.equal(offers[1].currencyMismatch, undefined);
  assert.equal(offers[1].shipping, undefined, "EUR shipping on a USD price is unknown, not added");
  assert.equal(offers[2].currencyMismatch, undefined);
});

test("web plan and compare: an offer in another currency cannot be chosen and is listed last", () => {
  const req: ShoppingRequest = { prompt: "x", items: [item()], stores: ["amazon", "walmart"] };
  const w = offer("walmart", "USB-C cable 6ft", 7.97, { itemId: "item-1" });
  const a = { ...eur("amazon", "USB-C cable 6ft", 999), currencyMismatch: true };
  const picks = pickAll(req, [w, a]).picks;
  assert.throws(() => applyChoices(req, picks, [w, a], [{ itemId: "item-1", offerKey: `${a.store}|${a.url}` }]), /priced in EUR, not US dollars/);
  const rows = compareFromEvents([
    { type: "parsed", request: req },
    { type: "offers", store: "amazon", itemId: "item-1", offers: [a] },
    { type: "offers", store: "walmart", itemId: "item-1", offers: [{ ...w, store: "walmart" }, offer("walmart", "USB-C cable 2 pack", 14.97, { itemId: "item-1" })] },
  ])[0].rows;
  assert.equal(rows.at(-1)!.offer.store, "amazon");
});

test("engine: a store in EUR gets one plain note, its offers are listed, never picked or totalled", async () => {
  const amazon = new FakeAdapter("amazon", { catalog: { cable: [eur("amazon", "USB-C cable 6ft", 155271), eur("amazon", "USB-C cable 3 pack", 999)] } });
  const walmart = new FakeAdapter("walmart", { catalog: { cable: [offer("walmart", "USB-C cable 6ft", 7.97)] } });
  const dataDir = await mkdtemp(join(tmpdir(), "osa-test-"));
  const fb = fakeBrowsers();
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir, adapters: { amazon, walmart }, openBrowser: fb.open, watchLinks: false });
  const run = await agent.run("6 ft usb-c cable under $15 on amazon or walmart", { onEvent: (e) => events.push(e), until: "picks" });
  const notes = events.filter((e) => e.type === "log" && /showed prices in/.test(e.message));
  assert.equal(notes.length, 1);
  assert.ok(notes[0].type === "log" && notes[0].store === "amazon");
  assert.ok(notes[0].type === "log" && /^Amazon showed prices in EUR from your location; set a US delivery ZIP or use a US connection\./.test(notes[0].message));
  const listed = events.flatMap((e) => (e.type === "offers" && e.store === "amazon" ? e.offers : []));
  assert.equal(listed.length, 2, "EUR offers are listed, not silently dropped");
  assert.ok(listed.every((o) => o.currencyMismatch && o.price.currency === "EUR"));
  const picks = events.find((e) => e.type === "picks");
  assert.ok(picks && picks.type === "picks");
  assert.deepEqual(picks.picks.map((p) => p.offer.store), ["walmart"]);
  assert.deepEqual(picks.total, usd(7.97));
  assert.equal(amazon.calls.addToCart, 0);
  await run.close();
});

test("engine: when every store shows another currency there is no pick, a note, and a reason", async () => {
  const amazon = new FakeAdapter("amazon", { catalog: { cable: [eur("amazon", "USB-C cable 6ft", 155271)] } });
  const dataDir = await mkdtemp(join(tmpdir(), "osa-test-"));
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir, adapters: { amazon }, openBrowser: fakeBrowsers().open, watchLinks: false });
  const run = await agent.run("6 ft usb-c cable on amazon, budget $15", { onEvent: (e) => events.push(e), until: "picks" });
  const picks = events.find((e) => e.type === "picks");
  assert.ok(picks && picks.type === "picks");
  assert.equal(picks.picks.length, 0);
  assert.equal(picks.overBudget, false);
  assert.ok(events.some((e) => e.type === "log" && /showed prices in EUR/.test(e.message)));
  assert.ok(events.some((e) => e.type === "log" && /No pick for .*every offer was priced in EUR/.test(e.message)));
  await run.close();
});
