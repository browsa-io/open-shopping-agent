// The real-engine port (src/web/real-engine.ts) over ShoppingAgent, with offline fake adapters
// registered in the store registry and fake browsers. No network, no credits.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Offer, RunEvent, StoreId } from "../../src/core/types.js";
import { LimitError } from "../../src/core/limits.js";
import { markAdapterMissing, registerAdapter, unregisterAdapter } from "../../src/stores/index.js";
import { createWatchCheck } from "../../src/core/watch-check.js";
import { normalizeWatch } from "../../src/alerts/store.js";
import { RealEngine, type RealEngineOptions } from "../../src/web/real-engine.js";
import { RunHub } from "../../src/web/session.js";
import { createEngine } from "../../src/web/engine-factory.js";
import { WatchAlerts } from "../../src/web/alerts-port.js";
import { MockEngine } from "../../src/web/mock-engine.js";
import { FakeAdapter, FakeDetailAdapter, fakeBrowsers, offer, usd } from "../core/fake-adapter.js";

const registered: StoreId[] = [];
function register(a: FakeAdapter): FakeAdapter {
  registerAdapter(a);
  registered.push(a.id);
  return a;
}
afterEach(() => {
  for (const id of registered.splice(0)) unregisterAdapter(id);
});

async function engineWith(extra: Partial<RealEngineOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-real-"));
  const fb = fakeBrowsers();
  const engine = new RealEngine({ llm: false, dataDir, openBrowser: fb.open, watchLinks: false, ...extra });
  return { engine, hub: new RunHub(engine), dataDir, browsers: fb.log };
}

const amazon = (o: Partial<ConstructorParameters<typeof FakeAdapter>[1]> = {}) => new FakeAdapter("amazon", {
  catalog: { hub: [offer("amazon", "USB-C hub HDMI 4K", 30)], cable: [offer("amazon", "USB-C cable", 12)] }, taxCents: 180, ...o,
});
const walmart = (o: Partial<ConstructorParameters<typeof FakeAdapter>[1]> = {}) => new FakeAdapter("walmart", {
  catalog: { hub: [offer("walmart", "USB-C hub HDMI 4K", 34)], cable: [offer("walmart", "USB-C cable", 7)] }, ...o,
});

const has = (events: RunEvent[], type: RunEvent["type"], store?: StoreId) =>
  events.some((e) => e.type === type && (!store || ("store" in e && e.store === store) || (e.type === "cart" && e.cart.store === store) || (e.type === "order" && e.result.store === store)));

test("real engine: per-store gates, one cart filled, approval re-checked, order placed", async () => {
  const a = register(amazon());
  const w = register(walmart());
  const { engine, hub, browsers } = await engineWith();
  assert.equal(engine.demo, false);
  const run = hub.start("a usb-c hub and a usb-c cable", { limits: { allowedStores: ["amazon", "walmart"] } });
  await hub.waitFor(run.runId, (r) => r.gates.filter((g) => g.step === "cart").length === 2, 5000);
  assert.ok(has(run.events, "picks"));
  assert.equal(a.calls.addToCart + w.calls.addToCart, 0, "nothing is added before the person says yes");

  hub.answer(run.runId, "cart", "walmart", false);
  hub.answer(run.runId, "cart", "amazon", true);
  await hub.waitFor(run.runId, (r) => r.gates.some((g) => g.step === "checkout" && g.store === "amazon"), 5000);
  assert.equal(a.calls.addToCart, 1);
  assert.equal(w.calls.addToCart, 0, "walmart was skipped");
  assert.equal(a.calls.reviewCheckout, 0, "no checkout before the second yes");

  hub.answer(run.runId, "checkout", "amazon", true);
  await hub.waitFor(run.runId, () => !!hub.pendingReview(run.runId, "amazon"), 5000);
  const review = hub.pendingReview(run.runId, "amazon")!;
  assert.deepEqual(review.total, usd(31.8));

  // A total that does not match is refused by the hub, and by the engine itself.
  await assert.rejects(hub.approve(run.runId, "amazon", usd(30)), /does not match/);
  await assert.rejects(engine.approve(run.runId, { store: "amazon", approvedTotal: usd(30), approvedAt: new Date().toISOString(), by: "user" }), LimitError);
  await assert.rejects(engine.approve(run.runId, { store: "walmart", approvedTotal: usd(7), approvedAt: new Date().toISOString(), by: "user" }), /waiting for approval/);
  assert.equal(a.calls.placeOrder, 0);

  await hub.approve(run.runId, "amazon", review.total);
  const summary = await run.done;
  assert.equal(a.calls.placeOrder, 1);
  assert.equal(summary.orders.length, 1);
  assert.equal(summary.orders[0].placed, true);
  assert.equal(run.events.at(-1)?.type, "done");
  assert.equal(run.status, "done");
  assert.deepEqual(browsers.closed.sort(), ["amazon", "walmart"], "every browser is stopped at the end");
});

