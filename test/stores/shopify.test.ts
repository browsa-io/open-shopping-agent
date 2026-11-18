// Generic Shopify adapter: parsers on saved answers from four real stores, and the adapter flow on
// a fake page whose fetch() answers from those fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  handleFromUrl, isShopifyCart, parseCheckoutRows, parseProductJs, parseProductsJson, parseShopifyCart, parseSuggest,
  pickShopifyVariant, productUrl, ratingFromHtml, shopify,
} from "../../src/stores/shopify.js";
import type { StoreContext } from "../../src/stores/adapter.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/shopify");
const fx = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const STORES = ["allbirds_com", "brooklinen_com", "deathwishcoffee_com", "kith_com"];

test("suggest: offers from every saved store", () => {
  for (const s of STORES) {
    const origin = `https://www.${s.replace("_", ".")}`;
    const offers = parseSuggest(fx(`${s}-suggest.json`), origin, "item-1", "USD", 10);
    assert.ok(offers.length >= 3, s);
    for (const o of offers) {
      assert.equal(o.store, "shopify");
      assert.ok(o.price.cents > 0, `${s} price`);
      assert.ok(!o.url.includes("_pos="), "tracking stripped");
      assert.ok(o.url.startsWith(origin + "/products/"), o.url);
      assert.ok(o.raw?.handle);
    }
  }
  const ab = parseSuggest(fx("allbirds_com-suggest.json"), "https://www.allbirds.com", "i", "USD")[0];
  assert.equal(ab.storeDomain, "allbirds.com");
  assert.equal(ab.price.cents, 11000);
  assert.equal(ab.url, "https://www.allbirds.com/products/mens-wool-runners");
});

test("products.json fallback filters by the query words", () => {
  const offers = parseProductsJson(fx("deathwishcoffee_com-products.json"), "valhalla java", "https://www.deathwishcoffee.com", "i", "USD", 5);
  assert.ok(offers.length >= 1);
  assert.match(offers[0].title, /Valhalla/i);
  assert.equal(parseProductsJson(fx("deathwishcoffee_com-products.json"), "zzzz nothing", "https://x", "i", "USD").length, 0);
});

test("product.js: options and variants (two options on Death Wish)", () => {
  const p = parseProductJs(fx("deathwishcoffee_com-product.json"), "USD");
  assert.deepEqual(Object.keys(p.options), ["Type", "Size"]);
  assert.equal(p.variants[0].price.cents, 1999);
  assert.deepEqual(p.variants[0].options, { Type: "Ground", Size: "1 lb" });
  assert.equal(p.hasSellingPlans, true, "Death Wish offers subscriptions");
  assert.equal(p.requiresSellingPlan, false, "but one-time purchase is allowed");
});

test("pickShopifyVariant: exact options, case-insensitive, sold-out skipped, misses reported", () => {
  const dw = parseProductJs(fx("deathwishcoffee_com-product.json"), "USD");
  const v = pickShopifyVariant(dw, { type: "whole bean", size: "2 LBS" });
  assert.deepEqual(v.variant?.options, { Type: "Whole Bean", Size: "2 lbs" });
  assert.deepEqual(v.unmatched, []);
  const ab = parseProductJs(fx("allbirds_com-product.json"), "USD");
  const none = pickShopifyVariant(ab, undefined);
  assert.equal(none.variant?.available, true, "size 8 is sold out, so the first in-stock size is chosen");
  const miss = pickShopifyVariant(ab, { Size: "99" });
  assert.deepEqual(miss.unmatched, ["Size: 99"]);
  const alias = pickShopifyVariant(parseProductJs(fx("brooklinen_com-product.json"), "USD"), { Colour: "Slate" });
  assert.equal(alias.variant?.options.Color, "Slate", "option name differs, value still matches");
});

test("cart.js parsed with currency and options", () => {
  for (const s of STORES) assert.equal(isShopifyCart(fx(`${s}-cart.json`)), true, s);
  const c = parseShopifyCart(fx("deathwishcoffee_com-cart.json"), "deathwishcoffee.com", "https://www.deathwishcoffee.com");
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].price.cents, 1999);
  assert.deepEqual(c.lines[0].options, { Type: "Ground", Size: "1 lb" });
  assert.equal(c.lines[0].productId, "32485212061751");
  assert.equal(c.subtotal?.cents, 1999);
  const kith = parseShopifyCart(fx("kith_com-cart.json"), "kith.com");
  assert.equal(kith.subtotal?.currency, "EUR");
  assert.equal(isShopifyCart({ items: [] }), false);
});

