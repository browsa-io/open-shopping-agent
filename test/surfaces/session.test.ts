import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "../../src/core/types.js";
import { MockEngine, parseDemoPrompt } from "../../src/web/mock-engine.js";
import { RunHub } from "../../src/web/session.js";

const hubOf = (o: ConstructorParameters<typeof MockEngine>[0] = {}) => new RunHub(new MockEngine({ speed: 0, ...o }));

test("cancelAll stops every running run and waits until each has ended (server shutdown)", async () => {
  const hub = new RunHub(new MockEngine({ speed: 1 }));
  const a = hub.start("usb-c hub and hdmi cable");
  const b = hub.start("aa batteries");
  assert.equal(a.status, "running");
  const n = await hub.cancelAll(10_000);
  assert.equal(n, 2);
  assert.equal(a.status, "cancelled");
  assert.equal(b.status, "cancelled");
  assert.ok(a.summary && b.summary, "both runs ended (browsers closed) before cancelAll returned");
  assert.equal(await hub.cancelAll(), 0, "nothing left to stop");
});

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

test("fill carts with a plan: a swap moves an item to another store, quantity reaches the cart", async () => {
  const hub = hubOf({ signInStore: null, failStore: null });
  const run = hub.start("usb-c hub and 6 ft hdmi", { limits: { allowedStores: ["amazon", "walmart", "ebay"] } });
  await hub.waitFor(run.runId, (r) => r.gates.some((g) => g.step === "cart"), 5000);
  const picks = (run.events.find((e) => e.type === "picks") as Extract<RunEvent, { type: "picks" }>).picks;
  const item = picks[0];
  const offers = run.events.flatMap((e) => (e.type === "offers" && e.itemId === item.itemId ? e.offers : []));
  const other = offers.find((o) => o.store !== item.offer.store && o.inStock)!;
  await assert.rejects(hub.fillCarts(run.runId, [{ itemId: item.itemId, offerKey: "amazon|https://nope.example/x" }]), /not in this run/);
  const stores = await hub.fillCarts(run.runId, [{ itemId: item.itemId, offerKey: `${other.store}|${other.url}`, quantity: 2 }]);
  assert.ok(stores.includes(other.store));
  const latest = [...run.events].reverse().find((e) => e.type === "picks") as Extract<RunEvent, { type: "picks" }>;
  assert.equal(latest.picks.find((p) => p.itemId === item.itemId)?.offer.url, other.url);
  assert.equal(latest.picks.find((p) => p.itemId === item.itemId)?.reason, "Your choice");
  // every store with a pick fills its cart without another question
  await hub.waitFor(run.runId, (r) => stores.every((s) => r.events.some((e) => e.type === "cart" && e.cart.store === s)), 5000);
  const cart = run.events.find((e) => e.type === "cart" && e.cart.store === other.store) as Extract<RunEvent, { type: "cart" }>;
  const line = cart.cart.lines.find((l) => l.url === other.url)!;
  assert.equal(line.quantity, 2);
  assert.equal(line.price.cents, other.price.cents * 2);
  await hub.cancel(run.runId);
  await run.done;
  await assert.rejects(hub.fillCarts(run.runId), /not running/);
});
