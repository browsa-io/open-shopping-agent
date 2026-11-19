// The order state machine and the engine's "unknown" order state, with fake adapters and a fake
// page. No store is contacted and nothing is bought.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Page } from "playwright-core";
import { ShoppingAgent, type ShoppingAgentOptions } from "../../src/core/engine.js";
import { approvalFor } from "../../src/core/limits.js";
import { OrderStateError, OrderTracker, approvalId, blocksNewOrder, canMove } from "../../src/core/order-state.js";
import type { Approval, OrderResult, OrderState, RunEvent, StoreId } from "../../src/core/types.js";
import type { StoreBrowser } from "../../src/core/browsers.js";
import type { StoreContext } from "../../src/stores/adapter.js";
import { FakeAdapter, offer } from "./fake-adapter.js";

// ---------- the machine ----------

test("order states: only the documented moves are allowed", () => {
  assert.equal(canMove(undefined, "proposed"), true);
  assert.equal(canMove(undefined, "placing"), false);
  assert.equal(canMove("proposed", "awaiting_approval"), true);
  assert.equal(canMove("proposed", "placing"), false, "no order without an approvable review");
  assert.equal(canMove("awaiting_approval", "placing"), true);
  for (const end of ["placed", "failed", "unknown"] as OrderState[]) assert.equal(canMove("placing", end), true);
  assert.equal(canMove("placing", "placing"), false, "a second click while placing is refused");
  assert.equal(canMove("failed", "proposed"), true, "nothing was submitted: a new review may start");
  for (const s of ["placed", "unknown"] as OrderState[]) {
    for (const to of ["proposed", "awaiting_approval", "placing", "placed", "failed", "unknown"] as OrderState[]) assert.equal(canMove(s, to), false, `${s} -> ${to}`);
  }
  assert.equal(blocksNewOrder("placing"), true);
  assert.equal(blocksNewOrder("unknown"), true);
  assert.equal(blocksNewOrder("failed"), false);
});

test("order states: the tracker keeps history and refuses bad moves and reused approvals", () => {
  const t = new OrderTracker();
  t.move("amazon", "proposed", { store: "amazon" });
  t.move("amazon", "awaiting_approval", { store: "amazon" });
  t.move("amazon", "placing", { store: "amazon" });
  assert.throws(() => t.move("amazon", "placing", { store: "amazon" }), OrderStateError);
  t.move("amazon", "unknown", { store: "amazon", message: "check" });
  assert.deepEqual(t.history.map((h) => h.state), ["proposed", "awaiting_approval", "placing", "unknown"]);
  assert.equal(t.snapshot().amazon.state, "unknown");
  assert.equal(t.useApproval("apr_1"), true);
  assert.equal(t.useApproval("apr_1"), false);
  const a: Approval = { store: "amazon", approvedTotal: { cents: 100, currency: "USD" }, approvedAt: "2026-11-19T10:00:00.000Z", by: "user" };
  assert.equal(approvalId("run-1", a), approvalId("run-1", { ...a }), "the same approval twice has one id");
  assert.notEqual(approvalId("run-1", a), approvalId("run-2", a));
});

// ---------- the engine ----------

type Behaviour = "hang" | "throw-after-click" | "placed-no-number" | "placed" | "refuse" | "late";

/** placeOrder that clicks (the page becomes `after`) and then behaves as asked. */
class Placing extends FakeAdapter {
  constructor(private how: Behaviour, private page: FakePage, private after?: PageState) {
    super("amazon", { catalog: { hub: [offer("amazon", "USB-C hub", 30)] }, taxCents: 210 });
  }
  async placeOrder(_ctx: StoreContext, approval: Approval): Promise<OrderResult> {
    this.calls.placeOrder++;
    if (this.how === "refuse") return { store: "amazon", placed: false, error: "Amazon total is now $33.00; order not placed" };
    if (this.after) this.page.state = this.after; // the click went through
    switch (this.how) {
      case "hang": return new Promise(() => {});
      case "late": return new Promise((r) => setTimeout(() => r({ store: "amazon", placed: true, submitted: true, orderId: "111-2222222-3333333", total: approval.approvedTotal }), 60));
      case "throw-after-click": throw new Error("page.waitForTimeout: Target page, context or browser has been closed");
      case "placed-no-number": return { store: "amazon", placed: true, submitted: true, total: approval.approvedTotal, confirmationText: "Order placed" };
      default: return { store: "amazon", placed: true, submitted: true, orderId: "111-2222222-3333333", total: approval.approvedTotal };
    }
  }
}

