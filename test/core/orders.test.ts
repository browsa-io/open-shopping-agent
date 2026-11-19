// Orders from run events: states, legacy runs, a run that stopped while placing, tracking storage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ordersFromEvents, readTracking, saveTracking } from "../../src/core/orders.js";
import type { RunEvent } from "../../src/core/types.js";

const usd = (c: number) => ({ cents: c, currency: "USD" });

test("orders: a saved run that stopped in 'placing' shows as unknown; a live one stays placing", () => {
  const ev: RunEvent[] = [
    { type: "order_state", store: "target", state: "awaiting_approval", at: "2026-11-19T10:00:00.000Z" },
    { type: "order_state", store: "target", state: "placing", at: "2026-11-19T10:01:00.000Z", total: usd(3833) },
  ];
  assert.equal(ordersFromEvents("r1", "x", ev, { live: true })[0].state, "placing");
  const saved = ordersFromEvents("r1", "x", ev)[0];
  assert.equal(saved.state, "unknown");
  assert.match(saved.message ?? "", /stopped while placing.*Check your orders on Target \(https:\/\/www\.target\.com\/orders\)/);
  assert.equal(saved.total?.cents, 3833);
});

test("orders: runs saved before order states (order events only) still list", () => {
  const ev: RunEvent[] = [
    { type: "order", result: { store: "ebay", placed: true, orderId: "12-34567-89012", total: usd(1707), placedAt: "2026-11-18T09:00:00.000Z" } },
    { type: "order", result: { store: "walmart", placed: false, error: "Walmart total is now $31.00" } },
  ];
  const list = ordersFromEvents("r2", undefined, ev);
  assert.deepEqual(list.map((o) => [o.store, o.state, o.orderId]), [["ebay", "placed", "12-34567-89012"], ["walmart", "failed", undefined]]);
  assert.equal(list[1].message, "Walmart total is now $31.00");
});

test("orders: Shopify orders keep their shop domain; a new approval after a failure is a new entry", () => {
  const ev: RunEvent[] = [
    { type: "order_state", store: "shopify", domain: "satechi.com", state: "placing", at: "2026-11-19T10:00:00.000Z" },
    { type: "order_state", store: "shopify", domain: "satechi.com", state: "failed", at: "2026-11-19T10:00:05.000Z", message: "total changed" },
    { type: "order_state", store: "shopify", domain: "satechi.com", state: "placing", at: "2026-11-19T10:05:00.000Z" },
    { type: "order_state", store: "shopify", domain: "satechi.com", state: "placed", at: "2026-11-19T10:05:30.000Z", orderId: "KX4PZT2N9", orderUrl: "https://satechi.com/checkouts/c/x/thank-you" },
  ];
  const [o] = ordersFromEvents("r3", "hub", ev);
  assert.equal(o.state, "placed");
  assert.equal(o.message, undefined);
  assert.equal(o.storeDomain, "satechi.com");
  assert.equal(o.shop, "shopify:satechi.com");
  assert.equal(o.ordersUrl, "https://satechi.com/account/orders");
});

test("orders: tracking is saved per run and shop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osa-tr-"));
  await mkdir(join(dir, "runs", "run-1"), { recursive: true });
  await saveTracking(dir, "run-1", "amazon", { status: "Delivered", checkedAt: "2026-11-21T00:00:00.000Z" });
  await saveTracking(dir, "run-1", "shopify:satechi.com", { signIn: true, checkedAt: "2026-11-21T00:00:00.000Z" });
  const t = await readTracking(dir, "run-1");
  assert.equal(t.amazon.status, "Delivered");
  assert.equal(t["shopify:satechi.com"].signIn, true);
  await assert.rejects(saveTracking(dir, "../evil", "amazon", { checkedAt: "" }), /bad run id/);
});
