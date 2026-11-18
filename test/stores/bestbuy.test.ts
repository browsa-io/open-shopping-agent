import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import adapter, {
  chooseVariation, conditionOf, detectWall, isSignInPage, parseCart, parseProduct, parseReview, parseSearch, searchSkus, skuUrl,
} from "../../src/stores/bestbuy.js";

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/bestbuy/${name}`, import.meta.url)), "utf8");

test("bestbuy: search URL", () => {
  const u = new URL(adapter.searchUrl("hdmi cable 6 ft", "bestbuy.com"));
  assert.equal(u.hostname, "www.bestbuy.com");
  assert.equal(u.searchParams.get("st"), "hdmi cable 6 ft");
  assert.equal(skuUrl("6630902"), "https://www.bestbuy.com/site/6630902.p?skuId=6630902");
});

test("bestbuy: search cards parse; organic copy wins over the sponsored one", () => {
  const html = fx("search.html");
  const offers = parseSearch(html, "item-1");
  assert.ok(offers.length >= 1);
  const o = offers[0];
  assert.equal(o.store, "bestbuy");
  assert.equal(o.productId, "6491142");
  assert.match(o.title, /^Logitech - Signature M650 L/);
  assert.deepEqual(o.price, { cents: 3999, currency: "USD" });
  assert.deepEqual(o.rating, { stars: 4.8, count: 2604 });
  assert.equal(o.inStock, true);
  assert.equal(o.condition, "new");
  assert.equal(o.sponsored, false, "the same SKU also appears as an organic card");
  assert.deepEqual(o.shipping, { cents: 0, currency: "USD" });
  assert.equal(o.raw?.pickupText, "Pick up today");
  assert.match(o.deliveryText ?? "", /Get it tomorrow/);
  assert.match(o.url, /\/sku\/6491142$/);
});

test("bestbuy: cards whose price has not rendered are listed and filled from the pricing API", () => {
  const html = fx("search.html");
  const skus = searchSkus(html);
  const unpriced = skus.filter((s) => !s.priced).map((s) => s.sku);
  assert.ok(unpriced.length >= 3, "lazy cards have no price in the HTML");
  const before = parseSearch(html, "i").length;
  const prices = Object.fromEntries(unpriced.map((s, i) => [s, { price: { cents: 1000 + i, currency: "USD" } }]));
  const after = parseSearch(html, "i", prices);
  assert.ok(after.length > before);
  assert.ok(after.every((o) => o.price.cents > 0));
});

test("bestbuy: sponsored-only cards are flagged", () => {
  const html = `<li data-testid="sponsored-listing"><div class="sponsored-content"><div data-testid="1234567" data-product-id="1234567" class="product-list-item">
    <div class="sponsored">Sponsored</div><h3 class="product-title" title="Insignia - HDMI Cable">Insignia - HDMI Cable</h3>
    <div data-testid="price-block"><div data-testid="price-block-customer-price"><span>$9.99</span></div></div>
    <button data-testid="plp-add-to-cart-1234567">Add to cart</button></div></div></li>`;
  const [o] = parseSearch(html, "i");
  assert.equal(o.sponsored, true);
  assert.equal(o.inStock, true);
});

test("bestbuy: product page gives SKU, price, rating, stock, delivery days and colour SKUs", () => {
  const p = parseProduct(fx("product.html"));
  assert.equal(p.sku, "6630902");
  assert.deepEqual(p.price, { cents: 2299, currency: "USD" });
  assert.equal(p.condition, "new");
  assert.equal(p.inStock, true);
  assert.equal(p.buttonState, "ADD_TO_CART");
  assert.equal(p.seller, "Best Buy");
  assert.deepEqual(p.rating, { stars: 4.8, count: 163 });
  assert.equal(p.shippingDaysOut, 2);
  assert.equal(p.pickupDaysOut, 1);
  assert.equal(p.variations[0].name, "Color");
  assert.equal(p.variations[0].options.find((o) => o.state === "selected")?.name, "Graphite");
  assert.ok(p.otherOffers.every((o) => o.sku !== "6630902"), "marketplace offers are kept apart");
});

test("bestbuy: options choose a colour SKU; unknown values are reported", () => {
  const p = parseProduct(fx("product.html"));
  assert.deepEqual(chooseVariation(p, { color: "lilac" }), { sku: "6630909", expected: { Color: "Lilac" }, problems: [] });
  assert.deepEqual(chooseVariation(p, { Color: "Graphite" }), { sku: undefined, expected: { Color: "Graphite" }, problems: [] });
  assert.match(chooseVariation(p, { color: "Gold" }).problems[0], /"Gold" is not offered/);
  assert.deepEqual(chooseVariation(p, {}).problems, []);
});

test("bestbuy: cart parses SKU, options, quantity, fulfillment and the summary", () => {
  const c = parseCart(fx("cart.html"));
  assert.equal(c.lines.length, 1);
  const l = c.lines[0];
  assert.equal(l.productId, "6630902");
  assert.equal(l.title, "Logitech - M325s Wireless Optical Compact Ambidextrous Mouse - Wireless - Graphite");
  assert.deepEqual(l.options, { Color: "Graphite" });
  assert.equal(l.quantity, 1);
  assert.deepEqual(l.price, { cents: 2299, currency: "USD" });
  assert.deepEqual(c.subtotal, { cents: 2299, currency: "USD" });
  assert.deepEqual(c.shipping, { cents: 0, currency: "USD" });
  assert.deepEqual(c.tax, { cents: 152, currency: "USD" });
  assert.deepEqual(c.total, { cents: 2451, currency: "USD" });
});

test("bestbuy: checkout stops on the sign-in / guest page", () => {
  assert.equal(isSignInPage(fx("signin.html"), "https://www.bestbuy.com/identity/signin?token=x"), true);
  assert.equal(isSignInPage(fx("cart.html"), "https://www.bestbuy.com/cart"), false);
});

test("bestbuy: bot wall and queue pages are detected", () => {
  assert.equal(detectWall(fx("access-denied.html"), "Access Denied"), "denied");
  assert.equal(detectWall("<h1>You're in line</h1><p>high demand</p>", "Best Buy"), "queue");
  assert.equal(detectWall(fx("search.html"), "wireless mouse - Best Buy"), undefined);
  assert.equal(detectWall(fx("product.html"), "Logitech - Best Buy"), undefined);
});

test("bestbuy: conditions", () => {
  assert.equal(conditionOf("Open-Box Excellent"), "used");
  assert.equal(conditionOf("Geek Squad Certified Refurbished"), "refurbished");
  assert.equal(conditionOf("New"), "new");
});

test("bestbuy: review page parser reads the total and the Place Your Order button", () => {
  const html = `<div class="order-summary"><span>Subtotal</span><span>$22.99</span><span>Shipping</span><span>FREE</span>
    <span>Estimated Sales Tax</span><span>$1.52</span><span>Total</span><span>$24.51</span></div><button class="btn">Place Your Order</button>`;
  const r = parseReview(html);
  assert.deepEqual(r.total, { cents: 2451, currency: "USD" });
  assert.deepEqual(r.shipping, { cents: 0, currency: "USD" });
  assert.equal(r.placeEnabled, true);
  assert.equal(r.needs, undefined);
});
