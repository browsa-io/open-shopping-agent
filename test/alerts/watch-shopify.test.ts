// 0.1.1: a watch keeps the Shopify shop it was given (osa --watch "..." --stores satechi.com and
// osa watch add --store satechi.com) instead of falling back to the five default stores; and a
// watch never counts a price a store showed in another currency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WatchStore, normalizeWatch, eligible, evaluate, runWatchCli } from "../../src/alerts/index.js";
import { storesFromList } from "../../src/alerts/store.js";
import { whereText } from "../../src/alerts/cli.js";
import { targets } from "../../src/core/watch-check.js";
import { WatchAlerts, validateWatch } from "../../src/web/alerts-port.js";
import { parseArgs } from "../../src/cli/args.js";
import { main } from "../../src/cli/index.js";
import { offer, tempDir } from "./helpers.js";

test("storesFromList: store names and Shopify domains in one list", () => {
  assert.deepEqual(storesFromList(["satechi.com"]), { stores: ["shopify"], shopifyDomains: ["satechi.com"] });
  assert.deepEqual(storesFromList(["amazon", "https://www.Satechi.com/", "walmart.com", "allbirds.com"]), {
    stores: ["amazon", "shopify", "walmart"], shopifyDomains: ["satechi.com", "allbirds.com"],
  });
  assert.throws(() => storesFromList(["nope"]), /unknown store "nope"/);
});

test("normalizeWatch: a Shopify domain as a store keeps the domain; never the default stores", () => {
  const w = normalizeWatch({ query: "usb-c hub", stores: ["satechi.com" as never], targetPrice: 50 });
  assert.deepEqual(w.stores, ["shopify"]);
  assert.deepEqual(w.shopifyDomains, ["satechi.com"]);
  assert.deepEqual(targets(w), [{ store: "shopify", domain: "satechi.com" }]);

  const both = normalizeWatch({ query: "usb-c hub", stores: ["amazon", "satechi.com" as never] });
  assert.deepEqual(both.stores, ["amazon", "shopify"]);
  assert.deepEqual(targets(both).map((t) => t.domain), ["amazon.com", "satechi.com"]);

  const viaDomains = normalizeWatch({ query: "usb-c hub", stores: ["amazon"], shopifyDomains: ["satechi.com"] });
  assert.deepEqual(viaDomains.stores, ["amazon", "shopify"]);
  assert.deepEqual(viaDomains.shopifyDomains, ["satechi.com"]);

  // Saved and read back unchanged.
  assert.deepEqual(normalizeWatch(w), w);
});

test("osa watch add --store <domain> saves the Shopify shop", async () => {
  const store = new WatchStore(await tempDir());
  const lines: string[] = [];
  const code = await runWatchCli(["add", "usb-c hub", "--store", "satechi.com", "--target", "50"], { store, out: { write: (s: string) => lines.push(s) } });
  assert.equal(code, 0, lines.join(""));
  const [w] = await store.list();
  assert.deepEqual(w.stores, ["shopify"]);
  assert.deepEqual(w.shopifyDomains, ["satechi.com"]);
  assert.match(lines.join(""), /on satechi\.com/);

  const code2 = await runWatchCli(["add", "usb-c hub", "--store", "amazon,satechi.com", "--id", "two"], { store, out: { write: () => {} } });
  assert.equal(code2, 0);
  const two = await store.get("two");
  assert.deepEqual(two?.stores, ["amazon", "shopify"]);
  assert.equal(whereText(two!), "amazon, satechi.com");

  const bad = await runWatchCli(["add", "usb-c hub", "--store", "nope"], { store, out: { write: () => {} } });
  assert.equal(bad, 1);
});

test("alerts port: a watch's own Shopify domains are kept, the saved defaults are not used", async () => {
  const dir = await tempDir();
  const alerts = new WatchAlerts({ dir, getCheck: async () => undefined, defaults: async () => ({ stores: ["amazon", "walmart", "ebay", "bestbuy", "target"] }) });
  const w = await alerts.create(validateWatch({ kind: "price_drop", item: "usb-c hub", stores: ["shopify"], shopifyDomains: ["satechi.com"], below: { cents: 5000, currency: "USD" } }));
  assert.deepEqual(w.stores, ["shopify"]);
  assert.deepEqual(w.shopifyDomains, ["satechi.com"]);
  const saved = (await alerts.store.list())[0];
  assert.deepEqual(saved.stores, ["shopify"]);
  assert.deepEqual(saved.shopifyDomains, ["satechi.com"]);
  // "shopify" with no domain anywhere is an error, not a silent switch to the default stores.
  await assert.rejects(alerts.create(validateWatch({ kind: "back_in_stock", item: "x", stores: ["shopify"] })), /shop domain/);
  // No stores at all: the defaults.
  const d = await alerts.create(validateWatch({ kind: "back_in_stock", item: "hdmi cable" }));
  assert.deepEqual(d.stores, ["amazon", "walmart", "ebay", "bestbuy", "target"]);
});

test("osa --watch \"...\" --stores satechi.com saves the watch on satechi.com", async (t) => {
  const home = await tempDir();
  const prev = process.env.OSA_HOME;
  process.env.OSA_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.OSA_HOME; else process.env.OSA_HOME = prev; });
  const a = parseArgs(["--watch", "usb-c hub", "--stores", "satechi.com", "--below", "50"]);
  assert.deepEqual(a.stores, ["shopify"]);
  assert.deepEqual(a.shopifyDomains, ["satechi.com"]);
  const written: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { written.push(String(s)); return true; };
  let code: number;
  try { code = await main(["--watch", "usb-c hub", "--stores", "satechi.com", "--below", "50"]); }
  finally { (process.stdout as unknown as { write: typeof orig }).write = orig; }
  assert.equal(code, 0);
  assert.match(written.join(""), /Watch saved .*usb-c hub on satechi\.com, at or below \$50\.00/);
  const list = JSON.parse(await readFile(join(home, "watches.json"), "utf8"));
  const saved = Array.isArray(list) ? list[0] : list.watches[0];
  assert.deepEqual(saved.stores, ["shopify"]);
  assert.deepEqual(saved.shopifyDomains, ["satechi.com"]);
});

test("watches count US dollars only: an IDR price is never below a USD target", () => {
  const w = normalizeWatch({ query: "usb-c hub", stores: ["amazon"], targetPrice: 50 });
  const idr = offer(4999, { store: "amazon", storeDomain: "amazon.com", price: { cents: 4999, currency: "IDR" } });
  const marked = { ...offer(4999), currencyMismatch: true };
  const ok = offer(5500);
  assert.deepEqual(eligible(w, [idr, marked, ok]), [ok]);
  const r = evaluate(w, [idr, ok], []);
  assert.equal(r.entry.best?.price.currency, "USD");
  assert.ok(!r.alerts.some((a) => a.kind === "below_target"), "IDR 49.99 is not below $50");
  // Back-in-stock watch with no target: still USD only.
  const b = normalizeWatch({ query: "usb-c hub", stores: ["amazon"], backInStock: true });
  assert.deepEqual(eligible(b, [idr, ok]), [ok]);
});
