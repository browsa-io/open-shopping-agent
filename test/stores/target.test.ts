// Target adapter: parsers on saved redsky / carts answers, and the adapter flow on a fake page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  decodeEntities, isTargetBlock, parseTargetCart, parseTargetFulfillment, parseTargetPdp, parseTargetSearch,
  pickTargetVariant, shortAddress, target, targetShippingMinimum, targetTotals,
} from "../../src/stores/target.js";
import type { StoreContext } from "../../src/stores/adapter.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/target");
const fx = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

test("decodeEntities handles Target's escaped titles", () => {
  assert.equal(decodeEntities("Men&#39;s Odor Resistant Socks - Goodfellow &#38; Co&#8482;"), "Men's Odor Resistant Socks - Goodfellow & Co™");
  assert.equal(decodeEntities("A &amp; B &quot;C&quot;"), "A & B \"C\"");
});

test("search: one offer per TCIN, organic copy wins over the sponsored one, ratings from the parent", () => {
  const offers = parseTargetSearch(fx("search-socks.json"), "item-1", 24);
  const ids = offers.map((o) => o.productId);
  assert.equal(new Set(ids).size, ids.length, "no duplicate TCINs");
  const fotl = offers.find((o) => o.productId === "94835117")!;
  assert.equal(fotl.sponsored, false, "the same TCIN also appears organically");
  assert.equal(fotl.price.cents, 999);
  const weitzner = offers.find((o) => o.productId === "1011210514")!;
  assert.equal(weitzner.sponsored, true);
  const goodfellow = offers.find((o) => o.productId === "53059893")!;
  assert.equal(goodfellow.title.startsWith("Men's Odor Resistant Crew Socks"), true);
  assert.deepEqual(goodfellow.rating, { stars: 4.54, count: 1182 });
  assert.equal(goodfellow.raw?.parentTcin, "53098091");
  assert.ok(goodfellow.variants?.Color?.length, "variant colors from the parent summary");
  assert.match(goodfellow.url, /^https:\/\/www\.target\.com\/p\/.+\/A-53059893$/);
  for (const o of offers) {
    assert.equal(o.store, "target");
    assert.equal(o.storeDomain, "target.com");
    assert.equal(o.itemId, "item-1");
    assert.equal(o.price.currency, "USD");
    assert.equal(o.subscription, false);
  }
});

test("search: limit is respected", () => {
  assert.equal(parseTargetSearch(fx("search-tshirt.json"), "i", 2).length, 2);
});

test("fulfillment: shipping date and stock per TCIN", () => {
  const f = parseTargetFulfillment(fx("fulfillment.json"));
  const hub = f.get("95007765")!;
  assert.equal(hub.inStock, true);
  assert.equal(hub.deliveryDate, "2026-11-19");
  assert.match(hub.deliveryText!, /^Shipping: arrives Thu, Nov 19$/);
});

test("pdp: variant tree flattened, child prices and rating", () => {
  const p = parseTargetPdp(fx("pdp-tshirt.json"));
  assert.equal(p.tcin, "94732708");
  assert.deepEqual(p.options, { Size: ["S", "M", "L", "XL"] });
  assert.equal(p.variants.length, 4);
  assert.equal(p.childPrices.get("94689076")?.cents, 1299);
  assert.deepEqual(p.rating, { stars: 4.68, count: 131 });
});

test("pickTargetVariant matches options without case and reports misses", () => {
  const p = parseTargetPdp(fx("pdp-tshirt.json"));
  assert.equal(pickTargetVariant(p, { size: "l" }).tcin, "94689076");
  const miss = pickTargetVariant(p, { Size: "XXXL" }, "94689075");
  assert.equal(miss.tcin, "94689075", "keeps the listed child when nothing matches");
  assert.deepEqual(miss.unmatched, ["Size: XXXL"]);
  const socks = parseTargetPdp(fx("pdp-socks.json"));
  assert.equal(pickTargetVariant(socks, { Color: "Black" }).tcin, "53059893");
});

