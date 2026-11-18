import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { pickVariant } from "../../src/stores/util.js";
import adapter, {
  parseWalmartCart, parseWalmartProduct, parseWalmartReview, parseWalmartSearch, walmartCheckoutState, walmartIdFromUrl,
} from "../../src/stores/walmart.js";

const fx = (name: string) => fs.readFileSync(new URL(`../fixtures/walmart/${name}`, import.meta.url), "utf8");
const NOW = new Date(2026, 10, 18, 6, 0, 0);

test("search: items from __NEXT_DATA__, deduped, sponsored flagged", () => {
  const offers = parseWalmartSearch(fx("search-usb-c-hub.html"), "item-1", NOW);
  assert.equal(offers.length, 27, "36 tiles, 9 repeats");
  assert.equal(new Set(offers.map((o) => o.productId)).size, offers.length, "no duplicate item ids");
  const vivitar = offers.find((o) => o.productId === "701987471")!;
  assert.equal(vivitar.sponsored, true);
  assert.equal(vivitar.price.cents, 2988);
  assert.equal(vivitar.seller, "Walmart.com");
  assert.deepEqual(vivitar.rating, { stars: 4.2, count: 621 });
  assert.equal(vivitar.deliveryText, "Shipping, arrives tomorrow");
  assert.equal(vivitar.deliveryDate, "2026-11-19");
  assert.equal(vivitar.inStock, true);
  assert.match(vivitar.url, /^https:\/\/www\.walmart\.com\/ip\/.+\/701987471$/);
  const onn = offers.find((o) => o.productId === "12809503648")!;
  assert.equal(onn.shipping?.cents, 0, "Free shipping badge");
  assert.equal(onn.deliveryText, "Free shipping, arrives tomorrow");
  const plugable = offers.find((o) => o.productId === "2312504982")!;
  assert.equal(plugable.listPrice?.cents, 1995);
  // Seen sponsored first and organic later: kept once, not sponsored.
  const anker = offers.find((o) => o.productId === "18188369252")!;
  assert.equal(anker.sponsored, false);
  const subs = offers.find((o) => o.productId === "2036951908")!;
  assert.equal(subs.subscribeAndSaveAvailable, true);
  assert.equal(subs.raw?.subscribeAndSave, undefined);
  assert.equal(subs.subscription, false);
  const ugreen = offers.find((o) => o.productId === "1451098911");
  if (ugreen) assert.ok(ugreen.variants && Object.keys(ugreen.variants).length === 1);
  for (const o of offers) { assert.equal(o.store, "walmart"); assert.ok(o.price.cents > 0); }
});

test("product: price, seller, delivery, variants mapped to item ids", () => {
  const p = parseWalmartProduct(fx("product-hub-variants.html"));
  assert.equal(p.usItemId, "718006726");
  assert.equal(p.price?.cents, 1295);
  assert.equal(p.seller, "SABRENT");
  assert.equal(p.deliveryText, "Free shipping, arrives by Sat, Nov 21 - Mon, Nov 23");
  assert.equal(p.deliveryDate, "2026-11-23");
  assert.equal(p.shipping?.cents, 0);
  assert.equal(p.inStock, true);
  assert.deepEqual(p.variants, { Edition: ["5 PORT", "6 PORT"] });
  assert.deepEqual(p.selected, { Edition: "5 PORT" });
  assert.equal(pickVariant(p.variantChoices!, { edition: "6 port" }).id, "702801513");
  assert.equal(pickVariant(p.variantChoices!, { ports: "6 PORT" }).id, "702801513", "key unknown, matched by value");
  assert.ok(pickVariant(p.variantChoices!, { edition: "8 PORT" }).reason);
});

test("cart: line, options, quantity, subtotal", () => {
  const cart = parseWalmartCart(fx("cart-one-item.html"));
  assert.equal(cart.lines.length, 1);
  const [l] = cart.lines;
  assert.equal(l.productId, "702801513");
  assert.equal(l.title, "SABRENT HB-TC6C USB Type-C Hub Laptop Docking Station");
  assert.equal(l.quantity, 1);
  assert.equal(l.price.cents, 3525);
  assert.deepEqual(l.options, { Edition: "6 PORT" });
  assert.equal(cart.subtotal?.cents, 3525);
  assert.equal(parseWalmartCart("<html><body>Your cart is empty</body></html>").lines.length, 0);
});

test("cart: sale price is the current price, not the was-price; bare Subtotal label", () => {
  const cart = parseWalmartCart(fx("cart-sale-item.html"));
  assert.equal(cart.lines.length, 1);
  const [l] = cart.lines;
  assert.equal(l.productId, "19210800832");
  assert.equal(l.price.cents, 3899, "not the $150.00 was-price");
  assert.equal(l.options?.Size, "11-in-1 USB C Laptop Hub...", "the cart cuts long option values");
  assert.equal(cart.subtotal?.cents, 3899);
});

test("checkout states and review", () => {
  assert.equal(walmartCheckoutState("https://identity.walmart.com/account/login?client_id=x", fx("checkout-signin.html")), "signin");
  assert.equal(walmartCheckoutState("https://www.walmart.com/blocked?url=x", ""), "captcha");
  const review = `<div data-testid="shipping-address"><span>Jane Doe</span><span>1 Main St</span><span>Cheyenne, WY 82001</span></div>
    <div>Visa ending in 4242</div><div>Subtotal (1 item) $35.25</div><div>Shipping Free</div><div>Est. taxes $1.41</div>
    <div>Total $36.66</div><button data-automation-id="place-order-button">Place order</button>`;
  assert.equal(walmartCheckoutState("https://www.walmart.com/checkout/review-order", review), "review");
  const r = parseWalmartReview(review);
  assert.equal(r.subtotal?.cents, 3525);
  assert.equal(r.shipping?.cents, 0);
  assert.equal(r.tax?.cents, 141);
  assert.equal(r.total?.cents, 3666);
  assert.equal(r.shipTo, "Cheyenne, WY 82001");
  assert.equal(r.paymentHint, "Visa ending in 4242");
  const wplus = `<h2>Try Walmart+ free for 30 days</h2><button>No thanks</button>`;
  assert.equal(walmartCheckoutState("https://www.walmart.com/checkout", wplus), "membership_offer");
});

test("adapter shape and ids", () => {
  assert.equal(adapter.id, "walmart");
  assert.equal(adapter.searchUrl("hdmi cable 6 ft", "walmart.com"), "https://www.walmart.com/search?q=hdmi+cable+6+ft");
  assert.equal(walmartIdFromUrl("https://www.walmart.com/ip/Sabrent-Hub/718006726?classType=REGULAR"), "718006726");
  assert.equal(walmartIdFromUrl("/ip/702801513"), "702801513");
});
