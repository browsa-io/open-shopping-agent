// Exit errors get a fresh browser (new address) and the run goes on; "every store" fills a cart per store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoppingAgent } from "../../src/core/engine.js";
import { pickEveryStore } from "../../src/core/rank.js";
import type { Cart, ItemRequest, Offer, RunEvent, ShoppingRequest, StoreId } from "../../src/core/types.js";
import type { StoreContext } from "../../src/stores/adapter.js";
import { isExitError } from "../../src/stores/util.js";
import { FakeAdapter, fakeBrowsers, offer, usd } from "./fake-adapter.js";

const TUNNEL = "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.amazon.com/s?k=hub";

/** Amazon whose first browser cannot reach the store (each browser has its own agent id). */
class TunnelAmazon extends FakeAdapter {
  badAgent?: string;
  agents: string[] = [];
  override async search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
    this.agents.push(ctx.agentId);
    if (!this.badAgent || this.badAgent === ctx.agentId) { this.badAgent = ctx.agentId; throw new Error(TUNNEL); }
    return super.search(ctx, item, limit);
  }
}

async function agentWith(stores: Partial<Record<StoreId, FakeAdapter>>) {
  const fb = fakeBrowsers();
  let n = 0;
  // Each opened browser gets its own agent id, like a fresh lease.
  const open: typeof fb.open = async (store, domain, spend) => {
    const b = await fb.open(store, domain, spend);
    const id = `agt_${store}_${++n}`;
    const ctxOf = b.context.bind(b);
    return { ...b, agentId: id, context: (d, extra) => ({ ...ctxOf(d, extra), agentId: id }) };
  };
  const dataDir = await mkdtemp(join(tmpdir(), "osa-renew-"));
  return { agent: new ShoppingAgent({ llm: false, dataDir, adapters: stores, openBrowser: open, watchLinks: false }), log: fb.log };
}

test("isExitError: proxy tunnel errors only", () => {
  assert.ok(isExitError(new Error(TUNNEL)));
  assert.ok(isExitError("net::ERR_PROXY_CONNECTION_FAILED"));
  assert.ok(!isExitError(new Error("net::ERR_HTTP2_PROTOCOL_ERROR")));
  assert.ok(!isExitError(new Error("Timeout 45000ms exceeded")));
});

test("engine: a tunnel error in the search opens a fresh browser for the store and the search goes on", async () => {
  const a = new TunnelAmazon("amazon", { catalog: { hub: [offer("amazon", "USB-C hub HDMI 4K", 35)] } });
  const { agent, log } = await agentWith({ amazon: a });
  const events: RunEvent[] = [];
  const run = await agent.run("a usb-c hub on amazon", { onEvent: (e) => events.push(e), until: "cart" });
  assert.equal(a.agents.length, 2);
  assert.notEqual(a.agents[0], a.agents[1], "the retry runs in another browser");
  assert.equal(log.opened.length, 2);
  assert.deepEqual(log.closed, ["amazon"], "the broken browser is stopped");
  assert.ok(events.some((e) => e.type === "log" && /retrying in a fresh browser \(new address\)/.test(e.message)));
  assert.equal(run.picks.length, 1);
  assert.equal(run.carts.size, 1);
  assert.ok(!events.some((e) => e.type === "store_failed"));
  await run.close();
});

test("engine: a tunnel error while adding to the cart refills the cart in a fresh browser", async () => {
  class TunnelCart extends FakeAdapter {
    seen: string[] = [];
    override async addToCart(ctx: StoreContext, o: Offer, q: number, opt?: Record<string, string>): Promise<Cart> {
      this.seen.push(ctx.agentId);
      if (this.seen.length === 2) throw new Error(TUNNEL); // the second item, first browser
      return super.addToCart(ctx, o, q, opt);
    }
  }
  const t = new TunnelCart("target", { catalog: { hub: [offer("target", "USB-C hub", 30)], cable: [offer("target", "HDMI cable 6 ft", 9)] } });
  const { agent } = await agentWith({ target: t });
  const run = await agent.run("a usb-c hub and an hdmi cable on target", { onEvent: () => {}, until: "cart" });
  assert.equal(t.seen.length, 4, "two adds, then both again in the fresh browser");
  assert.equal(new Set(t.seen.slice(2)).size, 1);
  assert.notEqual(t.seen[0], t.seen[2]);
  assert.ok(!run.failures?.length);
  await run.close();
});