test("real engine: price changed at the store, order not placed", async () => {
  const a = register(amazon({ priceJumpCents: 500 }));
  const { hub } = await engineWith();
  const run = hub.start("a usb-c hub", { limits: { allowedStores: ["amazon"] } });
  await hub.waitFor(run.runId, (r) => r.gates.length > 0, 5000);
  hub.answer(run.runId, "cart", "amazon", true);
  await hub.waitFor(run.runId, (r) => r.gates.some((g) => g.step === "checkout"), 5000);
  hub.answer(run.runId, "checkout", "amazon", true);
  await hub.waitFor(run.runId, () => !!hub.pendingReview(run.runId, "amazon"), 5000);
  await hub.approve(run.runId, "amazon", hub.pendingReview(run.runId, "amazon")!.total);
  const s = await run.done;
  assert.equal(a.calls.placeOrder, 1);
  assert.equal(s.orders[0].placed, false);
});

test("real engine: sign-in at checkout emits needs_user and offers a second review", async () => {
  const a = register(amazon({ needsSignIn: true }));
  const { engine, hub } = await engineWith();
  const run = hub.start("a usb-c hub", { limits: { allowedStores: ["amazon"] } });
  await hub.waitFor(run.runId, (r) => r.gates.length > 0, 5000);
  hub.answer(run.runId, "cart", "amazon", true);
  await hub.waitFor(run.runId, (r) => r.gates.some((g) => g.step === "checkout"), 5000);
  hub.answer(run.runId, "checkout", "amazon", true);
  await hub.waitFor(run.runId, (r) => has(r.events, "needs_user", "amazon") && r.gates.some((g) => g.step === "checkout"), 5000);
  const needs = run.events.find((e): e is Extract<RunEvent, { type: "needs_user" }> => e.type === "needs_user")!;
  assert.equal(needs.needs.reason, "sign_in");
  assert.ok(needs.needs.liveUrl);
  assert.ok(!has(run.events, "awaiting_approval"), "a store that needs the person is never offered for approval");
  await assert.rejects(engine.approve(run.runId, { store: "amazon", approvedTotal: usd(31.8), approvedAt: new Date().toISOString(), by: "user" }), /waiting for approval/);

  // After the person signs in (here: the store stops asking), the second review can be approved.
  a.o.needsSignIn = false;
  hub.answer(run.runId, "checkout", "amazon", true);
  await hub.waitFor(run.runId, () => !!hub.pendingReview(run.runId, "amazon"), 5000);
  assert.equal(a.calls.reviewCheckout, 2);
  await hub.cancel(run.runId, "amazon");
  const s = await run.done;
  assert.equal(a.calls.placeOrder, 0);
  assert.equal(s.orders.length, 0);
});

