import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import adapter, {
  amazonCheckoutState, asinFromUrl, isAmazonErrorPage, parseAmazonCart, parseAmazonProduct, parseAmazonReview, parseAmazonSearch,
} from "../../src/stores/amazon.js";
import {
  approvalMatches, jsonAfter, normOption, optionWarnings, parseDeliveryDate, parseHtml, pickVariant, qs, qsa, textOf,
} from "../../src/stores/util.js";

const fx = (name: string) => fs.readFileSync(new URL(`../fixtures/amazon/${name}`, import.meta.url), "utf8");
const NOW = new Date(2026, 10, 18, 6, 0, 0); // Nov 18 2026, when the fixtures were saved

test("html helpers: selectors, text, entities, json", () => {
  const doc = parseHtml(`<div id="a" class="x y" data-k="v1"><p>Hi &amp; <b>there</b><p>two</div><ul><li>1<li>2</ul>
    <img src="i.png"><script>var s = "<div>";</script><span data-q='a "b"'>q</span>`);
  assert.equal(qs(doc, "#a")?.attrs["data-k"], "v1");
  assert.equal(qsa(doc, "div.x.y p").length, 2);
  assert.equal(textOf(qs(doc, "#a")), "Hi & there two");
  assert.equal(qsa(doc, "ul li").length, 2);
  assert.equal(qsa(doc, "div").length, 1, "script content is not parsed as tags");
  assert.equal(qs(doc, "[data-k^=\"v\"]")?.attrs.id, "a");
  assert.equal(qs(doc, "span[data-q]")?.attrs["data-q"], "a \"b\"");
  assert.deepEqual(jsonAfter(`x "k" : {"a":[1,"}"]} y`, "\"k\""), { a: [1, "}"] });
  assert.equal(asinFromUrl("https://www.amazon.com/Anker-Hub/dp/B0BQLLB61B/ref=sr_1_1"), "B0BQLLB61B");
});

test("delivery dates and option matching", () => {
  assert.equal(parseDeliveryDate("FREE delivery Thu, Nov 20", NOW), "2026-11-20");
  assert.equal(parseDeliveryDate("Shipping, arrives tomorrow", NOW), "2026-11-19");
  assert.equal(parseDeliveryDate("Arrives Jan 3", NOW), "2027-01-03");
  assert.equal(parseDeliveryDate("Monday, November 23", NOW), "2026-11-23");
  assert.equal(parseDeliveryDate("no date here", NOW), undefined);
  assert.equal(normOption("6 Feet"), normOption("6ft"));
  const choices = [
    { id: "A", values: { Color: "Black", Size: "6 ft" } },
    { id: "B", values: { Color: "Blue", Size: "6 ft" } },
    { id: "C", values: { Color: "Blue", Size: "10 ft" } },
  ];
  assert.equal(pickVariant(choices, { color: "blue", length: "6 feet" }).id, "B");
  assert.equal(pickVariant(choices, { colour: "Black" }).id, "A");
  assert.match(pickVariant(choices, { color: "Purple" }).reason ?? "", /offered: Color: Black, Blue/);
  assert.deepEqual(optionWarnings("Amazon", { color: "Blue" }, { Color: "Blue" }), []);
  assert.match(optionWarnings("Amazon", { color: "Blue" }, { Color: "White" })[0], /did not stick, Amazon cart shows "White"/);
  assert.deepEqual(optionWarnings("Walmart", { Size: "11-in-1 USB C Laptop Hub Docking Station" }, { Size: "11-in-1 USB C Laptop Hub..." }), []);
  assert.equal(optionWarnings("Walmart", { Size: "8-in-1 USB C Hub" }, { Size: "11-in-1 USB C Laptop Hub..." }).length, 1);
});

test("approval must match the total exactly", () => {
  const approval = { store: "amazon" as const, approvedTotal: { cents: 2599, currency: "USD" }, approvedAt: "", by: "user" as const };
  assert.equal(approvalMatches({ cents: 2599, currency: "USD" }, approval), true);
  assert.equal(approvalMatches({ cents: 2600, currency: "USD" }, approval), false);
  assert.equal(approvalMatches({ cents: 2599, currency: "EUR" }, approval), false);
  assert.equal(approvalMatches(undefined, approval), false);
});