test("engine: an add that times out after the item reached the cart is not a failure", async () => {
  class SlowAdd extends FakeAdapter {
    override async addToCart(ctx: StoreContext, o: Offer, q: number, opt?: Record<string, string>): Promise<Cart> {
      await super.addToCart(ctx, o, q, opt);
      return new Promise<Cart>(() => {}); // never answers, like a page that hangs after the add
    }
  }
  const w = new SlowAdd("walmart", { catalog: { hub: [{ ...offer("walmart", "USB-C hub", 20), productId: "w1" }] } });
  const { agent } = await agentWith({ walmart: w });
  (agent.options as { stepTimeoutMs?: number }).stepTimeoutMs = 200;
  const events: RunEvent[] = [];
  const run = await agent.run("a usb-c hub on walmart", { onEvent: (e) => events.push(e), until: "cart" });
  assert.ok(!run.failures.length, JSON.stringify(run.failures));
  assert.ok(events.some((e) => e.type === "log" && /timed out, but the cart shows it/.test(e.message)));
  assert.equal(run.carts.get("walmart")?.lines.length, 1);
  await run.close();
});

const req = (budget?: number): ShoppingRequest => ({
  prompt: "", stores: ["amazon", "walmart", "target"], items: [
    { id: "hub", query: "hub", description: "usb-c hub", quantity: 1 },
    { id: "cable", query: "cable", description: "hdmi cable", quantity: 1 },
  ], ...(budget ? { budget: usd(budget) } : {}),
}) as ShoppingRequest;

test("pickEveryStore: every item at each store, the cheapest full cart is the total, over-budget stores get no cart", () => {
  const offers: Offer[] = [
    { ...offer("amazon", "USB-C hub", 30), itemId: "hub" }, { ...offer("amazon", "HDMI cable", 8), itemId: "cable" },
    { ...offer("walmart", "USB-C hub", 25), itemId: "hub" }, { ...offer("walmart", "HDMI cable", 9), itemId: "cable" },
    { ...offer("target", "USB-C hub", 70), itemId: "hub" }, { ...offer("target", "HDMI cable", 10), itemId: "cable" },
  ];
  const r = pickEveryStore(req(60), offers);
  assert.deepEqual(r.picks.map((p) => `${p.offer.store}:${p.itemId}`), ["amazon:hub", "amazon:cable", "walmart:hub", "walmart:cable"]);
  assert.deepEqual(r.total, usd(34));
  assert.equal(r.overBudget, false);
  assert.ok(r.unpicked.some((u) => u.itemId === "*" && /Target: the cart would be \$80.00, over the \$60.00 budget/.test(u.reason)));
  assert.equal(pickEveryStore(req(20), offers).overBudget, true);
  assert.equal(pickEveryStore(req(), offers).picks.length, 6);
});

test("engine: everyStore fills a cart at each store", async () => {
  const a = new FakeAdapter("amazon", { catalog: { hub: [offer("amazon", "USB-C hub", 30)], cable: [offer("amazon", "HDMI cable 6 ft", 8)] } });
  const w = new FakeAdapter("walmart", { catalog: { hub: [offer("walmart", "USB-C hub", 25)], cable: [offer("walmart", "HDMI cable 6 ft", 9)] } });
  const { agent } = await agentWith({ amazon: a, walmart: w });
  const run = await agent.run("a usb-c hub and an hdmi cable on amazon or walmart", { onEvent: () => {}, until: "cart", everyStore: true });
  assert.equal(run.carts.size, 2);
  assert.equal(a.cart.length, 2);
  assert.equal(w.cart.length, 2);
  await run.close();
});
