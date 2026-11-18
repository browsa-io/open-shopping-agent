import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoppingAgent, type ShoppingAgentOptions } from "../../src/core/engine.js";
import { approvalFor, LimitError } from "../../src/core/limits.js";
import { getRun, listRuns } from "../../src/core/history.js";
import type { RunEvent, StoreId } from "../../src/core/types.js";
import { FakeAdapter, FakeDetailAdapter, fakeBrowsers, offer, usd } from "./fake-adapter.js";
import { markAdapterMissing, unregisterAdapter } from "../../src/stores/index.js";

async function setup(stores: Partial<Record<StoreId, FakeAdapter>>, extra: Partial<ShoppingAgentOptions> = {}, failStores: StoreId[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-test-"));
  const fb = fakeBrowsers(undefined, failStores);
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir, adapters: stores, openBrowser: fb.open, watchLinks: false, ...extra });
  return { agent, events, dataDir, browsers: fb.log, onEvent: (e: RunEvent) => events.push(e) };
}

const amazon = () => new FakeAdapter("amazon", {
  catalog: {
    cable: [offer("amazon", "USB-C cable 6ft", 9.99), offer("amazon", "USB-C cable 2 pack", 12.99, { sponsored: true })],
    hub: [offer("amazon", "USB-C hub HDMI 4K", 35)],
  },
  taxCents: 250,
});
const walmart = () => new FakeAdapter("walmart", {
  catalog: { cable: [offer("walmart", "USB-C cable 6ft", 8.5)], hub: [offer("walmart", "USB-C hub HDMI 4K", 39)] },
});

test("engine: parse, search in parallel, pick, fill carts, stop at review", async () => {
  const a = amazon(), w = walmart();
  const { agent, events, onEvent, browsers } = await setup({ amazon: a, walmart: w });
  const run = await agent.run("2 usb-c cables and a usb-c hub on amazon or walmart", { onEvent, until: "review" });
  const types = events.map((e) => e.type);
  assert.equal(types[0], "parsed");
  assert.ok(types.includes("store_started"));
  assert.equal(types.filter((t) => t === "offers").length, 4);
  const picks = events.find((e) => e.type === "picks");
  assert.ok(picks && picks.type === "picks");
  assert.equal(picks.picks.length, 2);
  // cable: walmart 8.50 x2 = 17.00; hub: amazon 35
  assert.deepEqual(picks.picks.map((p) => `${p.itemId}:${p.offer.store}`), ["item-1:walmart", "item-2:amazon"]);
  assert.deepEqual(picks.total, usd(52));
  assert.equal(run.carts.size, 2);
  assert.equal(w.cart[0].quantity, 2);
  assert.equal(run.reviews.size, 2);
  assert.equal(events.filter((e) => e.type === "awaiting_approval").length, 2);
  assert.equal(a.calls.placeOrder + w.calls.placeOrder, 0, "nothing is ordered without approval");
  assert.equal(browsers.opened.length, 2);
  assert.equal(run.isClosed, false);
  await run.close();
  assert.deepEqual(browsers.closed.sort(), ["amazon", "walmart"]);
  assert.equal(events.at(-1)?.type, "done");
});

test("engine: approve places the order only with the exact review total", async () => {
  const a = amazon();
  const { agent, onEvent } = await setup({ amazon: a });
  const run = await agent.run("a usb-c hub on amazon", { onEvent, until: "review" });
  const review = run.reviews.get("amazon")!;
  assert.deepEqual(review.total, usd(37.5));

  await assert.rejects(run.approve("amazon", { ...approvalFor(review), approvedTotal: usd(35) }), LimitError);
  await assert.rejects(run.approve("walmart", approvalFor({ ...review, store: "walmart" })), LimitError);
  assert.equal(a.calls.placeOrder, 0);

  const order = await run.approve("amazon", approvalFor(review));
  assert.equal(order.placed, true);
  assert.equal(a.calls.placeOrder, 1);
  await assert.rejects(run.approve("amazon", approvalFor(review)), /already placed/);
  assert.equal(a.calls.placeOrder, 1, "one approval, one order");
  const s = await run.close();
  assert.equal(s.orders.length, 1);
  await assert.rejects(run.approve("amazon", approvalFor(review)), /closed/);
});