test("search: offers with ASIN, price, rating, delivery; Prime-only prices replaced", () => {
  const offers = parseAmazonSearch(fx("search-usb-c-hub.html"), "item-1", NOW);
  assert.equal(offers.length, 16);
  const first = offers[0];
  assert.equal(first.productId, "B0BQLLB61B");
  assert.equal(first.url, "https://www.amazon.com/dp/B0BQLLB61B");
  assert.match(first.title, /^Anker USB C Hub, 5-in-1/);
  assert.deepEqual(first.rating, { stars: 4.4, count: 19280 });
  // $18.99 is the Prime-member price; the regular price is $24.99.
  assert.equal(first.price.cents, 2499);
  assert.deepEqual(first.raw?.primePrice, { cents: 1899, currency: "USD" });
  assert.equal(first.deliveryDate, "2026-11-22", "non-member delivery date");
  assert.equal(first.shipping, undefined, "free shipping only over $35");
  assert.equal(first.sponsored, false);
  assert.equal(first.subscription, false);
  const ugreen = offers.find((o) => o.productId === "B0BR3M8XHK")!;
  assert.equal(ugreen.price.cents, 1399);
  assert.equal(ugreen.listPrice?.cents, 1598);
  const over35 = offers.find((o) => o.productId === "B0BY27XSJ3")!;
  assert.equal(over35.shipping?.cents, 0);
  for (const o of offers) {
    assert.equal(o.store, "amazon");
    assert.ok(o.price.cents > 0);
    assert.match(o.productId ?? "", /^[A-Z0-9]{10}$/);
  }
});

test("search: unit prices and subscribe-and-save flagged", () => {
  const offers = parseAmazonSearch(fx("search-aa-batteries.html"), "item-2", NOW);
  // 10 cards; one shows "Click to see price" (no price on the page) and is skipped.
  assert.equal(offers.length, 9);
  const b = offers.find((o) => o.productId === "B00NTCH52W")!;
  assert.equal(b.price.cents, 999);
  assert.deepEqual(b.unitPrice, { amount: { cents: 50, currency: "USD" }, per: "count" });
  assert.equal(b.subscribeAndSaveAvailable, true);
  assert.equal(b.raw?.subscribeAndSave, undefined, "moved to Offer.subscribeAndSaveAvailable");
  assert.equal(offers.filter((o) => o.subscribeAndSaveAvailable === false).length, 0, "unset rather than false");
  assert.equal(b.subscription, false, "the shown price is one-time");
  assert.equal(offers.find((o) => o.productId === "B0035LCFNQ")?.listPrice?.cents, 2175);
});

test("search: sponsored cards are flagged", () => {
  const html = `<div data-component-type="s-search-result" data-asin="B000000001"><div data-cy="title-recipe"><h2 aria-label="Ad item"><span>Ad item</span></h2></div>
    <div class="a-row"><span class="puis-label-popover-default"><span>Sponsored</span></span></div>
    <div data-cy="price-recipe"><span class="a-price"><span class="a-offscreen">$9.99</span></span></div></div>`;
  const [o] = parseAmazonSearch(html, "i");
  assert.equal(o.sponsored, true);
  assert.equal(o.price.cents, 999);
});

test("product: regular new offer, seller, delivery, variants from the twister", () => {
  const p = parseAmazonProduct(fx("product-hub-variants.html"), NOW);
  assert.equal(p.asin, "B0BQLLB61B");
  assert.equal(p.title, "Anker USB C Hub, 5-in-1 USBC to HDMI Splitter with 4K Display");
  assert.equal(p.price?.cents, 2499, "regular price, not the Prime-only $18.99");
  assert.equal(p.seller, "AnkerDirect");
  assert.equal(p.deliveryDate, "2026-11-23");
  assert.match(p.deliveryText ?? "", /FREE delivery Monday, November 23/);
  assert.equal(p.shipping, undefined);
  assert.equal(p.inStock, true);
  assert.deepEqual(p.rating, { stars: 4.4, count: 19280 });
  assert.deepEqual(p.variants, { Color: ["Black", "Blue", "Green", "Grey", "White"] });
  assert.deepEqual(p.selected, { Color: "Black" });
  assert.equal(p.hasAccordion, true);
  assert.equal(p.primeOnlyDefault, true);
  assert.equal(pickVariant(p.variantChoices!, { color: "Blue" }).id, "B0CH9KN8TB");
});

