// Shop catalog source against a mocked MCP endpoint (a local HTTP server): the requests it sends,
// how answers become Shopify offers, sign-in refusals, protocol fallback, and the engine wiring.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ShopCatalog, ShopCatalogAuthError, catalogOffers, numericId, parseRpc, shopCatalogEnabled, toolData } from "../../src/core/shop-catalog.js";
import { ShoppingAgent } from "../../src/core/engine.js";
import type { Offer, RunEvent } from "../../src/core/types.js";
import { FakeAdapter, fakeBrowsers, offer } from "./fake-adapter.js";

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "shop-catalog", name), "utf8"));

type Mode = "ok" | "auth" | "sse" | "old" | "tool-auth" | "cad";
interface Seen { headers: IncomingHttpHeaders; body: any }
let mode: Mode = "ok";
const seen: Seen[] = [];
let url = "";
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    seen.push({ headers: req.headers, body });
    const reply = (status: number, msg: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(type === "text/event-stream" ? `event: message\ndata: ${JSON.stringify(msg)}\n\n` : JSON.stringify(msg));
    };
    if (mode === "auth") return reply(401, { error: "unauthorized" });
    if (mode === "old") {
      // A server on the older revision: initialize first, then calls carry the session.
      if (req.headers["mcp-protocol-version"] !== "2025-06-18") {
        return reply(200, { jsonrpc: "2.0", id: body.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2025-06-18"] } } });
      }
      if (body.method === "initialize") { res.setHeader("mcp-session-id", "s-1"); return reply(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }); }
      if (body.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      if (req.headers["mcp-session-id"] !== "s-1") return reply(400, { error: "no session" });
    }
    if (body.method !== "tools/call") return reply(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    if (mode === "tool-auth") {
      return reply(200, { jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "auth_required", message: "Not signed in" } }) }] } });
    }
    let answer = body.params.name === "lookup_catalog" ? fx("lookup.json") : fx("search.json");
    // A catalog that answers in another currency (0.1.1 rule: never ranked or counted).
    if (mode === "cad") answer = JSON.parse(JSON.stringify(answer).replace(/"currency":"USD"/g, '"currency":"CAD"'));
    answer.id = body.id;
    reply(200, answer, mode === "sse" ? "text/event-stream" : "application/json");
  });
});