test("real engine: cancel a store at approval, and cancel a whole run at a gate", async () => {
  const a = register(amazon());
  const { hub, browsers } = await engineWith();
  const run = hub.start("a usb-c hub", { limits: { allowedStores: ["amazon"] } });
  await hub.waitFor(run.runId, (r) => r.gates.length > 0, 5000);
  hub.answer(run.runId, "cart", "amazon", true);
  await hub.waitFor(run.runId, (r) => r.gates.some((g) => g.step === "checkout"), 5000);
  hub.answer(run.runId, "checkout", "amazon", true);
  await hub.waitFor(run.runId, () => !!hub.pendingReview(run.runId, "amazon"), 5000);
  await hub.cancel(run.runId, "amazon");
  const s = await run.done;
  assert.equal(s.orders.length, 0);
  assert.equal(a.calls.placeOrder, 0);
  assert.ok(run.events.some((e) => e.type === "log" && /Not bought/.test(e.message)));

  const run2 = hub.start("a usb-c cable", { limits: { allowedStores: ["amazon"] } });
  await hub.waitFor(run2.runId, (r) => r.gates.length > 0, 5000);
  const closedBefore = browsers.closed.length;
  await hub.cancel(run2.runId);
  assert.equal(browsers.closed.length, closedBefore + 1, "cancel stops the browsers before it returns (the CLI exits right after)");
  await run2.done;
  assert.equal(run2.status, "cancelled");
  assert.equal(a.calls.addToCart, 1, "the cancelled run filled no cart");
  assert.equal(browsers.closed.length, 2);
  const rec = await hub.record(run2.runId);
  assert.equal(rec?.status, "cancelled");
});

test("real engine: compare only closes after the picks; gates time out", async () => {
  register(amazon());
  const { hub, browsers } = await engineWith({ gateTimeoutMs: 50 });
  const run = hub.start("a usb-c hub", { limits: { allowedStores: ["amazon"] }, checkout: false });
  const s = await run.done;
  assert.equal(s.picks.length, 1);
  assert.equal(run.gates.length, 0);
  assert.equal(browsers.closed.length, 1);

  const run2 = hub.start("a usb-c hub", { limits: { allowedStores: ["amazon"] } });
  await run2.done; // nobody answers the cart gate
  assert.ok(run2.events.some((e) => e.type === "log" && /No answer/.test(e.message)));
});

test("real engine: a store without an adapter reports not installed; history lists the runs", async (t) => {
  markAdapterMissing("target");
  t.after(() => unregisterAdapter("target"));
  register(amazon());
  const { hub, dataDir } = await engineWith();
  const run = hub.start("a usb-c hub", { limits: { allowedStores: ["amazon", "target"] }, checkout: false });
  await run.done;
  const failed = run.events.find((e): e is Extract<RunEvent, { type: "store_failed" }> => e.type === "store_failed");
  assert.equal(failed?.store, "target");
  assert.match(failed!.error, /not installed/);

  // A fresh engine on the same folder reads the run back from .osa/runs.
  const again = new RealEngine({ llm: false, dataDir });
  const list = await again.listRuns();
  assert.equal(list.length, 1);
  assert.equal(list[0].runId, run.runId);
  assert.equal(list[0].status, "done");
  assert.equal(list[0].prompt, "a usb-c hub");
  assert.deepEqual(list[0].picksTotal, usd(30));
  const rec = await again.getRun(run.runId);
  assert.ok(rec?.events.some((e) => e.type === "picks"));
  assert.equal(await again.getRun("run-nope"), undefined);
});

test("createEngine: real with a key, demo with --demo or OSA_DEMO=1", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-real-"));
  assert.ok((await createEngine({}, { dataDir })) instanceof MockEngine);
  assert.ok((await createEngine({ browsaApiKey: "agt_test" }, { dataDir })) instanceof RealEngine);
  assert.ok((await createEngine({ browsaApiKey: "agt_test" }, { dataDir, demo: true })) instanceof MockEngine);
  process.env.OSA_DEMO = "1";
  try {
    assert.ok((await createEngine({ browsaApiKey: "agt_test" }, { dataDir })) instanceof MockEngine);
  } finally {
    delete process.env.OSA_DEMO;
  }
  const real = (await createEngine({ browsaApiKey: "agt_test", browserMode: "persistent" }, { dataDir })) as RealEngine;
  assert.equal(real.agent.options.browserMode, "persistent");
  const burner = (await createEngine({ browsaApiKey: "agt_test" }, { dataDir })) as RealEngine;
  assert.equal(burner.agent.options.browserMode, "burner");
});