test("cart: lines, totals and the shipping check", () => {
  const c = parseTargetCart(fx("cart.json"));
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].productId, "95007765");
  assert.equal(c.lines[0].price.cents, 2599);
  assert.equal(c.lines[0].options?.fulfillment, "Shipping");
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(targetTotals(fx("cart.json")), {
    subtotal: { cents: 2599, currency: "USD" }, shipping: { cents: 599, currency: "USD" },
    tax: { cents: 235, currency: "USD" }, total: { cents: 3487, currency: "USD" },
  });
  const pickup = fx("cart.json");
  pickup.cart_items[0].fulfillment.type = "PICKUP";
  assert.match(parseTargetCart(pickup).warnings[0], /pickup, not shipping/);
  assert.deepEqual(parseTargetCart(fx("cart-two.json")).itemIds, ["item-95007765", "item-53059893"]);
});

test("bot check detection", () => {
  const px = '{"appId":"PXGWPp4wUS","blockScript":"https://captcha.px-cdn.net/PXGWPp4wUS/captcha.js","hostUrl":"https://collector-PXGWPp4wUS.perimeterx.net"}';
  assert.equal(isTargetBlock(435, px), true);
  assert.equal(isTargetBlock(200, px), true);
  assert.equal(isTargetBlock(200, '{"data":{"search":{}}}'), false);
  assert.equal(isTargetBlock(404, "not found"), false);
});

test("shortAddress never includes the street", () => {
  assert.equal(shortAddress({ address_line1: "1 Main St", city: "Christiana", state: "DE", zip_code: "19701-1234" }), "Christiana, DE 19701");
});

// ---- adapter flow on a fake page (fetch answered from fixtures) ----

interface Call { url: string; method: string; body?: unknown }

function fakeCtx(routes: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const doc = {
    cookie: "visitorId=TESTVISITOR; fiatsCookie=DSI_2764%7CDSN_Test%7CDSZ_19701; GuestLocation=19701%7C39.66%7C-75.6%7CDE%7CUS",
    documentElement: { innerHTML: '"apiKey":"9f36aeafbe60771e321a7cc95a78140772ab3e96"' },
    body: { innerText: "Target" },
  };
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const c: Call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = routes(c);
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)), headers: { get: () => null } };
  };
  let url = "https://www.target.com/";
  const page = {
    url: () => url,
    goto: async (u: string) => { url = u; return null; },
    waitForTimeout: async () => {},
    title: async () => "Target",
    evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => {
      const g = globalThis as Record<string, unknown>;
      const saved = { fetch: g.fetch, document: g.document };
      g.fetch = fetchImpl; g.document = doc;
      // Run the callback as the page would: rebuilt from its source, so module helpers (like
      // esbuild's __name) are not in scope and a callback that needs them fails here too.
      const isolated = new Function(`return (${fn.toString()})`)() as (a: unknown) => unknown;
      try { return await isolated(arg); } finally { g.fetch = saved.fetch; g.document = saved.document; }
    },
    locator: () => ({ count: async () => 0, first: () => ({ boundingBox: async () => null, isVisible: async () => false, waitFor: async () => { throw new Error("none"); }, innerText: async () => "" }) }),
    keyboard: { press: async () => {} },
  };
  const logs: string[] = [];
  const ctx = {
    store: "target", domain: "target.com", page, agentId: "agt_test",
    aiTask: async () => { throw new Error("aiTask must not be called"); },
    liveLink: async () => "https://live.example/one-time",
    log: (m: string) => logs.push(m),
    signal: new AbortController().signal,
  } as unknown as StoreContext;
  return { ctx, calls, logs };
}

test("adapter search: API answer parsed, delivery dates merged, key and store from the page", async () => {
  const { ctx, calls } = fakeCtx((c) => {
    if (c.url.includes("plp_search_v2")) return { status: 200, body: fx("search-socks.json") };
    if (c.url.includes("product_summary_with_fulfillment_v1")) {
      const f = fx("fulfillment.json");
      f.data.product_summaries[0].tcin = "94835117";
      return { status: 200, body: f };
    }
    return { status: 404, body: "" };
  });
  const offers = await target.search(ctx, { id: "item-1", query: "mens crew socks", description: "socks", quantity: 1 }, 3);
  assert.equal(offers.length, 3);
  assert.equal(offers[0].deliveryDate, "2026-11-19");
  const plp = calls.find((c) => c.url.includes("plp_search_v2"))!;
  assert.match(plp.url, /pricing_store_id=2764/);
  assert.match(plp.url, /visitor_id=TESTVISITOR/);
  assert.match(plp.url, /keyword=mens%20crew%20socks/);
});