before(async () => {
  delete process.env.OSA_SHOP_CATALOG;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const item = { id: "item-1", query: "trail running shoes", description: "trail running shoes", quantity: 1, maxPrice: { cents: 20000, currency: "USD" } };

test("shop catalog: off by default; OSA_SHOP_CATALOG wins over the setting", () => {
  assert.equal(shopCatalogEnabled(undefined, {}), false);
  assert.equal(shopCatalogEnabled(true, {}), true);
  assert.equal(shopCatalogEnabled(false, { OSA_SHOP_CATALOG: "1" }), true);
  assert.equal(shopCatalogEnabled(true, { OSA_SHOP_CATALOG: "0" }), false);
});

test("shop catalog: anonymous search_catalog, stateless MCP request shape", async () => {
  mode = "ok";
  seen.length = 0;
  const c = new ShopCatalog({ url });
  const offers = await c.search(item, 5, "10001");
  assert.equal(seen.length, 1, "the 2026-07-28 revision needs no initialize");
  const { headers, body } = seen[0];
  assert.equal(headers["mcp-protocol-version"], "2026-07-28");
  assert.equal(headers["mcp-method"], "tools/call");
  assert.equal(headers["mcp-name"], "search_catalog");
  assert.match(String(headers.accept), /application\/json/);
  assert.equal(headers.authorization, undefined, "no credentials");
  assert.equal(headers.cookie, undefined);
  assert.equal(body.params.name, "search_catalog");
  assert.equal(body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.equal(body.params._meta["io.modelcontextprotocol/clientInfo"].name, "open-shopping-agent");
  assert.deepEqual(body.params.arguments, { catalog: {
    query: "trail running shoes", context: { address_country: "US", currency: "USD", postal_code: "10001" },
    filters: { ships_to: { country: "US" }, price: { max: 20000 } }, pagination: { limit: 5 },
  } });

  assert.equal(offers.length, 2, "skips a shop without a /products/ page (headless) and a product without a price");
  const [a, b] = offers;
  assert.equal(a.store, "shopify");
  assert.equal(a.storeDomain, "trail-shop.example", "the store's own site, not the myshopify domain");
  assert.equal(a.url, "https://trail-shop.example/products/ridgeline-trail-runner", "tracking query removed");
  assert.equal(a.productId, "1001", "the variant id the store's /cart/add.js takes");
  assert.equal(a.raw?.handle, "ridgeline-trail-runner");
  assert.equal(a.raw?.source, "shop_catalog");
  assert.deepEqual(a.price, { cents: 14500, currency: "USD" });
  assert.deepEqual(a.listPrice, { cents: 16000, currency: "USD" });
  assert.deepEqual(a.rating, { stars: 4.7, count: 212 });
  assert.equal(a.ids?.gtin, "00400001234563");
  assert.deepEqual(a.variants, { Size: ["9", "10"], Color: ["Slate"] });
  assert.equal(a.shipping, undefined, "shipping unknown until the store's own cart");
  assert.ok(!JSON.stringify(offers).includes("checkout_url") && !JSON.stringify(offers).includes("shop_pay"), "Shop's buy-now link is never kept");
  assert.ok(!JSON.stringify(offers).includes("Ignore previous instructions"), "server advice (next[]) is not carried into offers");
  assert.equal(b.storeDomain, "runfast.example");
});

test("shop catalog: lookup_catalog keeps exact variant matches only", async () => {
  mode = "ok";
  seen.length = 0;
  const c = new ShopCatalog({ url });
  const found = await c.lookupGtins(["042100005264"], "item-1");
  assert.equal(seen[0].body.params.name, "lookup_catalog");
  assert.deepEqual(seen[0].body.params.arguments.catalog.ids, ["042100005264"]);
  const got = found.get("042100005264")!;
  assert.deepEqual(got.map((o) => o.storeDomain), ["gadget-shop.example"], "the featured bundle is left out");
  assert.equal(got[0].ids?.gtin, "00042100005264");
  assert.equal(got[0].raw?.lookupGtin, "042100005264");
});

test("shop catalog: sign-in refusals end in ShopCatalogAuthError", async () => {
  mode = "auth";
  await assert.rejects(new ShopCatalog({ url }).search(item), ShopCatalogAuthError);
  mode = "tool-auth";
  await assert.rejects(new ShopCatalog({ url }).search(item), ShopCatalogAuthError);
});

test("shop catalog: SSE answers and a server on an older revision (initialize handshake)", async () => {
  mode = "sse";
  assert.equal((await new ShopCatalog({ url }).search(item)).length, 2);
  mode = "old";
  seen.length = 0;
  const c = new ShopCatalog({ url });
  assert.equal((await c.search(item)).length, 2);
  assert.deepEqual(seen.map((s) => s.body.method), ["tools/call", "initialize", "notifications/initialized", "tools/call"]);
  assert.equal(seen[3].headers["mcp-session-id"], "s-1");
  assert.equal(seen[3].body.params._meta, undefined, "the older revision has no per-request _meta");
});

test("shop catalog: call cap per run", async () => {
  mode = "ok";
  const c = new ShopCatalog({ url, maxCalls: 1 });
  await c.search(item);
  await assert.rejects(c.search(item), /call limit/);
});

test("shop catalog: answer helpers", () => {
  assert.equal(numericId("gid://shopify/ProductVariant/45422477836348"), "45422477836348");
  assert.equal(numericId("x"), undefined);
  assert.equal(parseRpc('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"a":1}}\n\n', "text/event-stream", 7)?.result.a, 1);
  assert.deepEqual(toolData({ content: [{ type: "text", text: '{"ok":true,"v":1,"data":{"products":[]}}' }] }), { products: [] });
  assert.deepEqual(catalogOffers(undefined, "item-1"), []);
  assert.deepEqual(catalogOffers({ products: [{ title: "x", variants: [{ url: "http://plain.example/products/x", price: { amount: 100, currency: "USD" } }] }] }, "item-1"), [], "https only");
});

test("engine: Shop catalog offers and GTIN matches join the run; picks label exact matches", async () => {
  mode = "ok";
  seen.length = 0;
  const hub = offer("amazon", "Northbay 7-in-1 USB-C Hub", 25, { ids: { gtin: "00042100005264", brand: "northbay" } });
  const amazon = new FakeAdapter("amazon", { catalog: { hub: [hub] } });
  const shopify = new FakeAdapter("shopify", { catalog: {} });
  const fb = fakeBrowsers();
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({
    llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-test-")), adapters: { amazon, shopify }, openBrowser: fb.open, watchLinks: false,
    shopCatalog: new ShopCatalog({ url }),
  });
  const run = await agent.run("a usb-c hub on amazon or shopify", { onEvent: (e) => events.push(e), until: "picks" });
  const logs = events.filter((e) => e.type === "log").map((e) => (e as { message: string }).message);
  assert.ok(logs.some((m) => /Shopify's API terms apply/.test(m)), "the run says the API's terms apply");
  assert.ok(!events.some((e) => e.type === "store_failed" && e.store === "shopify"), "no 'no Shopify domain' failure with the catalog on");
  assert.deepEqual([...new Set(seen.map((s) => s.body.params?.name))], ["search_catalog", "lookup_catalog"], "only the two read-only tools");
  assert.deepEqual(seen.find((s) => s.body.params?.name === "lookup_catalog")?.body.params.arguments.catalog.ids, ["042100005264"]);
  const fromCatalog = run.offers.filter((o: Offer) => o.raw?.source === "shop_catalog");
  assert.deepEqual(fromCatalog.map((o: Offer) => o.storeDomain).sort(), ["gadget-shop.example", "runfast.example", "trail-shop.example"]);
  const pick = run.picks[0];
  assert.equal(pick.offer.store, "amazon", "rated, free shipping: the default ranking is unchanged");
  const labels = Object.fromEntries(pick.alternatives.map((o) => [o.storeDomain, `${o.match}${o.matchBy ? `:${o.matchBy}` : ""}`]));
  assert.deepEqual(labels, { "gadget-shop.example": "exact:gtin", "trail-shop.example": "similar", "runfast.example": "similar" },
    "the same hub at the Shopify store is an exact match; the rest are labelled similar, none dropped");
  assert.equal(shopify.calls.search, 0, "no Shopify shop to open until a cart is filled");
  assert.equal(amazon.calls.addToCart + shopify.calls.addToCart, 0);
});

test("engine: Shop catalog stays off without the switch", async () => {
  mode = "ok";
  seen.length = 0;
  const amazon = new FakeAdapter("amazon", { catalog: { hub: [offer("amazon", "USB-C hub", 25)] } });
  const fb = fakeBrowsers();
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-test-")), adapters: { amazon }, openBrowser: fb.open, watchLinks: false });
  await agent.run("a usb-c hub on amazon or shopify", { onEvent: (e) => events.push(e), until: "picks" });
  assert.equal(seen.length, 0, "no request to the catalog");
  assert.ok(events.some((e) => e.type === "store_failed" && e.store === "shopify" && /no Shopify shop domain/.test(e.error)));
});

test("engine: Shop catalog offers in another currency are listed, never picked (0.1.1 currency rule)", async () => {
  mode = "cad";
  seen.length = 0;
  const amazon = new FakeAdapter("amazon", { catalog: { hub: [offer("amazon", "Northbay 7-in-1 USB-C Hub", 25, { ids: { gtin: "00042100005264", brand: "northbay" } })] } });
  const shopify = new FakeAdapter("shopify", { catalog: {} });
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({
    llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-test-")), adapters: { amazon, shopify }, openBrowser: fakeBrowsers().open, watchLinks: false,
    shopCatalog: new ShopCatalog({ url }),
  });
  const run = await agent.run("a usb-c hub on amazon or shopify", { onEvent: (e) => events.push(e), until: "picks" });
  const fromCatalog = run.offers.filter((o: Offer) => o.raw?.source === "shop_catalog");
  assert.ok(fromCatalog.length > 0);
  assert.ok(fromCatalog.every((o: Offer) => o.currencyMismatch === true), "every CAD catalog offer is marked");
  assert.ok(run.picks.every((p) => p.offer.store === "amazon" && p.offer.price.currency === "USD"), "only USD offers are picked");
  const logs = events.filter((e) => e.type === "log").map((e) => (e as { message: string }).message);
  assert.ok(logs.some((m) => /CAD/.test(m)), "the run says a store showed CAD");
  mode = "ok";
});
