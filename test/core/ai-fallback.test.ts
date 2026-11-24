// The AI fallback on its own time. Seen live 2026-11-24 ("AirPods Pro 3", Amazon, Walmart, Best Buy,
// Target; 4 browsers at once): Best Buy and Target handed off to the AI fallback late in their
// 180 s search step, the fallback tasks waited behind the slot limit, the stores timed out, and the
// two tasks finished later (8 credits each) with their results thrown away. Now the fallback gets
// its own budget, a store that still times out cancels its task, and a fallback that needs its own
// browser stops the store's browser first when every slot is taken.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { BrowserPool, type BrowsaClient } from "../../src/core/browsers.js";
import { ShoppingAgent, type ShoppingAgentOptions } from "../../src/core/engine.js";
import type { ItemRequest, Offer, RunEvent, StoreId } from "../../src/core/types.js";
import type { StoreContext } from "../../src/stores/adapter.js";
import { FakeAdapter, offer } from "./fake-adapter.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TERMINAL = ["completed", "failed", "cancelled"];

interface FakeJob { id: string; status: string; timer?: NodeJS.Timeout; waiters: ((j: Record<string, unknown>) => void)[] }

/**
 * A Browsa account with `slots` browsers at once: a browser past the limit gets HTTP 429, a task
 * past it waits "queued" until a browser stops. A task runs `taskMs` and answers one Best Buy offer.
 */
function slotClient(o: { slots?: number; taskMs: number; cancelFails?: boolean }) {
  const slots = o.slots ?? 4;
  const order: string[] = [];
  const cancelled: string[] = [];
  let running = 0, agents = 0, tasks = 0;
  const jobs = new Map<string, FakeJob>();
  const view = (j: FakeJob) => ({
    id: j.id, status: j.status, creditsCharged: j.status === "completed" ? 8 : j.status === "cancelled" ? 2 : undefined,
    finalResult: j.status === "completed" ? JSON.stringify({ offers: [{ title: "Apple AirPods Pro 3", url: "https://www.bestbuy.com/site/airpods-pro-3/6376563.p?skuId=6376563", sku: "6376563", price: "$219.99" }] }) : undefined,
  });
  const finish = (j: FakeJob, status: string) => {
    if (TERMINAL.includes(j.status)) return;
    if (j.status === "running") running--;
    clearTimeout(j.timer);
    j.status = status;
    order.push(`${status} ${j.id}`);
    for (const w of j.waiters.splice(0)) w(view(j));
    startQueued();
  };
  const start = (j: FakeJob) => {
    j.status = "running";
    running++;
    j.timer = setTimeout(() => finish(j, "completed"), o.taskMs);
  };
  const startQueued = () => { for (const j of jobs.values()) if (j.status === "queued" && running < slots) start(j); };
  const client = {
    createAgent: async () => {
      if (running >= slots) throw Object.assign(new Error("HTTP 429: too many running agents"), { status: 429, retryAfter: 0.01 });
      running++;
      const id = `agt_${++agents}`;
      order.push(`open ${id}`);
      return { id, status: "running", mode: "burner", cdp_http: `https://browsa.io/api/v1/cdp/${id}` };
    },
    destroyAgent: async (id: string) => { running--; order.push(`stop ${id}`); startQueued(); },
    getAgent: async (id: string) => ({ id, status: "running", mode: "burner" }),
    createLiveLink: async () => ({ live_url: "https://browsa.io/live#x" }),
    createTask: async () => {
      const j: FakeJob = { id: `job_${++tasks}`, status: "queued", waiters: [] };
      jobs.set(j.id, j);
      order.push(`task ${j.id}`);
      if (running < slots) start(j);
      return view(j);
    },
    waitForJob: (id: string, w: { onProgress?: (j: Record<string, unknown>) => void } = {}) => new Promise((resolve) => {
      const j = jobs.get(id)!;
      if (TERMINAL.includes(j.status)) return resolve(view(j));
      j.waiters.push(resolve);
      // Browsa's long poll answers a task still queued after its first wait.
      setTimeout(() => { if (j.status === "queued") w.onProgress?.(view(j)); }, 30);
    }),
    cancelJob: async (id: string) => {
      cancelled.push(id);
      if (o.cancelFails) throw Object.assign(new Error("HTTP 409: the job cannot be cancelled now"), { status: 409 });
      finish(jobs.get(id)!, "cancelled");
    },
    runTask: async () => { throw new Error("runTask cannot be cancelled; the pool must not use it"); },
    credits: async () => ({ balance: 100 }),
    listIdentities: async () => [],
  };
  return { client: client as unknown as BrowsaClient, order, cancelled, jobs, running: () => running };
}