interface PageState { url: string; text: string; links?: { text: string; href: string }[] }
interface FakePage { state: PageState }

const CONFIRMED: PageState = {
  url: "https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=106-1",
  text: "Order placed, thanks!\nConfirmation will be sent to your email.\nOrder# 111-2222222-3333333\nOrder total: $32.10",
  links: [{ text: "Review or edit your recent orders", href: "https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333" }],
};
const SPINNER: PageState = { url: "https://www.amazon.com/gp/buy/spc/handlers/display.html", text: "Placing your order..." };

function browserWith(page: FakePage) {
  return async (store: StoreId, domain: string): Promise<StoreBrowser> => {
    const p = {
      url: () => page.state.url,
      evaluate: async () => ({ title: "", text: page.state.text, links: page.state.links ?? [] }),
      screenshot: async ({ path }: { path: string }) => { await writeFile(path, "png"); return Buffer.from("png"); },
      isClosed: () => false,
    } as unknown as Page;
    return {
      store, agentId: `agt_fake_${store}`, mode: "burner", page: p,
      context(dom, extra): StoreContext {
        return {
          store, domain: dom, zip: extra.zip, page: p, agentId: `agt_fake_${store}`, signal: extra.signal, log: extra.log ?? (() => {}),
          aiTask: async () => { throw new Error("no AI in tests"); }, liveLink: async () => "https://browsa.io/live#c=x", newPage: async () => p,
        } as StoreContext;
      },
      async close() {},
    };
  };
}

async function reviewed(how: Behaviour, after?: PageState, extra: Partial<ShoppingAgentOptions> = {}) {
  const page: FakePage = { state: { url: "https://www.amazon.com/gp/buy/spc/handlers/display.html", text: "Review your order" } };
  const adapter = new Placing(how, page, after);
  const dataDir = await mkdtemp(join(tmpdir(), "osa-os-"));
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({
    llm: false, dataDir, adapters: { amazon: adapter }, openBrowser: browserWith(page), watchLinks: false, screenshots: false,
    stepTimeoutMs: 200, orderGraceMs: 50, orderVerifyAttempts: 2, orderVerifyDelayMs: 0, ...extra,
  });
  const run = await agent.run("a usb-c hub on amazon", { onEvent: (e) => events.push(e), until: "review" });
  return { run, adapter, events, dataDir, review: run.reviews.get("amazon")!, page };
}

const states = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: "order_state" }> => e.type === "order_state").map((e) => e.state);

