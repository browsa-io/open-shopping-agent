// Order page readers per store, on hand-made extracts of confirmation and order pages
// (test/orders/fixtures/pages.json). No store is contacted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { StoreId } from "../../src/core/types.js";
import { ORDER_PAGES, type PageExtract, type TrackingInfo } from "../../src/orders/index.js";
import { deliveryLine, statusFrom, trackingNumberFrom } from "../../src/orders/common.js";

const pages = JSON.parse(readFileSync(new URL("./fixtures/pages.json", import.meta.url), "utf8")) as Record<StoreId, Record<string, PageExtract>>;

const DOMAIN: Record<StoreId, string> = { amazon: "amazon.com", walmart: "walmart.com", ebay: "ebay.com", bestbuy: "bestbuy.com", target: "target.com", shopify: "satechi.com" };

const CONFIRMED: Record<StoreId, { orderId: string; orderUrl?: string; total?: number; text?: RegExp }> = {
  amazon: { orderId: "111-2222222-3333333", orderUrl: "https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333&ref=ppx_yo_dt_b", total: 3209, text: /^Order placed, thanks$/ },
  walmart: { orderId: "2000123-45678901", orderUrl: "https://www.walmart.com/orders/200012345678901?storePurchase=false", total: 5318, text: /^Thanks for your order$/ },
  ebay: { orderId: "12-34567-89012", orderUrl: "https://order.ebay.com/ord/show?orderId=12-34567-89012#/", total: 1707, text: /^Order confirmed$/ },
  bestbuy: { orderId: "BBY01-806712345678", orderUrl: "https://www.bestbuy.com/profile/ss/orders/order-details/BBY01-806712345678/view", total: 4598, text: /^Thank you for your order$/ },
  target: { orderId: "912001234567", orderUrl: "https://www.target.com/orders/912001234567", total: 3833, text: /^Thanks for your order$/ },
  shopify: { orderId: "KX4PZT2N9", orderUrl: "https://satechi.com/checkouts/c/2b3c4d5e6f/thank-you", total: 4197, text: /^Your order is confirmed$/ },
};

const TRACKED: Record<StoreId, TrackingInfo> = {
  amazon: { status: "Shipped", deliveryText: "Arriving Thursday", carrier: "UPS", trackingNumber: "1Z999AA10123456784", trackingUrl: "https://www.amazon.com/progress-tracker/package/ref=ppx_od_dt_b_track_package?orderId=111-2222222-3333333&shipmentId=A1" },
  walmart: { status: "Shipped", deliveryText: "Arrives by Fri, Nov 22", carrier: "FedEx", trackingNumber: "771234567890", trackingUrl: "https://www.walmart.com/orders/200012345678901/track?shipment=1" },
  ebay: { status: "Delivered", deliveryText: "Delivered on Mon, Nov 24", carrier: "USPS", trackingNumber: "9400111899223456789012", trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223456789012" },
  bestbuy: { status: "Preparing", deliveryText: "Estimated delivery: Tue, Nov 25" },
  target: { status: "Out for delivery", deliveryText: "Arriving today", carrier: "UPS", trackingNumber: "1Z999AA10123456784", trackingUrl: "https://www.ups.com/track?tracknum=1Z999AA10123456784" },
  shopify: { status: "In transit", carrier: "USPS", trackingNumber: "9400111899223456789012", trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223456789012" },
};

for (const store of Object.keys(CONFIRMED) as StoreId[]) {
  const a = ORDER_PAGES[store];

  test(`${store}: the confirmation page gives the order number, order page and total`, () => {
    const c = a.confirmation(pages[store].confirmation, DOMAIN[store]);
    const want = CONFIRMED[store];
    assert.ok(c, "a confirmation");
    assert.equal(c.orderId, want.orderId);
    assert.equal(c.orderUrl, want.orderUrl);
    assert.equal(c.total?.cents, want.total);
    if (want.text) assert.match(c.confirmationText ?? "", want.text);
    assert.doesNotMatch(JSON.stringify(c), /Sam|Main St/, "no names or addresses from the page");
  });

  test(`${store}: the order page gives status, carrier and tracking`, () => {
    assert.deepEqual(a.tracking(pages[store].order, DOMAIN[store]), TRACKED[store]);
  });

  test(`${store}: a sign-in page is reported as sign-in, not as an order`, () => {
    assert.deepEqual(a.tracking(pages[store].signIn, DOMAIN[store]), { signIn: true });
    assert.equal(a.confirmation(pages[store].signIn, DOMAIN[store]), undefined);
  });

  test(`${store}: orders page and order page links`, () => {
    assert.match(a.ordersUrl(DOMAIN[store]), /^https:\/\//);
    const u = a.orderUrl(CONFIRMED[store].orderId, DOMAIN[store]);
    if (store === "shopify") assert.equal(u, undefined);
    else assert.match(u!, /^https:\/\/[^/]+\//);
  });
}

test("a checkout review page or a confirmation without an order number is not a confirmation", () => {
  assert.equal(ORDER_PAGES.amazon.confirmation(pages.amazon.review, "amazon.com"), undefined);
  const noNumber = { url: "https://www.target.com/co-thankyou", text: "Thanks for your order!\nWe'll email you.", links: [] };
  assert.equal(ORDER_PAGES.target.confirmation(noNumber, "target.com"), undefined);
  // "Order summary" is not an order number.
  const summary = { url: "https://shop.example/checkouts/c/x/thank-you", text: "Thank you for your order\nOrder summary\nTotal $10.00", links: [] };
  assert.equal(ORDER_PAGES.shopify.confirmation(summary, "shop.example"), undefined);
});

test("common readers: status, delivery line and tracking numbers", () => {
  assert.equal(statusFrom("Your package was delivered"), "Delivered");
  assert.equal(statusFrom("This order was cancelled"), "Cancelled");
  assert.equal(statusFrom("Shipping address\nReturn or replace items"), undefined);
  assert.equal(deliveryLine("Arriving Nov 24 - 26\nShipped"), "Arriving Nov 24 - 26");
  assert.equal(deliveryLine("arriving tomorrow"), "arriving tomorrow");
  assert.equal(trackingNumberFrom("Package 1Z12345E0205271688 on the way"), "1Z12345E0205271688");
  assert.equal(trackingNumberFrom("Tracking ID: TBA123456789000"), "TBA123456789000");
  assert.equal(trackingNumberFrom("Order summary"), undefined);
});

test("only https links are kept from a page", async () => {
  const { extractPage } = await import("../../src/orders/common.js");
  const fake = { url: () => "https://x.example/", evaluate: async () => ({ title: "", text: "t", links: [{ text: "a", href: "javascript:alert(1)" }, { text: "b", href: "http://x.example/" }, { text: "c", href: "https://x.example/ok" }] }) };
  const p = await extractPage(fake as never);
  assert.deepEqual(p.links.map((l) => l.href), ["https://x.example/ok"]);
});