const connect = async (): Promise<Browser> => {
  const page = { url: () => "https://www.bestbuy.com/site/searchpage.jsp?st=airpods", isClosed: () => false };
  return { contexts: () => [{ pages: () => [page] }], close: async () => {} } as unknown as Browser;
};

/** Best Buy whose page has no priced results: after `pageMs` on the page it asks the AI fallback once. */
class FallbackBestBuy extends FakeAdapter {
  aiStarted?: () => void;
  constructor(private readonly pageMs: number) { super("bestbuy", { catalog: {} }); }
  override async search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
    await sleep(this.pageMs);
    ctx.log("Best Buy search found no priced results in the page; asking the AI fallback once");
    this.aiStarted?.();
    const res = await ctx.aiTask<{ offers?: { title: string; url: string; price: string }[] }>("Search bestbuy.com", { maxSteps: 10 })
      .catch((e: Error) => { ctx.log(`AI fallback failed: ${e.message}`); return { offers: [] }; });
    return (res.offers ?? []).slice(0, limit).map((o) => offer("bestbuy", o.title, Number(o.price.replace(/[$,]/g, "")), { url: o.url, itemId: item.id }));
  }
}

async function agentWith(c: ReturnType<typeof slotClient>, adapter: FakeAdapter, extra: Partial<ShoppingAgentOptions>) {
  const agent = new ShoppingAgent({
    llm: false, client: c.client, apiKey: "agt_test", watchLinks: false, screenshots: false, history: false, browserMode: "burner",
    dataDir: await mkdtemp(join(tmpdir(), "osa-aifb-")), adapters: { [adapter.id]: adapter } as Partial<Record<StoreId, FakeAdapter>>,
    creditSettleMs: 0, ...extra,
  });
  const make = agent.makePool.bind(agent);
  agent.makePool = (...a) => {
    const pl = make(...a)!;
    (pl as unknown as { o: { connect: typeof connect } }).o.connect = connect;
    return pl;
  };
  return agent;
}

const logs = (events: RunEvent[]) => events.flatMap((e) => (e.type === "log" ? [e.message] : []));

test("engine: the AI fallback gets its own budget past the step's limit and its result is used", async () => {
  const c = slotClient({ taskMs: 250 });
  // The page takes 80 of the step's 100 ms; the fallback needs 250 ms more and has 600 of its own.
  const agent = await agentWith(c, new FallbackBestBuy(80), { stepTimeoutMs: 100, aiFallbackMs: 600 });
  const events: RunEvent[] = [];
  const run = await agent.run("AirPods Pro 3", { onEvent: (e) => events.push(e), until: "picks", defaultStores: ["bestbuy"] });
  assert.deepEqual(run.failures, []);
  assert.equal(run.offers.length, 1);
  assert.equal(run.offers[0].title, "Apple AirPods Pro 3");
  assert.equal(run.picks.length, 1);
  assert.deepEqual(c.cancelled, [], "a task that finished in time is never cancelled");
  assert.ok(logs(events).includes("The AI fallback gets its own 1 s"));
  assert.ok(logs(events).some((l) => /AI task job_1: completed, 8 credits/.test(l)));
  // The card: waiting for the AI fallback, then the wait is over.
  const waits = events.flatMap((e) => (e.type === "store_waiting" ? [e.waiting ?? "over"] : []));
  assert.deepEqual(waits, ["ai_fallback", "over"]);
  const w = events.find((e) => e.type === "store_waiting" && e.waiting);
  assert.ok(w && w.type === "store_waiting" && /Waiting for the AI fallback/.test(w.message ?? ""));
  await run.close();
});

test("engine: a store that still times out cancels its AI task; no late result is used", async () => {
  const c = slotClient({ taskMs: 600 });
  const agent = await agentWith(c, new FallbackBestBuy(20), { stepTimeoutMs: 100, aiFallbackMs: 150 });
  const events: RunEvent[] = [];
  const run = await agent.run("AirPods Pro 3", { onEvent: (e) => events.push(e), until: "picks", defaultStores: ["bestbuy"] });
  assert.equal(run.failures.length, 1);
  assert.match(run.failures[0].error, /searching Best Buy timed out after/);
  await sleep(50);
  assert.deepEqual(c.cancelled, ["job_1"], "the task was cancelled on Browsa");
  assert.ok(logs(events).some((l) => l === "cancelled the AI task job_1 (no result was used)"));
  assert.equal(c.jobs.get("job_1")!.status, "cancelled");
  await sleep(700); // past the time the task would have finished
  assert.equal(run.offers.length, 0, "nothing arrived late into the comparison");
  assert.ok(!logs(events).some((l) => /AI task job_1: completed/.test(l)));
  await run.close();
});

