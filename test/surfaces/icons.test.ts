import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { FileAlerts } from "../../src/web/alerts-port.js";
import { ConfigStore } from "../../src/web/config.js";
import { ICON_MAX_BYTES, IconCache, cleanHost, iconLinks, isPrivateAddress, sniffImage } from "../../src/web/icons.js";
import { MockEngine } from "../../src/web/mock-engine.js";
import { createApp } from "../../src/web/server.js";
import { RunHub } from "../../src/web/session.js";

// A 1x1 PNG and a tiny ICO header with one entry.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c30000000049454e44ae426082", "hex");
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(40)]);
const HTML = Buffer.from("<!doctype html><html><head><title>Robot check</title></head><body>Are you a human?</body></html>");

type Route = { status?: number; body?: Buffer | string; headers?: Record<string, string> };

/** A fetch that answers from a table of URLs and counts calls. Unknown URLs get 404. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fn, calls };
}
const publicDns = async () => ["93.184.216.34"];

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "osa-icons-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

test("sniffImage knows image bytes and refuses pages", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(ICO), "image/x-icon");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif")])), "image/avif");
  assert.equal(sniffImage(HTML), null);
  assert.equal(sniffImage(Buffer.from('{"error":"nope"}')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("cleanHost takes public shop names only", () => {
  assert.equal(cleanHost("Satechi.com"), "satechi.com");
  assert.equal(cleanHost("https://shop.example-store.co.uk/products/x"), "shop.example-store.co.uk");
  for (const bad of ["localhost", "127.0.0.1", "[::1]", "printer.local", "db.internal", "user@evil.com", "evil.com:8080", "nodot", ""]) {
    assert.equal(cleanHost(bad), null, bad);
  }
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("::ffff:192.168.1.1"), true);
  assert.equal(isPrivateAddress("fd00::1"), true);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
});

test("iconLinks reads the page head, best size first", () => {
  const html = `<head>
    <link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel="apple-touch-icon" href="https://cdn.shop.com/touch.png">
    <link rel="icon" type="image/png" href="//shop.com/cdn/shop/files/favicon.png?crop=center&amp;height=32&amp;width=32">
    <link rel="mask-icon" href="/mask.svg">
    <link rel="stylesheet" href="/a.css">
  </head>`;
  assert.deepEqual(iconLinks(html, "https://shop.com/"), [
    "https://shop.com/cdn/shop/files/favicon.png?crop=center&height=64&width=64",
    "https://cdn.shop.com/touch.png",
    "https://shop.com/favicon-16.png",
  ]);
});

test("rejects a page that is not an image, then falls back to the page head's icon", async () => {
  const f = fakeFetch({
    "https://www.amazon.com/favicon.ico": { body: HTML, headers: { "content-type": "image/x-icon" } }, // lies about its type
    "https://www.amazon.com/": { body: '<link rel="icon" href="/real.png" sizes="48x48">' },
    "https://www.amazon.com/real.png": { body: PNG },
  });
  const c = new IconCache(join(dir, "a"), { fetch: f.fn, lookup: publicDns });
  const icon = await c.forStore("amazon");
  assert.equal(icon?.type, "image/png");
  assert.deepEqual(icon?.body, PNG);
  assert.deepEqual(f.calls, ["https://www.amazon.com/favicon.ico", "https://www.amazon.com/", "https://www.amazon.com/real.png"]);
});

test("falls back to /favicon.ico for a Shopify shop with no icon link", async () => {
  const f = fakeFetch({
    "https://shop.example-store.com/": { body: "<html><head></head></html>" },
    "https://shop.example-store.com/favicon.ico": { body: ICO },
  });
  const c = new IconCache(join(dir, "b"), { fetch: f.fn, lookup: publicDns });
  assert.equal((await c.forStore("shopify", "shop.example-store.com"))?.type, "image/x-icon");
});

test("caches on disk: the second ask and a new cache on the same folder fetch nothing", async () => {
  const f = fakeFetch({ "https://www.ebay.com/apple-touch-icon.png": { status: 302, headers: { location: "https://pages.ebay.com/apple-touch-icon.png" } }, "https://pages.ebay.com/apple-touch-icon.png": { body: PNG } });
  const folder = join(dir, "c");
  const c = new IconCache(folder, { fetch: f.fn, lookup: publicDns });
  const [a, b] = await Promise.all([c.forStore("ebay"), c.forStore("ebay")]); // one fetch for both
  assert.equal(a?.type, "image/png");
  assert.equal(b?.type, "image/png");
  assert.equal(f.calls.length, 2); // the redirect and the icon
  await c.forStore("ebay");
  assert.equal(f.calls.length, 2);
  const again = new IconCache(folder, { fetch: f.fn, lookup: publicDns });
  assert.deepEqual((await again.forStore("ebay"))?.body, PNG);
  assert.equal(f.calls.length, 2);
  assert.deepEqual((await readdir(folder)).sort(), ["www.ebay.com.img", "www.ebay.com.json"]);
});

test("no icon anywhere (offline): null, remembered for an hour, then asked again", async () => {
  let now = 1_000_000;
  const f = fakeFetch({});
  const offline = (async (u: string | URL) => { f.calls.push(String(u)); throw new TypeError("fetch failed"); }) as typeof fetch;
  const c = new IconCache(join(dir, "d"), { fetch: offline, lookup: publicDns, now: () => now });
  assert.equal(await c.forStore("target"), null);
  const n = f.calls.length;
  assert.ok(n >= 2);
  assert.equal(await c.forStore("target"), null);
  assert.equal(f.calls.length, n);
  now += 3600_001;
  await c.forStore("target");
  assert.ok(f.calls.length > n);
});

test("a stale icon is kept when the refresh fails", async () => {
  let now = 0;
  let up = true;
  const fetchFn = (async () => (up ? new Response(PNG) : Promise.reject(new TypeError("offline")))) as typeof fetch;
  const c = new IconCache(join(dir, "e"), { fetch: fetchFn, lookup: publicDns, now: () => now });
  assert.equal((await c.forStore("walmart"))?.type, "image/png");
  up = false;
  now += 31 * 24 * 3600_000;
  assert.equal((await c.forStore("walmart"))?.type, "image/png");
});

test("refuses icons over the size cap and hosts that resolve to private addresses", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES)]);
  const f = fakeFetch({ "https://www.bestbuy.com/favicon.ico": { body: big } });
  const c = new IconCache(join(dir, "f"), { fetch: f.fn, lookup: publicDns });
  assert.equal(await c.forStore("bestbuy"), null);

  const f2 = fakeFetch({ "https://www.target.com/favicon.ico": { status: 301, headers: { location: "https://metadata.evil-redirect.com/x.png" } } });
  const lookup = async (h: string) => (h === "metadata.evil-redirect.com" ? ["169.254.169.254"] : ["93.184.216.34"]);
  const c2 = new IconCache(join(dir, "g"), { fetch: f2.fn, lookup });
  assert.equal(await c2.forStore("target"), null);
  assert.ok(!f2.calls.includes("https://metadata.evil-redirect.com/x.png"));

  const c3 = new IconCache(join(dir, "h"), { fetch: f2.fn, lookup: publicDns });
  await assert.rejects(c3.forStore("shopify", "localhost"), /Not a shop domain/);
  await assert.rejects(c3.forStore("nope"), /Unknown store/);
});

test("GET /api/icon serves the cached image, 404 without one, 400 for a bad store", async () => {
  const f = fakeFetch({ "https://www.amazon.com/favicon.ico": { body: PNG } });
  const icons = new IconCache(join(dir, "srv"), { fetch: f.fn, lookup: publicDns });
  const server = createApp({
    hub: new RunHub(new MockEngine({ speed: 0 })), alerts: new FileAlerts(join(dir, "w.json")), config: new ConfigStore(dir), icons,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/api/icon?store=amazon`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.match(ok.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.match(ok.headers.get("cache-control") ?? "", /max-age=86400/);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
    assert.equal((await fetch(`${base}/api/icon?store=walmart`)).status, 404); // every candidate 404s
    assert.equal((await fetch(`${base}/api/icon?store=nope`)).status, 400);
    assert.equal((await fetch(`${base}/api/icon?store=shopify&domain=127.0.0.1`)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
