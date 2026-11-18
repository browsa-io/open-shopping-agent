import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../../src/core/types.js";
import { MockEngine, parseDemoPrompt } from "../../src/web/mock-engine.js";
import { RunHub } from "../../src/web/session.js";

const hubOf = (o: ConstructorParameters<typeof MockEngine>[0] = {}) => new RunHub(new MockEngine({ speed: 0, ...o }));

test("demo parser splits items, quantity and budget", () => {
  const r = parseDemoPrompt("usb-c hub and 6 ft hdmi under $60", ["amazon"]);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[1].quantity, 1);
  assert.deepEqual(r.items[1].options, { length: "6 ft" });
  assert.equal(r.budget?.cents, 6000);
  assert.equal(parseDemoPrompt("2 x hdmi cable", ["amazon"]).items[0].quantity, 2);
});

test("compare-only run ends after picks with no gates", async () => {
  const hub = hubOf();
  const run = hub.start("usb-c hub", { checkout: false, limits: { allowedStores: ["amazon", "walmart"] } });
  const summary = await run.done;
  const types = run.events.map((e) => e.type);
  assert.ok(types.includes("parsed") && types.includes("offers") && types.includes("picks"));
  assert.equal(types.at(-1), "done");
  assert.equal(summary.picks.length, 1);
  assert.equal(run.gates.length, 0);
  assert.ok(!types.includes("cart"));
});

test("gates, approval check and order through the hub", async () => {
  const hub = hubOf({ signInStore: null, failStore: null });
  const run = hub.start("usb-c hub and 6 ft hdmi", { limits: { allowedStores: ["amazon", "walmart", "ebay"] } });
  await hub.waitFor(run.runId, (r) => r.gates.some((g) => g.step === "cart"), 5000);
  const stores = [...new Set(run.gates.map((g) => g.store))];
  for (const s of stores) assert.equal(hub.answer(run.runId, "cart", s, true), true);
  assert.equal(hub.answer(run.runId, "cart", stores[0], true), false, "a gate answers once");
  await hub.waitFor(run.runId, (r) => r.gates.filter((g) => g.step === "checkout").length === stores.length, 5000);
  for (const s of stores) hub.answer(run.runId, "checkout", s, true);
  const store = stores[0];
  await hub.waitFor(run.runId, () => !!hub.pendingReview(run.runId, store), 5000);
  const review = hub.pendingReview(run.runId, store)!;
  await assert.rejects(hub.approve(run.runId, store, { cents: review.total.cents - 1, currency: "USD" }), /does not match/);
  await hub.approve(run.runId, store, review.total);
  for (const s of stores.slice(1)) {
    await hub.waitFor(run.runId, () => !!hub.pendingReview(run.runId, s), 5000);
    await hub.cancel(run.runId, s);
  }
  const summary = await run.done;
  assert.equal(summary.orders.filter((o) => o.placed).length, 1);
  assert.equal(summary.orders[0].store, store);
  const order = run.events.find((e): e is Extract<RunEvent, { type: "order" }> => e.type === "order");
  assert.equal(order?.result.total?.cents, review.total.cents);
});

test("sign-in store reports needs_user instead of asking for approval", async () => {
  const hub = hubOf({ signInStore: "amazon", failStore: null });
  const run = hub.start("usb-c hub", { limits: { allowedStores: ["amazon"] } });
  await hub.waitFor(run.runId, (r) => r.gates.length > 0, 5000);
  hub.answer(run.runId, "cart", "amazon", true);
  await hub.waitFor(run.runId, (r) => r.gates.length > 0, 5000);
  hub.answer(run.runId, "checkout", "amazon", true);
  await run.done;
  assert.ok(run.events.some((e) => e.type === "needs_user" && e.needs.reason === "sign_in"));
  assert.ok(!run.events.some((e) => e.type === "awaiting_approval"));
});

test("cancelling a run declines open gates and finishes it", async () => {
  const hub = hubOf();
  const run = hub.start("usb-c hub", { limits: { allowedStores: ["amazon"] } });
  await hub.waitFor(run.runId, (r) => r.gates.length > 0, 5000);
  await hub.cancel(run.runId);
  const summary = await run.done;
  assert.equal(summary.carts.length, 0);
  assert.equal(run.gates.length, 0);
  const list = await hub.list();
  assert.equal(list[0].runId, run.runId);
  assert.equal(list[0].status, "cancelled");
});