test("cart: lines, quantity, options, subtotal", () => {
  const cart = parseAmazonCart(fx("cart-one-item.html"));
  assert.equal(cart.lines.length, 1);
  const [l] = cart.lines;
  assert.equal(l.productId, "B0CH9KN8TB");
  assert.equal(l.quantity, 1);
  assert.equal(l.price.cents, 2599);
  assert.deepEqual(l.options, { Color: "Blue" });
  assert.equal(cart.subtotal?.cents, 2599);
  assert.deepEqual(cart.warnings, []);
  const empty = parseAmazonCart("<html><body><div id=\"sc-active-cart\"><div class=\"sc-your-amazon-cart-is-empty\">Your Amazon Cart is empty</div></div></body></html>");
  assert.equal(empty.lines.length, 0);
  assert.equal(empty.subtotal?.cents, 0);
  assert.deepEqual(empty.warnings, []);
  // A bot check page with the add-to-cart flyout is not the cart: no lines, a warning.
  const checkpoint = parseAmazonCart(`<form id="checkpointForm" action="/checkpoint/validate"><input type="checkbox" id="continueCheck"></form>
    <div id="ewc-content"><div data-itemtype="active" data-asin="B0CH9KN8TB" data-price="25.99" data-quantity="1"></div></div>`);
  assert.equal(checkpoint.lines.length, 0);
  assert.deepEqual(checkpoint.warnings, ["Amazon cart page did not load"]);
});

test("checkout states and review totals", () => {
  assert.equal(amazonCheckoutState("https://www.amazon.com/ap/signin?openid.return_to=x", "<form name=\"signIn\"><input id=\"ap_email\"></form>"), "signin");
  assert.equal(amazonCheckoutState("https://www.amazon.com/ap/mfa?x", "<input id=\"auth-mfa-otpcode\">"), "mfa");
  assert.equal(amazonCheckoutState("https://www.amazon.com/errors/validateCaptcha", ""), "captcha");
  assert.equal(amazonCheckoutState("https://www.amazon.com/checkout/p/p-1/x", "<body><h4>You cannot buy this item because it's out of stock</h4><p>Another seller might have a comparable offer for the same item.</p></body>"), "unavailable");
  assert.equal(amazonCheckoutState("https://www.amazon.com/gp/cart/view.html", fx("cart-one-item.html")), "unknown");
  const reviewHtml = `<div id="deliver-to-address-text"><span>Jane Doe</span><span>1 Main St</span><span>CHEYENNE, WY 82001-1234</span><span>United States</span></div>
    <div>Visa ending in 1234</div><input name="placeYourOrder1" type="submit">
    <div id="subtotals-marketplace-table"><table><tr><td>Items:</td><td>$25.99</td></tr><tr><td>Shipping &amp; handling:</td><td>$6.99</td></tr>
    <tr><td>Estimated tax to be collected:</td><td>$1.30</td></tr><tr><td>Order total:</td><td>$34.28</td></tr></table></div>`;
  assert.equal(amazonCheckoutState("https://www.amazon.com/checkout/p/x/spc", reviewHtml), "review");
  const r = parseAmazonReview(reviewHtml);
  assert.equal(r.subtotal?.cents, 2599);
  assert.equal(r.shipping?.cents, 699);
  assert.equal(r.tax?.cents, 130);
  assert.equal(r.total?.cents, 3428);
  assert.equal(r.shipTo, "CHEYENNE, WY 82001");
  assert.equal(r.paymentHint, "Visa ending in 1234");
  assert.equal(parseAmazonReview(`<div id="shipaddress">1 Main St Cheyenne, WY 82001</div>`).shipTo, "Cheyenne, WY 82001");
  const prime = `<h1>Get FREE delivery with a Prime free trial</h1><a id="prime-declineCTA" href="#">No thanks</a>`;
  assert.equal(amazonCheckoutState("https://www.amazon.com/gp/buy/primeinterstitial/handlers/display.html", prime), "membership_offer");
});

test("error page (dogs) is recognised, normal pages are not", () => {
  assert.equal(isAmazonErrorPage("", fx("error-page.html")), true);
  assert.equal(isAmazonErrorPage("Sorry! Something went wrong!", ""), true);
  assert.equal(isAmazonErrorPage("Amazon.com : usb c hub", fx("search-usb-c-hub.html")), false);
  assert.equal(parseAmazonSearch(fx("error-page.html"), "i").length, 0);
});

test("adapter shape", () => {
  assert.equal(adapter.id, "amazon");
  assert.equal(adapter.searchUrl("usb c hub", "amazon.com"), "https://www.amazon.com/s?k=usb+c+hub");
  assert.ok(adapter.details && adapter.clearCart);
});