test("checkout rows (as read from Shopify's order summary)", () => {
  const rows = fx("checkout-rows.json") as [string, string][];
  const t = parseCheckoutRows(rows);
  assert.deepEqual(t.subtotal, { cents: 1999, currency: "USD" });
  assert.equal(t.shipping, undefined, "'Enter shipping address' is not a price");
  assert.deepEqual(t.total, { cents: 1999, currency: "USD" });
  const full = parseCheckoutRows([["Subtotal", "$40.00"], ["Shipping", "FREE"], ["Estimated taxes", "$3.20"], ["Total", "USD $43.20"]]);
  assert.deepEqual(full, { subtotal: { cents: 4000, currency: "USD" }, shipping: { cents: 0, currency: "USD" }, tax: { cents: 320, currency: "USD" }, total: { cents: 4320, currency: "USD" } });
});

test("rating from JSON-LD", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"X","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.7","reviewCount":"1234"}}</script>`;
  assert.deepEqual(ratingFromHtml(html), { stars: 4.7, count: 1234 });
  assert.equal(ratingFromHtml("<html></html>"), undefined);
});

test("url helpers", () => {
  assert.equal(handleFromUrl("https://x.com/products/mens-wool-runners?variant=1"), "mens-wool-runners");
  assert.equal(handleFromUrl("https://x.com/collections/all"), undefined);
  assert.equal(productUrl("https://x.com", "/products/a?_pos=1", "a"), "https://x.com/products/a");
});

// ---- adapter flow on a fake page ----

interface Call { path: string; method: string; body?: unknown }

function fakeShop(opts: { shopify?: Record<string, unknown> | null; routes: (c: Call) => { status: number; body: unknown } }) {
  const calls: Call[] = [];
  let url = "about:blank";
  const win = { Shopify: opts.shopify === undefined ? { shop: "test.myshopify.com", country: "US", currency: { active: "USD" } } : opts.shopify };
  const fetchImpl = async (p: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const c: Call = { path: p, method: init?.method ?? "GET", body: init?.body && init.headers?.["Content-Type"] === "application/json" ? JSON.parse(init.body) : init?.body };
    calls.push(c);
    const r = opts.routes(c);
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)), headers: { get: () => null } };
  };
  const page = {
    url: () => url,
    goto: async (u: string) => { url = u.endsWith("/") ? u.replace("://", "://www.") : u; return null; },
    reload: async () => null,
    waitForTimeout: async () => {},
    title: async () => "Store",
    evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => {
      const g = globalThis as Record<string, unknown>;
      const saved = { fetch: g.fetch, window: g.window, document: g.document };
      g.fetch = fetchImpl; g.window = win; g.document = { body: { innerText: "" }, querySelectorAll: () => [], querySelector: () => null };
      // Run the callback as the page would: rebuilt from its source, so module helpers (like
      // esbuild's __name) are not in scope and a callback that needs them fails here too.
      const isolated = new Function(`return (${fn.toString()})`)() as (a: unknown) => unknown;
      try { return await isolated(arg); } finally { g.fetch = saved.fetch; g.window = saved.window; g.document = saved.document; }
    },
    locator: () => ({ first: () => ({ isVisible: async () => false, waitFor: async () => {} }), filter: () => ({ first: () => ({ waitFor: async () => {} }) }) }),
  };
  const ctx = {
    store: "shopify", domain: "deathwishcoffee.com", page, agentId: "agt_test",
    aiTask: async () => { throw new Error("aiTask must not be called"); },
    liveLink: async () => "https://live.example/one-time",
    log: () => {},
    signal: new AbortController().signal,
  } as unknown as StoreContext;
  return { ctx, calls };
}

test("adapter search uses suggest.json on the store's own origin", async () => {
  const { ctx, calls } = fakeShop({ routes: (c) => (c.path === "/cart.js" ? { status: 200, body: fx("deathwishcoffee_com-cart.json") } : c.path.startsWith("/search/suggest.json") ? { status: 200, body: fx("deathwishcoffee_com-suggest.json") } : { status: 404, body: "" }) });
  const offers = await shopify.search(ctx, { id: "item-1", query: "ground coffee", description: "coffee", quantity: 1 }, 2);
  assert.equal(offers.length, 2);
  assert.equal(offers[0].storeDomain, "deathwishcoffee.com");
  assert.match(calls.find((c) => c.path.startsWith("/search"))!.path, /q=ground%20coffee&resources\[type\]=product&resources\[limit\]=2/);
});

test("adapter search falls back to products.json when suggest is missing", async () => {
  const { ctx } = fakeShop({ routes: (c) => (c.path === "/cart.js" ? { status: 200, body: fx("deathwishcoffee_com-cart.json") } : c.path.startsWith("/products.json") ? { status: 200, body: fx("deathwishcoffee_com-products.json") } : { status: 404, body: "" }) });
  const offers = await shopify.search(ctx, { id: "i", query: "valhalla", description: "", quantity: 1 }, 3);
  assert.ok(offers.length >= 1);
  assert.match(offers[0].title, /Valhalla/);
});

test("adapter addToCart picks the variant for the options and posts it without a selling plan", async () => {
  let cart = { ...fx("deathwishcoffee_com-cart.json"), items: [], item_count: 0, total_price: 0 };
  const { ctx, calls } = fakeShop({
    routes: (c) => {
      if (c.path.startsWith("/products/medium-roast.js")) return { status: 200, body: fx("deathwishcoffee_com-product.json") };
      if (c.path === "/cart.js") return { status: 200, body: cart };
      if (c.path === "/cart/add.js") {
        const full = fx("deathwishcoffee_com-cart.json");
        const v = fx("deathwishcoffee_com-product.json").variants.find((x: { id: number }) => x.id === (c.body as { items: { id: number }[] }).items[0].id);
        full.items[0].variant_id = v.id;
        full.items[0].options_with_values = [{ name: "Type", value: v.options[0] }, { name: "Size", value: v.options[1] }];
        cart = full;
        return { status: 200, body: { items: [] } };
      }
      return { status: 404, body: "" };
    },
  });
  const res = await shopify.addToCart(ctx, {
    store: "shopify", storeDomain: "deathwishcoffee.com", itemId: "i", title: "Medium Roast", url: "https://www.deathwishcoffee.com/products/medium-roast",
    price: { cents: 1999, currency: "USD" }, inStock: true, raw: { handle: "medium-roast" },
  }, 1, { Type: "Whole Bean", Size: "1 lb" });
  const add = calls.find((c) => c.path === "/cart/add.js")!;
  const item = (add.body as { items: Record<string, unknown>[] }).items[0];
  assert.equal(item.quantity, 1);
  assert.equal(item.selling_plan, undefined);
  assert.deepEqual(res.lines[0].options, { Type: "Whole Bean", Size: "1 lb" });
  assert.deepEqual(res.warnings, []);
});

test("adapter refuses a non-Shopify domain with a clear error", async () => {
  const { ctx } = fakeShop({ shopify: null, routes: () => ({ status: 404, body: "<!doctype html><html></html>" }) });
  await assert.rejects(() => shopify.readCart(ctx), /is not a Shopify online store/);
});

test("adapter refuses a custom front end that loads Shopify's scripts but has no storefront cart", async () => {
  // ruggable.com, seen live: window.Shopify exists, /cart.js and /search/suggest.json answer the site's HTML.
  const { ctx } = fakeShop({ routes: () => ({ status: 200, body: "<!DOCTYPE html><html><head></head></html>" }) });
  await assert.rejects(() => shopify.search(ctx, { id: "x", query: "rug", description: "", quantity: 1 }, 3), /is not a Shopify online store/);
});

test("adapter reviewCheckout returns needsUser when contact and address are empty", async () => {
  const { ctx } = fakeShop({ routes: (c) => (c.path === "/cart.js" ? { status: 200, body: fx("deathwishcoffee_com-cart.json") } : { status: 404, body: "" }) });
  // The checkout page: summary rows and empty email/address fields.
  const page = ctx.page as unknown as { evaluate: (fn: (a: unknown) => unknown, a?: unknown) => Promise<unknown> };
  const base = page.evaluate;
  page.evaluate = async (fn, a) => {
    const src = String(fn);
    if (src.includes('[role="row"]')) return fx("checkout-rows.json");
    if (src.includes("address-line1")) return { email: true, address: true, card: true };
    return base(fn, a);
  };
  const r = await shopify.reviewCheckout(ctx);
  assert.equal(r.total.cents, 1999);
  assert.equal(r.subtotal?.cents, 1999);
  assert.equal(r.needsUser?.reason, "address");
  assert.equal(r.needsUser?.liveUrl, "https://live.example/one-time");
});