test("engine: a store that needs sign-in emits needs_user and cannot be approved", async () => {
  const a = new FakeAdapter("amazon", { catalog: { hub: [offer("amazon", "USB-C hub", 30)] }, needsSignIn: true });
  const { agent, events, onEvent, dataDir } = await setup({ amazon: a });
  const run = await agent.run("a usb-c hub on amazon", { onEvent, until: "review" });
  const nu = events.find((e) => e.type === "needs_user");
  assert.ok(nu && nu.type === "needs_user" && nu.needs.reason === "sign_in");
  await assert.rejects(run.approve("amazon", approvalFor(run.reviews.get("amazon")!)), /needs the person/);
  assert.equal(a.calls.placeOrder, 0);
  await run.close();
  // History keeps the live link without its single-use code.
  const saved = await readFile(join(dataDir, "runs", run.runId, "events.jsonl"), "utf8");
  assert.ok(!saved.includes("secretcode"));
  assert.ok(saved.includes("single-use code removed"));
});

test("engine: membership line at checkout blocks approval", async () => {
  const a = new FakeAdapter("amazon", {
    catalog: { hub: [offer("amazon", "USB-C hub", 30)] },
    extraReviewLine: { title: "Amazon Prime free trial", quantity: 1, price: usd(0) },
  });
  const { agent, onEvent } = await setup({ amazon: a });
  const run = await agent.run("a usb-c hub on amazon", { onEvent, until: "review" });
  await assert.rejects(run.approve("amazon", approvalFor(run.reviews.get("amazon")!)), /membership line/);
  assert.equal(a.calls.placeOrder, 0);
  await run.close();
});

test("engine: a failing store never fails the run", async () => {
  const bad = new FakeAdapter("ebay", { catalog: {}, failSearch: true });
  const { agent, events, onEvent } = await setup({ amazon: amazon(), walmart: walmart(), ebay: bad }, {}, ["walmart"]);
  const run = await agent.run("a usb-c hub on amazon, walmart and ebay", { onEvent, until: "picks" });
  const failed = events.filter((e) => e.type === "store_failed").map((e) => e.type === "store_failed" && `${e.store}:${e.stage}`);
  assert.deepEqual(failed.sort(), ["ebay:search", "walmart:search"]);
  assert.equal(run.picks.length, 1);
  assert.equal(run.picks[0].offer.store, "amazon");
  assert.equal(run.isClosed, true, "until picks closes by default");
});

test("engine: a missing adapter is a clear store failure", async (t) => {
  markAdapterMissing("target");
  t.after(() => unregisterAdapter("target"));
  const { agent, events, onEvent } = await setup({ amazon: amazon() });
  const run = await agent.run("a usb-c hub on amazon or target.com", { onEvent, until: "picks" });
  const f = events.find((e) => e.type === "store_failed" && e.store === "target");
  assert.ok(f && f.type === "store_failed");
  assert.match(f.error, /Target adapter is not installed/);
  assert.equal(run.picks.length, 1);
});

test("engine: per-store timeout", async () => {
  const slow = new FakeAdapter("walmart", { catalog: { hub: [offer("walmart", "USB-C hub", 1)] }, searchDelayMs: 500 });
  const { agent, events, onEvent } = await setup({ amazon: amazon(), walmart: slow }, { stepTimeoutMs: 100 });
  const run = await agent.run("a usb-c hub on amazon or walmart", { onEvent, until: "picks" });
  const f = events.find((e) => e.type === "store_failed");
  assert.ok(f && f.type === "store_failed" && f.store === "walmart" && /timed out/.test(f.error));
  assert.equal(run.picks[0].offer.store, "amazon");
});

test("engine: over budget stops before the carts", async () => {
  const a = amazon();
  const { agent, events, onEvent } = await setup({ amazon: a });
  const run = await agent.run("a usb-c hub on amazon, budget $20", { onEvent, until: "cart" });
  const p = events.find((e) => e.type === "picks");
  assert.ok(p && p.type === "picks" && p.overBudget);
  assert.equal(a.calls.addToCart, 0);
  assert.ok(events.some((e) => e.type === "log" && /Stopped: .*over the \$20\.00 budget/.test(e.message)));
  await assert.rejects(run.fillCarts(), LimitError);
  await run.close();
});