test("watch check: search on each store, details for a url, one browser at a time", async (t) => {
  markAdapterMissing("target");
  t.after(() => unregisterAdapter("target"));
  register(amazon());
  // A product page reader: the page shows the title, a price and shipping.
  class PageReader extends FakeDetailAdapter {
    async details(ctx: Parameters<FakeDetailAdapter["details"]>[0], o: Offer): Promise<Offer> {
      return { ...(await super.details(ctx, o)), title: "USB-C hub HDMI 4K", price: usd(31), inStock: true };
    }
  }
  register(new PageReader("walmart", { catalog: { hub: [offer("walmart", "USB-C hub HDMI 4K", 34)] } }));
  const fb = fakeBrowsers();
  const open = (s: StoreId, d: string) => fb.open(s, d, async (n) => n);
  const check = createWatchCheck({ openBrowser: open });

  const offers = await check(normalizeWatch({ query: "usb-c hub", stores: ["amazon", "walmart", "target"] }));
  assert.deepEqual(offers.map((o) => o.store).sort(), ["amazon", "walmart"]);
  assert.ok(offers.every((o) => o.itemId === "watch"));
  assert.deepEqual(fb.log.closed.sort(), ["amazon", "walmart"], "target has no adapter, so no browser was opened for it");

  const byUrl = await check(normalizeWatch({ url: "https://www.walmart.com/ip/123" }));
  assert.equal(byUrl.length, 1);
  assert.equal(byUrl[0].store, "walmart");
  assert.equal(byUrl[0].url, "https://www.walmart.com/ip/123");
  assert.deepEqual(byUrl[0].shipping, usd(4.99));
  assert.deepEqual(byUrl[0].price, usd(31));

  await assert.rejects(check(normalizeWatch({ query: "usb-c hub", stores: ["target"] })), /not installed/);
  await assert.rejects(check(normalizeWatch({ url: "https://www.amazon.com/dp/B0TEST" })), /cannot read product pages/);
});

test("web alerts: create, list, check now, remove on the real watch store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osa-watch-"));
  let calls = 0;
  const alerts = new WatchAlerts({
    dir,
    getCheck: async () => async () => {
      calls++;
      return [offer("amazon", "USB-C hub HDMI 4K", 28, { itemId: "watch" })];
    },
    defaults: async () => ({ stores: ["amazon", "shopify"] }),
    config: { out: { write: () => true } },
  });
  const hook = await alerts.create({ kind: "back_in_stock", item: "usb-c dock", notify: { webhook: "https://example.com/hook" } });
  assert.equal(hook.notify?.webhook, "https://example.com/hook");
  assert.equal(hook.kind, "back_in_stock");
  assert.equal(await alerts.remove(hook.id), true);

  const w = await alerts.create({ kind: "price_drop", item: "usb-c hub", below: usd(29) });
  assert.equal(w.status, "saved");
  assert.deepEqual(w.stores, ["amazon"], "shopify needs domains, so it is dropped");
  assert.equal((await alerts.list()).length, 1);

  const checked = await alerts.check(w.id);
  assert.equal(calls, 1);
  assert.deepEqual(checked.lastPrice, usd(28));
  assert.equal(checked.lastStore, "amazon");
  assert.equal(checked.status, "triggered");

  const none = new WatchAlerts({ dir, getCheck: async () => undefined });
  await assert.rejects(none.check(w.id), /Browsa API key/);
  await assert.rejects(alerts.check("nope"), /not found/);
  assert.equal(await alerts.remove(w.id), true);
  assert.equal((await alerts.list()).length, 0);
});
