// A store that refuses the browser's address (Amazon's "Sorry! Something went wrong" page, Access
// Denied, 403) gets one fresh browser on a new address of the same exit kind, on Browsa only.
// Seen live 2026-11-24: Amazon refused one residential US address twice in a run and the store
// failed, while other runs on other addresses worked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoppingAgent, type ShoppingAgentOptions } from "../../src/core/engine.js";
import type { ItemRequest, Offer, RunEvent, StoreId } from "../../src/core/types.js";
import type { StoreContext } from "../../src/stores/adapter.js";
import { BotCheckError, CaptchaHandoffError, isStoreRefusal, StoreRefusedError } from "../../src/stores/util.js";
import { friendlyError } from "../../web/lib/wording.js";
import { FakeAdapter, fakeBrowsers, offer } from "./fake-adapter.js";

const AMAZON_ERROR = "Amazon refused this browser: it shows its error page (\"Sorry! Something went wrong\") on this exit address. Try again later, or from another exit address.";
const RESIDENTIAL = { kind: "residential_us" as const, label: "Browsa residential (US)" };

/** Amazon that refuses the first `refuse` browsers it sees (each browser has its own agent id). */
class RefusingAmazon extends FakeAdapter {
  agents: string[] = [];
  constructor(private readonly refuse: number, private readonly err: () => Error = () => new StoreRefusedError(AMAZON_ERROR)) {
    super("amazon", { catalog: { airpods: [offer("amazon", "Apple AirPods Pro 3", 219)] } });
  }
  override async search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
    if (!this.agents.includes(ctx.agentId)) this.agents.push(ctx.agentId);
    if (this.agents.indexOf(ctx.agentId) < this.refuse) throw this.err();
    return super.search(ctx, item, limit);
  }
}

/** Fake browsers with their own agent ids; `browsa` marks them as Browsa fresh browsers (a new address is possible). */
async function agentWith(amazon: FakeAdapter, o: { browsa: boolean; extra?: Partial<ShoppingAgentOptions> }) {
  const fb = fakeBrowsers();
  const order: string[] = [];
  let n = 0;
  const open: typeof fb.open = async (store, domain, spend) => {
    const b = await fb.open(store, domain, spend);
    const id = `agt_${store}_${++n}`;
    order.push(`open ${id}`);
    const ctxOf = b.context.bind(b);
    return {
      ...b, agentId: id, context: (d, extra) => ({ ...ctxOf(d, extra), agentId: id }),
      ...(o.browsa ? { exit: RESIDENTIAL, freshAddress: true } : { exit: { kind: "default" as const, label: "this computer's connection" } }),
      close: async () => { order.push(`close ${id}`); await b.close(); },
    };
  };
  const dataDir = await mkdtemp(join(tmpdir(), "osa-fresh-"));
  const agent = new ShoppingAgent({ llm: false, dataDir, adapters: { amazon } as Partial<Record<StoreId, FakeAdapter>>, openBrowser: open, watchLinks: false, ...o.extra });
  return { agent, log: fb.log, order };
}

const logs = (events: RunEvent[]) => events.flatMap((e) => (e.type === "log" ? [e.message] : []));