test("adapter addToCart (quantity 2 uses the cart API), reads the cart back and checks shipping", async () => {
  let cart = { cart_items: [] as unknown[], summary: {} };
  const { ctx, calls } = fakeCtx((c) => {
    if (c.url.includes("cart_views")) return { status: 200, body: cart };
    if (c.url.includes("/cart_items") && c.method === "POST") {
      const full = fx("cart.json");
      full.cart_items[0].quantity = 2;
      full.cart_items[0].item_summary.total_product = 51.98;
      cart = full;
      return { status: 201, body: {} };
    }
    return { status: 404, body: "" };
  });
  const result = await target.addToCart(ctx, {
    store: "target", storeDomain: "target.com", itemId: "i", title: "Anker hub", url: "https://www.target.com/p/-/A-95007765",
    productId: "95007765", price: { cents: 2599, currency: "USD" }, inStock: true,
  }, 2);
  const post = calls.find((c) => c.method === "POST")!;
  assert.deepEqual(post.body, { cart_item: { item_channel_id: "10", tcin: "95007765", quantity: 2 }, cart_type: "REGULAR", channel_id: "10", shopping_context: "DIGITAL" });
  assert.equal(result.lines[0].quantity, 2);
  assert.deepEqual(result.warnings, []);
});

test("adapter: a bot check that does not clear gives a clear error", async (t) => {
  // The adapter waits on the clock for the challenge (2 x 12 s). The fake page's waits move a
  // mocked clock instead, so this takes milliseconds and not 24 s of real time.
  t.mock.timers.enable({ apis: ["Date"] });
  const px = '{"appId":"PX","blockScript":"https://captcha.px-cdn.net/PX/captcha.js"}';
  const { ctx } = fakeCtx(() => ({ status: 435, body: px }));
  (ctx.page as unknown as { waitForTimeout: (ms: number) => Promise<void> }).waitForTimeout = async (ms) => { t.mock.timers.tick(Math.max(1, ms || 0)); };
  await assert.rejects(() => target.readCart(ctx), /bot check .* did not clear/);
});

test("adapter reviewCheckout: a guest gets needsUser sign_in with a live link and the cart totals", async () => {
  const { ctx } = fakeCtx((c) => (c.url.includes("cart_views") ? { status: 200, body: fx("cart.json") } : { status: 404, body: "" }));
  // The fake page has no sign-in field; make the sign-in sheet appear.
  (ctx.page as unknown as { locator: (s: string) => unknown }).locator = (s: string) => ({ count: async () => 0,
    first: () => ({
      boundingBox: async () => null,
      isVisible: async () => s.includes("username"),
      waitFor: async () => { throw new Error("none"); },
      innerText: async () => "",
      scrollIntoViewIfNeeded: async () => {},
    }),
  });
  const r = await target.reviewCheckout(ctx);
  assert.equal(r.total.cents, 3487);
  assert.equal(r.needsUser?.reason, "sign_in");
  assert.equal(r.needsUser?.liveUrl, "https://live.example/one-time");
});

test("adapter placeOrder aborts when the total changed", async () => {
  const { ctx } = fakeCtx((c) => (c.url.includes("/cart?") ? { status: 200, body: fx("cart.json") } : { status: 404, body: "" }));
  await (ctx.page as unknown as { goto: (u: string) => Promise<void> }).goto("https://www.target.com/checkout");
  const r = await target.placeOrder(ctx, { store: "target", approvedTotal: { cents: 3000, currency: "USD" }, approvedAt: new Date().toISOString(), by: "user" });
  assert.equal(r.placed, false);
  assert.match(r.confirmationText!, /Not placed: Target's total is now 34.87, approved 30.00/);
});

test("target: the shipping minimum sheet becomes a clear hand-off message", () => {
  const text = "Minimum not met\nOnly ships with $35 orders\nAdd $11.02 to your subtotal to qualify for shipping.\nChange all to Order Pickup";
  assert.match(targetShippingMinimum(text)!, /orders of \$35 or more \(add \$11\.02\)/);
  assert.equal(targetShippingMinimum("Cart\nCheck out"), undefined);
});