test("engine: a task that cannot be cancelled and still finishes is logged as too late, never used silently", async () => {
  const c = slotClient({ taskMs: 300, cancelFails: true });
  const agent = await agentWith(c, new FallbackBestBuy(20), { stepTimeoutMs: 100, aiFallbackMs: 120 });
  const events: RunEvent[] = [];
  const run = await agent.run("AirPods Pro 3", { onEvent: (e) => events.push(e), until: "picks", defaultStores: ["bestbuy"] });
  assert.equal(run.failures.length, 1);
  await sleep(400);
  assert.deepEqual(c.cancelled, ["job_1"]);
  assert.ok(logs(events).some((l) => /^cancelling the AI task job_1 failed \(HTTP 409/.test(l)));
  assert.ok(logs(events).some((l) => l === "AI task job_1 finished after Best Buy had given up on it; its result arrived too late and was not used (8 credits)"));
  assert.equal(run.offers.length, 0);
  await run.close();
});

test("engine: stopping the run cancels the AI task in flight", async () => {
  const c = slotClient({ taskMs: 5_000 });
  const adapter = new FallbackBestBuy(10);
  const stop = new AbortController();
  adapter.aiStarted = () => { setTimeout(() => stop.abort(), 50); };
  const agent = await agentWith(c, adapter, { stepTimeoutMs: 10_000, aiFallbackMs: 10_000 });
  const events: RunEvent[] = [];
  const run = await agent.run("AirPods Pro 3", { onEvent: (e) => events.push(e), until: "picks", defaultStores: ["bestbuy"], signal: stop.signal });
  await sleep(50);
  assert.deepEqual(c.cancelled, ["job_1"]);
  assert.ok(logs(events).some((l) => l === "cancelled the AI task job_1 (no result was used)"));
  assert.equal(run.offers.length, 0);
  await run.close();
});

test("pool: with every slot taken, the store's own browser stops before its AI fallback, which then runs at once", async () => {
  const c = slotClient({ slots: 4, taskMs: 50 });
  const lines: string[] = [];
  const p = new BrowserPool({
    apiKey: "agt_test", client: c.client, connect, mode: "burner", slotWaitMs: 60_000, dataDir: await mkdtemp(join(tmpdir(), "osa-aifs-")),
    log: (s, m) => lines.push(`${s}: ${m}`),
  });
  const open = [];
  for (const s of ["amazon", "walmart", "bestbuy", "target"] as StoreId[]) open.push(await p.openStore(s));
  const bestbuy = open[2];
  // A fifth browser (Amazon's fresh-exit retry in the live run) waits for a slot.
  const fifth = p.openStore("ebay");
  await sleep(20);
  assert.equal(p.slotsFull(), true);
  const statuses: string[] = [];
  const ctx = bestbuy.context("bestbuy.com", { signal: new AbortController().signal, log: (m) => lines.push(`bestbuy: ${m}`) });
  const r = await ctx.aiTask<{ offers: unknown[] }>("Search bestbuy.com", { signal: new AbortController().signal, onStatus: (s) => statuses.push(s) });
  assert.equal(r.offers.length, 1);
  assert.equal(bestbuy.closed, true);
  const iStop = c.order.indexOf(`stop ${bestbuy.agentId}`), iTask = c.order.indexOf("task job_1");
  assert.ok(iStop >= 0 && iStop < iTask, `the store's browser stopped before the task: ${c.order.join(", ")}`);
  assert.ok(!statuses.includes("queued"), "the task never waited for a slot");
  assert.ok(lines.some((l) => /bestbuy: all browser slots are in use; stopped this store's browser so the AI fallback gets a slot/.test(l)));
  const e = await fifth; // the task's slot came free after it ended
  await Promise.all([...open, e].map((b) => b.close()));
  assert.equal(c.running(), 0);
});

test("pool: a task Browsa keeps queued stops the store's own browser and says it waits for a free browser", async () => {
  const c = slotClient({ slots: 4, taskMs: 50 });
  const p = new BrowserPool({ apiKey: "agt_test", client: c.client, connect, mode: "burner", dataDir: await mkdtemp(join(tmpdir(), "osa-aifq-")) });
  const open = [];
  for (const s of ["amazon", "walmart", "bestbuy", "target"] as StoreId[]) open.push(await p.openStore(s));
  assert.equal(p.slotsFull(), false, "nothing of this run waits: the pool cannot know the account is full");
  const statuses: string[] = [];
  const lines: string[] = [];
  const ctx = open[3].context("target.com", { signal: new AbortController().signal, log: (m) => lines.push(m) });
  const r = await ctx.aiTask<{ offers: unknown[] }>("Search target.com", { onStatus: (s) => statuses.push(s) });
  assert.equal(r.offers.length, 1);
  assert.equal(statuses[0], "queued");
  assert.equal(open[3].closed, true);
  assert.ok(lines.includes("the AI task is waiting for a free browser slot; stopped this store's browser to free one"));
  await Promise.all(open.map((b) => b.close()));
});