test("isStoreRefusal: store refusals yes; a check handed to the person, tunnel errors and stops no", () => {
  for (const m of [
    AMAZON_ERROR,
    "Best Buy refused the browser twice (Access Denied). Its bot wall blocks this exit address; use a US exit or try later",
    "eBay refused the page twice (Error Page | eBay, status 403) at https://www.ebay.com/sch/i.html?_nkw=x",
    "Target refused this browser ('Sorry for the wait'). Target serves US visitors only: give the Target browser a US exit.",
    "Amazon shows a bot check that did not clear. Try again later, or open the browser with a live link and solve it.",
    "Walmart answered HTTP 403",
    "store page status 435",
  ]) assert.ok(isStoreRefusal(new Error(m)), m);
  assert.ok(isStoreRefusal(new StoreRefusedError("anything")));
  assert.ok(isStoreRefusal(new BotCheckError("Amazon shows a bot check that did not clear. Try again later.")));
  assert.ok(!isStoreRefusal(new CaptchaHandoffError("Amazon shows a captcha that Browsa could not solve. Solve it in the live browser, then retry.", { reason: "captcha_handoff", message: "x" })));
  assert.ok(!isStoreRefusal(new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.amazon.com/")));
  assert.ok(!isStoreRefusal(new Error("run stopped")));
  assert.ok(!isStoreRefusal(new Error("Timeout 45000ms exceeded")));
  assert.ok(!isStoreRefusal(new Error("Amazon cart is empty")));
});

test("engine: Amazon refuses the address -> the browser is stopped, a fresh one opens on a new address, the search succeeds", async () => {
  const amazon = new RefusingAmazon(1);
  const { agent, log, order } = await agentWith(amazon, { browsa: true });
  const events: RunEvent[] = [];
  const run = await agent.run("AirPods Pro 3 on amazon", { onEvent: (e) => events.push(e), until: "picks" });
  assert.equal(amazon.agents.length, 2);
  assert.equal(log.opened.length, 2);
  assert.deepEqual(order.slice(0, 3), ["open agt_amazon_1", "close agt_amazon_1", "open agt_amazon_2"], "the refused browser stops before the fresh one opens (browser slots)");
  assert.ok(logs(events).includes("Amazon refused this address (Browsa residential (US)); trying a fresh one"));
  assert.equal(events.filter((e) => e.type === "store_started" && e.store === "amazon").length, 2, "the store card learns the new browser");
  assert.ok(!events.some((e) => e.type === "store_failed"));
  assert.equal(run.picks.length, 1);
  await run.close();
});

test("engine: the fresh address is refused too -> one clear failure that names both addresses", async () => {
  const amazon = new RefusingAmazon(99);
  const { agent, log } = await agentWith(amazon, { browsa: true, extra: { freshExitsPerStore: 1 } });
  const events: RunEvent[] = [];
  const run = await agent.run("AirPods Pro 3 on amazon", { onEvent: (e) => events.push(e), until: "picks" });
  assert.equal(amazon.agents.length, 2, "one fresh address, not more (freshExitsPerStore 1)");
  assert.equal(log.opened.length, 2);
  const f = events.filter((e) => e.type === "store_failed");
  assert.equal(f.length, 1);
  const err = f[0]!.type === "store_failed" ? f[0]!.error : "";
  assert.match(err, /^Amazon refused this browser on both exit addresses \(a fresh one was tried\)\. Last answer: Amazon refused this browser: it shows its error page \("Sorry! Something went wrong"\) on this exit address\. Try again in a while\.$/);
  const card = friendlyError(err, "search", "amazon");
  assert.equal(card.title, "Blocked at search (page refused)");
  assert.match(card.hint, /Amazon refused both addresses tried \(a fresh one was opened after the first was refused\)/);
  assert.doesNotMatch(card.hint, /Try again later/);
  assert.equal(run.picks.length, 0);
  await run.close();
});

test("engine: freshExitsPerStore 2 tries two fresh addresses; 0 turns it off", async () => {
  {
    const amazon = new RefusingAmazon(2);
    const { agent } = await agentWith(amazon, { browsa: true, extra: { freshExitsPerStore: 2 } });
    const run = await agent.run("AirPods Pro 3 on amazon", { onEvent: () => {}, until: "picks" });
    assert.equal(amazon.agents.length, 3);
    assert.equal(run.picks.length, 1);
    await run.close();
  }
  {
    const amazon = new RefusingAmazon(99);
    const { agent } = await agentWith(amazon, { browsa: true, extra: { freshExitsPerStore: 2 } });
    const events: RunEvent[] = [];
    await agent.run("AirPods Pro 3 on amazon", { onEvent: (e) => events.push(e), until: "picks" });
    const f = events.find((e) => e.type === "store_failed");
    assert.ok(f && f.type === "store_failed" && /on all 3 exit addresses \(2 fresh ones were tried\)/.test(f.error));
    assert.match(friendlyError(f.error, "search", "amazon").hint, /Amazon refused all 3 addresses tried/);
  }
  {
    const amazon = new RefusingAmazon(1);
    const { agent, log } = await agentWith(amazon, { browsa: true, extra: { freshExitsPerStore: 0 } });
    const events: RunEvent[] = [];
    await agent.run("AirPods Pro 3 on amazon", { onEvent: (e) => events.push(e), until: "picks" });
    assert.equal(log.opened.length, 1);
    const f = events.find((e) => e.type === "store_failed");
    assert.ok(f && f.type === "store_failed" && f.error === AMAZON_ERROR);
  }
});

test("engine: no fresh address on a browser that cannot get one (your Chrome, a CDP browser, a saved profile, your own proxy)", async () => {
  const amazon = new RefusingAmazon(1);
  const { agent, log } = await agentWith(amazon, { browsa: false });
  const events: RunEvent[] = [];
  const run = await agent.run("AirPods Pro 3 on amazon", { onEvent: (e) => events.push(e), until: "picks" });
  assert.equal(amazon.agents.length, 1);
  assert.equal(log.opened.length, 1);
  assert.ok(!logs(events).some((m) => /trying a fresh one/.test(m)));
  const f = events.find((e) => e.type === "store_failed");
  assert.ok(f && f.type === "store_failed" && f.error === AMAZON_ERROR, "the store's own message, unchanged");
  await run.close();
});

test("engine: a check Browsa handed to the person is not a refusal (no fresh address, the hand-off stays)", async () => {
  const handoff = { reason: "captcha_handoff" as const, message: "Amazon shows a captcha that Browsa could not solve.", liveUrl: "https://browsa.io/live#x" };
  const amazon = new RefusingAmazon(1, () => new CaptchaHandoffError(handoff.message, handoff));
  const { agent, log } = await agentWith(amazon, { browsa: true });
  const events: RunEvent[] = [];
  await agent.run("AirPods Pro 3 on amazon", { onEvent: (e) => events.push(e), until: "picks" });
  assert.equal(log.opened.length, 1);
  assert.ok(events.some((e) => e.type === "needs_user" && e.needs.reason === "captcha_handoff"));
});

test("engine: a stopped run does not open a fresh browser", async () => {
  const ac = new AbortController();
  const amazon = new RefusingAmazon(1, () => { ac.abort(); return new StoreRefusedError(AMAZON_ERROR); });
  const { agent, log } = await agentWith(amazon, { browsa: true });
  const events: RunEvent[] = [];
  await agent.run("AirPods Pro 3 on amazon", { onEvent: (e) => events.push(e), until: "picks", signal: ac.signal }).catch(() => undefined);
  assert.equal(log.opened.length, 1);
  assert.ok(!logs(events).some((m) => /trying a fresh one/.test(m)));
});

test("engine: by default a store gets two fresh addresses after refusals", async () => {
  const amazon = new RefusingAmazon(99);
  const { agent } = await agentWith(amazon, { browsa: true });
  await agent.run("AirPods Pro 3 on amazon", { until: "picks" });
  assert.equal(amazon.agents.length, 3);
});