test("engine: limits.allowedStores and maxCreditsPerRun", async () => {
  const { agent, events, onEvent } = await setup({ amazon: amazon(), walmart: walmart() });
  await agent.run("a usb-c hub on amazon or walmart", { onEvent, until: "picks", limits: { allowedStores: ["amazon"] } });
  assert.ok(events.some((e) => e.type === "store_failed" && e.store === "walmart" && /not in the allowed stores/.test(e.error)));

  const t = await setup({ amazon: amazon(), walmart: walmart() });
  // Each fake browser asks for 5 credits: a cap of 7 opens one store and refuses the second.
  const run = await t.agent.run("a usb-c hub on amazon or walmart", { onEvent: t.onEvent, until: "picks", limits: { maxCreditsPerRun: 7 } });
  const refused = t.events.filter((e) => e.type === "store_failed" && /credits/.test(e.error));
  assert.equal(refused.length, 1);
  assert.equal(run.picks.length, 1);
  assert.equal(run.summary().creditsUsed, 5);
});

test("engine: details() fills shipping before ranking; Shopify domains share one browser", async () => {
  const d = new FakeDetailAdapter("amazon", { catalog: { hub: [offer("amazon", "USB-C hub", 30, { shipping: undefined })] } });
  const shop = new FakeAdapter("shopify", {
    catalog: { hub: [offer("shopify", "USB-C hub", 31, { storeDomain: "" })] },
  });
  const { agent, onEvent, browsers } = await setup({ amazon: d, shopify: shop });
  const run = await agent.run("a usb-c hub on amazon, from a.com and b.com", { onEvent, until: "picks" });
  assert.equal(d.calls.details, 1);
  const am = run.offers.find((o) => o.store === "amazon")!;
  assert.deepEqual(am.shipping, usd(4.99));
  assert.equal(browsers.opened.filter((b) => b.store === "shopify").length, 1);
  assert.deepEqual(run.offers.filter((o) => o.store === "shopify").map((o) => o.storeDomain).sort(), ["a.com", "b.com"]);
});

test("engine: run history is saved and listed", async () => {
  const { agent, onEvent, dataDir } = await setup({ amazon: amazon() });
  const run = await agent.run("a usb-c hub on amazon", { onEvent, until: "review" });
  await run.close();
  const runs = await listRuns(dataDir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, run.runId);
  assert.equal(runs[0].picks, 1);
  const saved = await getRun(run.runId, dataDir);
  assert.ok(saved?.summary?.finishedAt);
  assert.equal(saved?.request?.items[0].query, "usb-c hub");
  assert.ok(saved!.events.some((e) => e.type === "done"));
  assert.ok(saved!.screenshots.length >= 2, "cart and review screenshots");
  assert.ok(saved!.summary!.screenshots!.every((s) => s.path.includes(run.runId)));
  assert.deepEqual((await readdir(join(dataDir, "runs", run.runId))).sort(), ["events.jsonl", "request.json", "screenshots", "summary.json"]);
  assert.equal(await getRun("../etc", dataDir), undefined);
});

test("engine: fillCart fills one store at a time; run options set zip, stores and shop domains", async () => {
  const a = amazon(), w = walmart();
  const { agent, onEvent, events } = await setup({ amazon: a, walmart: w });
  const run = await agent.run("2 usb-c cables and a usb-c hub", {
    onEvent, until: "picks", close: false, zip: "82001", defaultStores: ["amazon", "walmart"], shopifyDomains: ["shop.example.com"],
  });
  assert.equal(run.request.zip, "82001");
  assert.deepEqual(run.request.stores, ["amazon", "walmart"]);
  assert.equal(run.request.shopifyDomains, undefined, "shop domains only when shopify is searched");
  assert.equal(a.calls.addToCart + w.calls.addToCart, 0);
  const carts = await run.fillCart("walmart");
  assert.equal(carts.length, 1);
  assert.equal(carts[0].store, "walmart");
  assert.equal(w.calls.addToCart, 1);
  assert.equal(a.calls.addToCart, 0, "amazon untouched");
  assert.deepEqual(await run.fillCart("target"), []);
  run.note("picked by the person", "walmart");
  assert.ok(events.some((e) => e.type === "log" && e.message === "picked by the person"));
  await run.close();
});

test("engine: a ShoppingRequest object skips parsing", async () => {
  const { agent, onEvent } = await setup({ walmart: walmart() });
  const run = await agent.run({ prompt: "", stores: ["walmart"], items: [{ id: "", query: "cable", description: "", quantity: 3 }] } as never, { onEvent, until: "picks" });
  assert.equal(run.request.items[0].id, "item-1");
  assert.equal(run.picks[0].offer.store, "walmart");
});
