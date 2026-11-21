// Price history per watch (0.3.0 preview, behind OSA_PRICE_HISTORY=1): the points come from the
// checks a watch already keeps on this computer; the web endpoint is off unless the flag is set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priceHistory, priceHistoryEnabled } from "../../src/alerts/price-history.js";
import { WatchStore } from "../../src/alerts/store.js";
import type { HistoryEntry, OfferSnapshot } from "../../src/alerts/types.js";
import { WatchAlerts } from "../../src/web/alerts-port.js";
import { ConfigStore } from "../../src/web/config.js";
import { MockEngine } from "../../src/web/mock-engine.js";
import { createApp } from "../../src/web/server.js";
import { RunHub } from "../../src/web/session.js";

const snap = (cents: number, extra: Partial<OfferSnapshot> = {}): OfferSnapshot => ({
  store: "walmart", storeDomain: "walmart.com", title: "27 inch 4K monitor", url: "https://www.walmart.com/ip/1",
  price: { cents, currency: "USD" }, total: { cents, currency: "USD" }, inStock: true, ...extra,
});
const check = (at: string, best?: OfferSnapshot, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at, ok: true, offerCount: best ? 1 : 0, inStockCount: best?.inStock ? 1 : 0, ...(best ? { best } : {}), offers: best ? [best] : [], alerts: [], ...extra,
});

test("the flag is off by default", () => {
  assert.equal(priceHistoryEnabled({}), false);
  assert.equal(priceHistoryEnabled({ OSA_PRICE_HISTORY: "0" }), false);
  assert.equal(priceHistoryEnabled({ OSA_PRICE_HISTORY: "1" }), true);
  assert.equal(priceHistoryEnabled({ OSA_PRICE_HISTORY: " on " }), true);
});

test("priceHistory: one point per check that found an in-stock US-dollar price, oldest first", () => {
  const entries = [
    check("2026-11-03T09:00:00.000Z", snap(24999)),
    check("2026-11-02T09:00:00.000Z", snap(26999, { store: "bestbuy", storeDomain: "bestbuy.com" })),
    check("2026-11-04T09:00:00.000Z", undefined, { ok: false, error: "Walmart blocked this browser" }),   // a failed check
    check("2026-11-05T09:00:00.000Z", snap(19999, { inStock: false })),                                    // out of stock
    check("2026-11-06T09:00:00.000Z", snap(1500, { total: { cents: 1500, currency: "EUR" } })),          // another currency
    check("2026-11-07T09:00:00.000Z", snap(21999)),
    check("2026-11-08T09:00:00.000Z", snap(21999)),
  ];
  const h = priceHistory(entries);
  assert.deepEqual(h.points.map((p) => [p.at.slice(0, 10), p.cents, p.store]), [
    ["2026-11-02", 26999, "bestbuy"], ["2026-11-03", 24999, "walmart"], ["2026-11-07", 21999, "walmart"], ["2026-11-08", 21999, "walmart"],
  ]);
  assert.equal(h.checks, 7);
  assert.equal(h.priced, 4);
  assert.equal(h.low?.at, "2026-11-07T09:00:00.000Z", "the earliest lowest");
  assert.equal(h.high?.cents, 26999);
  assert.equal(h.first?.cents, 26999);
  assert.equal(h.last?.at, "2026-11-08T09:00:00.000Z");
  const empty = priceHistory([]);
  assert.deepEqual([empty.points, empty.checks, empty.low, empty.last], [[], 0, undefined, undefined]);
});

test("web: /api/watches/:id/history is 404 without OSA_PRICE_HISTORY=1, and reads the local history with it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osa-ph-"));
  const saved = process.env.OSA_PRICE_HISTORY;
  const alerts = new WatchAlerts({ dir, getCheck: async () => undefined });
  const w = await alerts.create({ kind: "price_drop", item: "27 inch 4K monitor", below: { cents: 19900, currency: "USD" } });
  const store = new WatchStore(dir);
  await store.append(w.id, check("2026-11-02T09:00:00.000Z", snap(26999)));
  await store.append(w.id, check("2026-11-03T09:00:00.000Z", snap(24999)));
  const server = createApp({ hub: new RunHub(new MockEngine({ speed: 0 })), alerts, config: new ConfigStore(dir) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as Record<string, any> }; };
  try {
    delete process.env.OSA_PRICE_HISTORY;
    assert.equal((await get(`/api/watches/${w.id}/history`)).status, 404);
    assert.equal((await get("/api/meta")).body.priceHistory, false);

    process.env.OSA_PRICE_HISTORY = "1";
    assert.equal((await get("/api/meta")).body.priceHistory, true);
    const r = await get(`/api/watches/${w.id}/history`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.points.map((p: { cents: number }) => p.cents), [26999, 24999]);
    assert.equal(r.body.low.cents, 24999);
    assert.equal(r.body.checks, 2);
    assert.equal((await get("/api/watches/nope/history")).status, 404);
  } finally {
    if (saved === undefined) delete process.env.OSA_PRICE_HISTORY; else process.env.OSA_PRICE_HISTORY = saved;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
