// Up-front approval ("mandate", 0.2.0): the engine buys without a prompt only inside the limits
// the person set, through the same gate as a clicked approval, and asks (saying why) otherwise.
// Fake adapters and browsers only: no store is contacted, nothing is bought, no card data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoppingAgent } from "../../src/core/engine.js";
import { approvalFor, approvalProblem, mandateApprovalFor, resolveLimits } from "../../src/core/limits.js";
import {
  MandateError, boughtUnderMandateText, makeMandate, mandateCovers, mandateFromEnv, mandateProblem, mandateQuestion, mandateLimits, parseDuration,
  type Mandate, type MandateInput,
} from "../../src/core/mandate.js";
import type { Approval, CheckoutReview, OrderResult, RunEvent, StoreId } from "../../src/core/types.js";
import type { StoreAdapter, StoreContext } from "../../src/stores/adapter.js";
import { FakeAdapter, fakeBrowsers, offer, usd, type FakeOptions } from "./fake-adapter.js";

const hub = (store: StoreId, price: number, extra: Partial<FakeOptions> = {}) =>
  new FakeAdapter(store, { catalog: { hub: [offer(store, "USB-C hub HDMI", price)] }, taxCents: 0, ...extra });

async function runWith(adapters: Partial<Record<StoreId, StoreAdapter>>, mandate: Mandate | undefined, extra: { budget?: number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-mandate-"));
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({
    llm: false, dataDir, adapters, openBrowser: fakeBrowsers().open, watchLinks: false, screenshots: false,
    stepTimeoutMs: 500, orderVerifyAttempts: 1, orderVerifyDelayMs: 0, orderGraceMs: 20,
  });
  const stores = Object.keys(adapters) as StoreId[];
  const run = await agent.run(`a usb-c hub on ${stores.join(" or ")}`, {
    onEvent: (e) => events.push(e), until: "review", everyStore: stores.length > 1, mandate,
    limits: { allowedStores: stores, ...(extra.budget ? { budget: usd(extra.budget) } : {}) },
  });
  return { run, events, dataDir };
}

const mandate = (i: Partial<MandateInput> = {}, now?: Date) => makeMandate({ maxTotal: 60, ...i }, "library", now);
const of = <T extends RunEvent["type"]>(events: RunEvent[], type: T) => events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

// ---------- the engine ----------

test("mandate: a checkout within it is bought with no prompt, logged as approval_source mandate with the limits", async () => {
  const a = hub("amazon", 40);
  const m = mandate({ stores: "amazon" });
  const { run, events, dataDir } = await runWith({ amazon: a }, m);
  assert.equal(a.calls.placeOrder, 1);
  assert.equal(a.placed[0].source, "mandate");
  assert.equal(a.placed[0].mandateId, m.id);
  assert.deepEqual(a.placed[0].approvedTotal, usd(40), "the approval is the exact review total");
  assert.equal(of(events, "awaiting_approval").length, 0, "nobody was asked");
  const states = of(events, "order_state");
  assert.deepEqual(states.map((s) => s.state), ["proposed", "awaiting_approval", "placing", "placed"]);
  for (const s of states.slice(2)) {
    assert.equal(s.approval_source, "mandate");
    assert.deepEqual(s.mandate, { maxTotal: usd(60), stores: ["amazon"] });
  }
  const order = of(events, "order")[0].result;
  assert.equal(order.placed, true);
  assert.equal(order.approval_source, "mandate");
  assert.match(of(events, "log").map((l) => l.message).join("\n"), /Bought under your up-front approval \(up to \$60\)/);
  const s = await run.close();
  assert.deepEqual(s.mandate, { maxTotal: usd(60), stores: ["amazon"] });
  // Saved in the run history.
  const lines = (await readFile(join(dataDir, "runs", run.runId, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const placed = lines.find((l) => l.type === "order_state" && l.state === "placed");
  assert.equal(placed.approval_source, "mandate");
  assert.deepEqual(placed.mandate.maxTotal, usd(60));
});

test("mandate: a total above maxTotal asks, says why, and the person can still approve the exact total", async () => {
  const a = hub("amazon", 75);
  const { run, events } = await runWith({ amazon: a }, mandate());
  assert.equal(a.calls.placeOrder, 0);
  const wait = of(events, "awaiting_approval");
  assert.equal(wait.length, 1);
  assert.match(wait[0].mandateDeclined ?? "", /\$75\.00 is over your up-front limit of \$60 per order/);
  assert.ok(of(events, "log").some((l) => /Not bought without asking: .*over your up-front limit/.test(l.message)), "the person sees why");
  const r = await run.approve("amazon", approvalFor(run.reviews.get("amazon")!));
  assert.equal(r.placed, true);
  assert.equal(r.approval_source, "user");
  await run.close();
});

test("mandate: a store it does not name asks", async () => {
  const w = hub("walmart", 20);
  const { run, events } = await runWith({ walmart: w }, mandate({ stores: ["target", "allbirds.com"] }));
  assert.equal(w.calls.placeOrder, 0);
  assert.match(of(events, "awaiting_approval")[0].mandateDeclined ?? "", /walmart is not one of the stores you approved up front/);
  await run.close();
});

test("mandate: an expired one asks", async () => {
  const a = hub("amazon", 20);
  const m = mandate({ expiresIn: "1m" }, new Date(Date.now() - 5 * 60_000));
  const { run, events } = await runWith({ amazon: a }, m);
  assert.equal(a.calls.placeOrder, 0);
  assert.match(of(events, "awaiting_approval")[0].mandateDeclined ?? "", /expired/);
  await run.close();
});

test("mandate: maxOrders reached asks for the next store", async () => {
  const a = hub("amazon", 20);
  const w = hub("walmart", 25);
  const { run, events } = await runWith({ amazon: a, walmart: w }, mandate({ maxOrders: 1 }));
  assert.equal(a.calls.placeOrder + w.calls.placeOrder, 1, "one order under the mandate");
  const wait = of(events, "awaiting_approval");
  assert.equal(wait.length, 1);
  assert.match(wait[0].mandateDeclined ?? "", /allows 1 order in this run, and one was already placed/);
  await run.close();
});

test("mandate: maxRunTotal counts an order being placed in parallel, so two stores cannot both pass", async () => {
  const a = hub("amazon", 40);
  const w = hub("walmart", 45);
  const { run, events } = await runWith({ amazon: a, walmart: w }, mandate({ maxRunTotal: 70 }));
  assert.equal(a.calls.placeOrder + w.calls.placeOrder, 1);
  assert.match(of(events, "awaiting_approval")[0].mandateDeclined ?? "", /over your up-front limit of \$70 for the run/);
  await run.close();
});

test("mandate: the budget still applies", async () => {
  // $40 picked (within the $45 budget); tax at checkout makes it $50: within the mandate, over the budget.
  const a = hub("amazon", 40, { taxCents: 1000 });
  const { run, events } = await runWith({ amazon: a }, mandate(), { budget: 45 });
  assert.equal(a.calls.addToCart, 1);
  assert.equal(a.calls.placeOrder, 0);
  assert.match(of(events, "awaiting_approval")[0].mandateDeclined ?? "", /over the \$45\.00 budget/);
  await run.close();
});

test("mandate: the total re-read before the click changed, so no order", async () => {
  const a = hub("amazon", 30, { priceJumpCents: 150 });
  const { run, events } = await runWith({ amazon: a }, mandate());
  assert.equal(a.calls.placeOrder, 1, "the adapter was called and re-read the total");
  assert.equal(a.placed.length, 0, "nothing was clicked");
  const order = of(events, "order")[0].result;
  assert.equal(order.placed, false);
  assert.equal(order.state, "failed");
  assert.equal(order.approval_source, "mandate");
  assert.deepEqual(of(events, "order_state").map((s) => s.state).slice(-2), ["placing", "failed"]);
  await run.close();
});

test("mandate: a subscription line is refused, with or without the mandate", async () => {
  const a = hub("amazon", 20, { extraReviewLine: { title: "Subscribe & Save: deliver every 2 months", quantity: 1, price: usd(0) } });
  const { run, events } = await runWith({ amazon: a }, mandate());
  assert.equal(a.calls.placeOrder, 0);
  assert.match(of(events, "awaiting_approval")[0].mandateDeclined ?? "", /subscription line/);
  await assert.rejects(run.approve("amazon", approvalFor(run.reviews.get("amazon")!)), /subscription line/);
  assert.equal(a.calls.placeOrder, 0);
  await run.close();
});

/** Clicks Place order, then the page dies: the order may have gone through. */
class ClickThenCrash extends FakeAdapter {
  async placeOrder(_ctx: StoreContext, _approval: Approval): Promise<OrderResult> {
    this.calls.placeOrder++;
    throw new Error("page.waitForTimeout: Target page, context or browser has been closed");
  }
}

test("mandate: an 'unknown' order is never clicked again, not by the mandate, not by the person", async () => {
  const a = new ClickThenCrash("amazon", { catalog: { hub: [offer("amazon", "USB-C hub HDMI", 30)] } });
  const { run, events } = await runWith({ amazon: a }, mandate());
  assert.equal(a.calls.placeOrder, 1);
  const order = of(events, "order")[0].result;
  assert.equal(order.state, "unknown");
  assert.equal(order.approval_source, "mandate");
  await assert.rejects(run.reviewCheckout("amazon"), /may have gone through/);
  await assert.rejects(run.approve("amazon", approvalFor(run.reviews.get("amazon")!)), /may have gone through|already placed/);
  assert.equal(a.calls.placeOrder, 1, "one click, ever");
  await run.close();
});

test("mandate: approve() refuses an approval that claims to be under a mandate", async () => {
  const a = hub("amazon", 75);
  const m = mandate();
  const { run } = await runWith({ amazon: a }, m);
  const review = run.reviews.get("amazon")!;
  await assert.rejects(run.approve("amazon", mandateApprovalFor(review, m)), /applied by the engine itself/);
  assert.equal(a.calls.placeOrder, 0);
  await run.close();
});

test("mandate: an invalid one (not granted by the user) is not used, and the run says so", async () => {
  const a = hub("amazon", 20);
  const forged = { ...mandate(), grantedBy: "model" } as unknown as Mandate;
  const { run, events } = await runWith({ amazon: a }, forged);
  assert.equal(a.calls.placeOrder, 0);
  assert.equal(of(events, "awaiting_approval").length, 1);
  assert.ok(of(events, "log").some((l) => /Up-front approval not used/.test(l.message)));
  await run.close();
});

test("mandate: a 3-D Secure or sign-in step still goes to the person", async () => {
  const a = hub("amazon", 20, { needsSignIn: true });
  const { run, events } = await runWith({ amazon: a }, mandate());
  assert.equal(a.calls.placeOrder, 0);
  assert.equal(of(events, "needs_user").length, 1);
  assert.equal(of(events, "awaiting_approval").length, 0);
  await run.close();
});

// ---------- the gate (pure) ----------

const review = (cents: number, store: StoreId = "amazon", domain = "amazon.com"): CheckoutReview => ({
  store, storeDomain: domain, lines: [{ title: "USB-C hub", quantity: 1, price: { cents, currency: "USD" } }], total: { cents, currency: "USD" }, reviewedAt: new Date().toISOString(),
});

test("gate: a mandate approval needs the run's mandate, the same id and its limits; the exact-total rules still hold", () => {
  const m = mandate({ stores: "amazon,allbirds.com" });
  const r = review(4000);
  const base = { store: "amazon" as StoreId, review: r, limits: resolveLimits(), placed: usd(0), ordered: new Set<string>() };
  const ap = mandateApprovalFor(r, m);
  assert.equal(approvalProblem({ ...base, approval: ap, mandate: m, mandateOrders: 0 }), undefined);
  assert.match(approvalProblem({ ...base, approval: ap })!, /no up-front approval/);
  assert.match(approvalProblem({ ...base, approval: ap, mandate: { ...m, id: "mnd_other" } })!, /another up-front approval/);
  assert.match(approvalProblem({ ...base, approval: { ...ap, approvedTotal: usd(39) }, mandate: m })!, /does not match the review total/);
  assert.match(approvalProblem({ ...base, review: review(7000), approval: mandateApprovalFor(review(7000), m), mandate: m })!, /over your up-front limit/);
  assert.match(approvalProblem({ ...base, approval: ap, mandate: m, ordered: new Set(["amazon"]) })!, /already placed/);
  // Shopify: the shop's domain must be named.
  const sr = review(3000, "shopify", "allbirds.com");
  assert.equal(approvalProblem({ ...base, store: "shopify", storeDomain: "allbirds.com", review: sr, approval: mandateApprovalFor(sr, m), mandate: m }), undefined);
  const other = review(3000, "shopify", "other.example");
  assert.match(approvalProblem({ ...base, store: "shopify", storeDomain: "other.example", review: other, approval: mandateApprovalFor(other, m), mandate: m })!, /not one of the stores/);
});

test("mandate: making one, its limits and its words", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const m = makeMandate({ maxTotal: "$60", stores: "Walmart, target.com, Best Buy, allbirds.com", expiresIn: "2h", maxRunTotal: "100", maxOrders: "2" }, "cli", now);
  assert.deepEqual(mandateLimits(m), { maxTotal: usd(60), maxRunTotal: usd(100), stores: ["walmart", "target", "bestbuy", "allbirds.com"], expiresAt: "2026-11-19T14:00:00.000Z", maxOrders: 2 });
  assert.equal(m.grantedBy, "user");
  assert.match(m.id, /^mnd_[0-9a-f]{16}$/);
  assert.equal(mandateQuestion({ maxTotal: usd(60), stores: ["walmart", "target"] }), "Buy without asking, up to $60 per order at walmart, target, for this run only?");
  assert.equal(boughtUnderMandateText({ maxTotal: usd(60) }), "Bought under your up-front approval (up to $60)");
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.throws(() => parseDuration("forever"), MandateError);
  assert.throws(() => makeMandate({ maxTotal: 0 }, "cli"), /more than \$0/);
  assert.throws(() => makeMandate({ maxTotal: "sixty" }, "cli"), /amount in dollars/);
  assert.throws(() => makeMandate({ maxTotal: 60_000 }, "cli"), /over the/);
  assert.throws(() => makeMandate({ maxTotal: { cents: 6000, currency: "EUR" } }, "cli"), /US dollars/);
  assert.throws(() => makeMandate({ maxTotal: 60, stores: "costco" }, "cli"), /Unknown store/);
  assert.throws(() => makeMandate({ maxTotal: 60, maxRunTotal: 30 }, "cli"), /less than/);
  assert.throws(() => makeMandate({ maxTotal: 60, expiresAt: "2020-01-01T00:00:00Z" }, "cli", now), /past/);
  assert.equal(mandateCovers(m, "shopify", "www.allbirds.com"), true);
  assert.equal(mandateCovers(m, "amazon"), false);
  // Non-USD checkouts never count.
  assert.match(mandateProblem(m, { store: "walmart", total: { cents: 5000, currency: "CAD" }, now, ordersSoFar: 0, runTotal: usd(0) })!, /US dollars only/);
});

test("mandate: from the MCP server's environment only with orders on", () => {
  assert.equal(mandateFromEnv({}), undefined);
  assert.throws(() => mandateFromEnv({ OSA_MCP_APPROVE_UP_TO: "60" }), /OSA_MCP_ALLOW_ORDERS=1/);
  const m = mandateFromEnv({ OSA_MCP_ALLOW_ORDERS: "1", OSA_MCP_APPROVE_UP_TO: "60", OSA_MCP_APPROVE_STORES: "walmart,target", OSA_MCP_APPROVE_EXPIRES: "2h" }, new Date("2026-11-19T12:00:00.000Z"))!;
  assert.deepEqual(mandateLimits(m), { maxTotal: usd(60), stores: ["walmart", "target"], expiresAt: "2026-11-19T14:00:00.000Z" });
  assert.equal(m.via, "mcp_env");
});