test("engine: a Place order that times out with no confirmation is unknown, and is never clicked again", async () => {
  const { run, adapter, events, dataDir, review } = await reviewed("hang", SPINNER);
  const r = await run.approve("amazon", approvalFor(review));
  assert.equal(r.placed, false);
  assert.equal(r.state, "unknown");
  assert.match(r.error ?? "", /timed out/);
  assert.match(r.checkMessage ?? "", /Check your orders on Amazon \(https:\/\/www\.amazon\.com\/gp\/css\/order-history\)/);
  assert.equal(r.ordersUrl, "https://www.amazon.com/gp/css/order-history");
  assert.deepEqual(states(events), ["proposed", "awaiting_approval", "placing", "unknown"]);
  // Never again in this run: not with the same approval, not with a new one, not through a new review.
  await assert.rejects(run.approve("amazon", approvalFor(review)), /already placed|may have gone through/);
  await assert.rejects(run.approve("amazon", approvalFor(review, new Date(Date.now() + 1000))), /already placed|may have gone through/);
  await assert.rejects(run.reviewCheckout("amazon"), /may have gone through/);
  assert.equal(adapter.calls.placeOrder, 1);
  const s = await run.close();
  assert.equal(s.orderStates?.amazon.state, "unknown");
  // Saved in the run history.
  const saved = JSON.parse(await readFile(join(dataDir, "runs", run.runId, "summary.json"), "utf8"));
  assert.equal(saved.orderStates.amazon.state, "unknown");
  assert.equal(saved.orders[0].state, "unknown");
  const lines = (await readFile(join(dataDir, "runs", run.runId, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.type === "order_state").map((l) => l.state), ["proposed", "awaiting_approval", "placing", "unknown"]);
});

test("engine: a timeout whose page then shows the store's order number counts as placed", async () => {
  const { run, adapter, events, review } = await reviewed("hang", CONFIRMED);
  const r = await run.approve("amazon", approvalFor(review));
  assert.equal(r.placed, true);
  assert.equal(r.state, "placed");
  assert.equal(r.orderId, "111-2222222-3333333");
  assert.equal(r.orderUrl, "https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333");
  assert.deepEqual(states(events).slice(-2), ["placing", "placed"]);
  assert.equal(adapter.calls.placeOrder, 1);
  await run.close();
});

test("engine: an error after the click is placed only with an order number on the page, else unknown", async () => {
  const yes = await reviewed("throw-after-click", CONFIRMED);
  const r1 = await yes.run.approve("amazon", approvalFor(yes.review));
  assert.equal(r1.state, "placed");
  assert.equal(r1.orderId, "111-2222222-3333333");
  await yes.run.close();

  const no = await reviewed("throw-after-click", SPINNER);
  const r2 = await no.run.approve("amazon", approvalFor(no.review));
  assert.equal(r2.state, "unknown");
  assert.match(r2.error ?? "", /browser has been closed/);
  assert.ok(no.events.some((e) => e.type === "store_failed" && e.stage === "place_order"));
  await no.run.close();
});

test("engine: 'placed' without an order number is unknown unless the page shows one", async () => {
  const no = await reviewed("placed-no-number", SPINNER);
  const r = await no.run.approve("amazon", approvalFor(no.review));
  assert.equal(r.placed, false);
  assert.equal(r.state, "unknown");
  assert.match(r.error ?? "", /no order number/);
  await no.run.close();

  const yes = await reviewed("placed-no-number", CONFIRMED);
  const r2 = await yes.run.approve("amazon", approvalFor(yes.review));
  assert.equal(r2.state, "placed");
  assert.equal(r2.orderId, "111-2222222-3333333");
  await yes.run.close();
});

test("engine: an order number from the adapter is placed, with the order page from the confirmation", async () => {
  const { run, review } = await reviewed("placed", CONFIRMED);
  const r = await run.approve("amazon", approvalFor(review));
  assert.equal(r.state, "placed");
  assert.equal(r.orderUrl, "https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333");
  assert.ok(r.approvalId?.startsWith("apr_"));
  await run.close();
});

test("engine: a late answer after the time limit is used, not thrown away", async () => {
  const { run, review } = await reviewed("late", SPINNER, { stepTimeoutMs: 20, orderGraceMs: 2000 });
  const r = await run.approve("amazon", approvalFor(review));
  assert.equal(r.state, "placed");
  assert.equal(r.orderId, "111-2222222-3333333");
  await run.close();
});

test("engine: a refusal before the click is failed, and a new review may be approved", async () => {
  const { run, adapter, events, review } = await reviewed("refuse");
  const r = await run.approve("amazon", approvalFor(review));
  assert.equal(r.state, "failed");
  assert.equal(r.placed, false);
  // The same approval (a second click on the same button) is refused without touching the store.
  await assert.rejects(run.approve("amazon", approvalFor(review, new Date(Date.parse(review.reviewedAt) + 1))), /not waiting for approval|already used/);
  const again = await run.reviewCheckout("amazon");
  const a2 = approvalFor(again);
  await run.approve("amazon", a2);
  await assert.rejects(run.approve("amazon", a2), /already used|not waiting/);
  assert.equal(adapter.calls.placeOrder, 2);
  assert.deepEqual(states(events), ["proposed", "awaiting_approval", "placing", "failed", "proposed", "awaiting_approval", "placing", "failed"]);
  await run.close();
});

test("engine: a double click (two approvals at once) places one order", async () => {
  const { run, adapter, review } = await reviewed("placed", CONFIRMED);
  const a = approvalFor(review);
  const [x, y] = await Promise.allSettled([run.approve("amazon", a), run.approve("amazon", { ...a })]);
  assert.equal([x, y].filter((p) => p.status === "fulfilled").length, 1);
  assert.equal([x, y].filter((p) => p.status === "rejected").length, 1);
  assert.equal(adapter.calls.placeOrder, 1);
  await run.close();
});
