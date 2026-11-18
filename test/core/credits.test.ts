// The credit meter counts only this run's own browsers and tasks, and a browser by what it really costs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { BrowserPool, BURNER_CREDITS, type BrowsaClient } from "../../src/core/browsers.js";
import { browserTimeCredits, CreditMeter } from "../../src/core/credits.js";
import { LimitError, DEFAULT_MAX_CREDITS } from "../../src/core/limits.js";
import { creditsText } from "../../src/cli/index.js";

const T0 = Date.parse("2026-11-18T16:00:00Z");

/** A clock the test moves. */
function clock(start = T0) {
  let t = start;
  return { now: () => t, add: (ms: number) => { t += ms; } };
}

interface Row { agent_id?: string; reason: string; delta: number; created_at: string }

/** Browsa's ledger as the agents service writes it: 5 held per fresh browser, all but 1 per started 12 min back at the stop. */
function fakeBrowsa(c: ReturnType<typeof clock>) {
  const rows: Row[] = [];
  const opened = new Map<string, number>();
  const at = () => new Date(c.now()).toISOString();
  let n = 0;
  const add = (agent_id: string | undefined, reason: string, delta: number) => rows.unshift({ agent_id, reason, delta, created_at: at() });
  const ledgerCalls: number[] = [];
  const client = {
    createAgent: async (o: Record<string, unknown>) => {
      const id = `agt_run${++n}`;
      opened.set(id, c.now());
      add(id, `debit:agent:${id}`, o.mode === "persistent" ? -50 : -5);
      return { id, status: "running", mode: o.mode ?? "burner", cdp_http: `https://browsa.io/api/v1/cdp/${id}` };
    },
    destroyAgent: async (id: string) => {
      const used = browserTimeCredits(c.now() - (opened.get(id) ?? c.now()));
      add(id, `refund:browser_unused:${id}`, 5 - used);
    },
    getAgent: async (id: string) => ({ id, status: "running", mode: "burner" }),
    listLedger: async (o: { limit?: number }) => { ledgerCalls.push(o.limit ?? 50); return { entries: rows.slice(0, o.limit ?? 50), count: rows.length }; },
    credits: async () => ({ balance: 1000 }),
    listIdentities: async () => [],
  } as unknown as BrowsaClient;
  /** Another run on the same account: its own browsers, charged to the same workspace. */
  const otherRun = (k: number) => {
    for (let i = 0; i < k; i++) {
      const id = `agt_other${i}_${rows.length}`;
      add(id, `debit:agent:${id}`, -5);
      add(id, `debit:proxy:residential:${id}`, -3);
    }
  };
  return { client, rows, add, otherRun, ledgerCalls };
}

const connect = async (): Promise<Browser> => {
  const page = { url: () => "about:blank", isClosed: () => false };
  return { contexts: () => [{ pages: () => [page] }], close: async () => {} } as unknown as Browser;
};

function poolWith(client: BrowsaClient, meter: CreditMeter, extra: Record<string, unknown> = {}) {
  return mkdtemp(join(tmpdir(), "osa-cr-")).then((dataDir) => new BrowserPool({
    apiKey: "agt_test", client, connect, mode: "burner", dataDir, usExit: false,
    spend: (n, what) => meter.spend(n, what), track: (e) => meter.track(e), ...extra,
  }));
}

function meterFor(client: BrowsaClient, max: number, c: ReturnType<typeof clock>) {
  return new CreditMeter({ ledger: (limit) => client.listLedger!({ limit }), agent: (id) => client.getAgent(id) }, max, { now: c.now });
}

test("browser time: 1 credit per started 12 minutes, at least 1", () => {
  assert.equal(browserTimeCredits(0), 1);
  assert.equal(browserTimeCredits(11 * 60_000), 1);
  assert.equal(browserTimeCredits(12 * 60_000), 1);
  assert.equal(browserTimeCredits(12 * 60_000 + 1), 2);
  assert.equal(browserTimeCredits(30 * 60_000), 3);
  assert.equal(BURNER_CREDITS, 1, "the cap holds what a short browser costs, not Browsa's 5-credit hold");
});

test("other runs on the same account do not count: spend is this run's own browsers", async () => {
  const c = clock();
  const b = fakeBrowsa(c);
  b.otherRun(4); // before this run
  const meter = meterFor(b.client, 40, c);
  await meter.begin();
  const pool = await poolWith(b.client, meter);
  const one = await pool.openStore("walmart");
  b.otherRun(6); // a second run while this one runs: 48 credits, none of them ours
  c.add(5 * 60_000);
  b.add(one.agentId, `debit:proxy:residential:${one.agentId}`, -2);
  await one.close();
  const two = await pool.openStore("ebay");
  c.add(13 * 60_000);
  await two.close();
  b.otherRun(3);
  const m = await meter.measure();
  // walmart: 5 held, 4 back, 2 data = 3; ebay ran 13 min: 5 held, 3 back = 2.
  assert.deepEqual(m, { credits: 5, exact: true });
  const ours = b.rows.filter((r) => r.agent_id === one.agentId || r.agent_id === two.agentId).reduce((s, r) => s - r.delta, 0);
  assert.equal(m.credits, ours, "the same figure as the ledger rows of this run's browsers");
});

test("the cap is this run's alone: other runs spending a lot do not refuse our browsers", async () => {
  const c = clock();
  const b = fakeBrowsa(c);
  const meter = meterFor(b.client, 10, c);
  await meter.begin();
  const pool = await poolWith(b.client, meter);
  b.otherRun(20); // 160 credits by other runs
  for (const s of ["amazon", "walmart", "ebay", "bestbuy", "target"] as const) {
    const x = await pool.openStore(s);
    c.add(60_000);
    await x.close();
  }
  assert.equal(await meter.used(), 5);
  // Our own spend still counts against our cap.
  for (let i = 0; i < 5; i++) { const x = await pool.openStore("target"); await x.close(); }
  await assert.rejects(pool.openStore("amazon"), (e: unknown) => e instanceof LimitError && /0 of its 10 left/.test(e.message));
});

test("--every-store on 6 stores with 2 browsers at a time: 12 browsers fit the default cap", async () => {
  const c = clock();
  const b = fakeBrowsa(c);
  const meter = meterFor(b.client, DEFAULT_MAX_CREDITS, c);
  await meter.begin();
  const pool = await poolWith(b.client, meter, { maxBrowsers: 2 });
  const stores = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"] as const;
  // Search browsers, two at a time, then a fresh browser per store for the cart.
  for (const phase of ["search", "cart"]) {
    await Promise.all(stores.map(async (s) => {
      const x = await pool.openStore(s);
      c.add(2 * 60_000);
      b.add(x.agentId, `debit:proxy:residential:${x.agentId}`, -1);
      await x.close();
    }));
    assert.ok(phase);
  }
  const m = await meter.measure();
  assert.equal(m.credits, 12 + 12, "1 per short browser plus its data");
  assert.ok(m.credits < DEFAULT_MAX_CREDITS);
});

test("an open browser counts the time it has run, not the 5 credits Browsa holds", async () => {
  const c = clock();
  const b = fakeBrowsa(c);
  const meter = meterFor(b.client, 40, c);
  await meter.begin();
  const pool = await poolWith(b.client, meter);
  const x = await pool.openStore("walmart");
  assert.equal(await meter.used(), 1);
  c.add(25 * 60_000);
  b.add(x.agentId, `debit:proxy:residential:${x.agentId}`, -4);
  assert.equal(await meter.used(), 3 + 4);
  await x.close();
  assert.equal(await meter.used(), 3 + 4);
});

test("a saved profile counts only this run's rows; tasks count by their id and their own browser", async () => {
  const c = clock();
  const rows: Row[] = [];
  const at = (t: number) => new Date(t).toISOString();
  // Made a week ago (50) and opened by an earlier run (1): not this run's.
  rows.unshift({ agent_id: "agt_saved", reason: "debit:agent:agt_saved", delta: -50, created_at: at(T0 - 7 * 86400_000) });
  rows.unshift({ agent_id: "agt_saved", reason: "debit:session:agt_saved", delta: -1, created_at: at(T0 - 3600_000) });
  const meter = new CreditMeter({ ledger: async () => ({ entries: rows }) }, 40, { now: c.now });
  await meter.begin();
  assert.equal(await meter.spend(1, "session"), 1);
  meter.track({ type: "browser", id: "agt_saved", mode: "persistent", reserved: 1 });
  rows.unshift({ agent_id: "agt_saved", reason: "debit:session:agt_saved", delta: -1, created_at: at(T0 + 1000) });
  // An AI task: held at its cap while it runs.
  assert.equal(await meter.spend(15, "AI task"), 15);
  meter.track({ type: "job", id: "11111111-2222-3333-4444-555555555555", reserved: 15, agentIds: ["agt_taskbrowser"], done: false });
  assert.equal(await meter.used(), 1 + 15);
  rows.unshift({ agent_id: "agt_taskbrowser", reason: "debit:agent:agt_taskbrowser", delta: -5, created_at: at(T0 + 2000) });
  rows.unshift({ agent_id: "agt_taskbrowser", reason: "refund:browser_unused:agt_taskbrowser", delta: 4, created_at: at(T0 + 3000) });
  rows.unshift({ agent_id: "11111111-2222-3333-4444-555555555555", reason: "job:11111111-2222-3333-4444-555555555555:backfill", delta: -6, created_at: at(T0 + 4000) });
  meter.track({ type: "job", id: "11111111-2222-3333-4444-555555555555", reserved: 0, creditsCharged: 6, done: true });
  meter.track({ type: "browser_closed", id: "agt_saved" });
  assert.deepEqual(await meter.measure(), { credits: 1 + 1 + 6, exact: true });
});

test("a done task whose debit is not in the ledger yet counts its own credits_charged", async () => {
  const meter = new CreditMeter({ ledger: async () => ({ entries: [] }) }, 40);
  await meter.begin();
  await meter.spend(15, "AI task");
  meter.track({ type: "job", id: "job-x", reserved: 15, creditsCharged: 7, done: true });
  assert.deepEqual(await meter.measure(), { credits: 7, exact: true });
});

test("ledger unreadable: each browser's own totals (GET /v1/agents/{id}); else about, from browser time", async () => {
  const c = clock();
  const b = fakeBrowsa(c);
  let agentOk = true;
  const src = {
    agent: async (id: string) => {
      if (!agentOk) throw new Error("offline");
      return { id, status: "destroyed", credits_charged: 7, credits_refunded: 4, proxy_credits: 2 };
    },
  };
  const meter = new CreditMeter(src, 40, { now: c.now });
  await meter.begin();
  const pool = await poolWith(b.client, meter);
  const x = await pool.openStore("walmart");
  c.add(14 * 60_000);
  await x.close();
  assert.deepEqual(await meter.measure(), { credits: 3, exact: true });
  agentOk = false;
  assert.deepEqual(await meter.measure(), { credits: 2, exact: false }, "14 minutes = 2 credits, labelled about");
  assert.equal(creditsText({ creditsUsed: 2, creditsEstimated: true }), ", about 2 credits");
  assert.equal(creditsText({ creditsUsed: 1 }), ", 1 credit");
  assert.equal(creditsText({}), "");
});

test("a full ledger page that starts after the run began is not trusted (busy account)", async () => {
  const c = clock();
  const b = fakeBrowsa(c);
  const meter = new CreditMeter({
    ledger: async () => ({ entries: Array.from({ length: 500 }, (_, i) => ({ agent_id: `agt_o${i}`, reason: "debit:agent:x", delta: -5, created_at: new Date(T0 + 60_000).toISOString() })) }),
    agent: async (id) => ({ id, status: "destroyed", credits_charged: 5, credits_refunded: 4 }),
  }, 40, { now: c.now });
  await meter.begin();
  const pool = await poolWith(b.client, meter);
  const x = await pool.openStore("ebay");
  c.add(120_000);
  await x.close();
  assert.deepEqual(await meter.measure(), { credits: 1, exact: true });
});

test("a browser Browsa refused to create releases its reservation", async () => {
  const c = clock();
  const b = fakeBrowsa(c);
  (b.client as unknown as Record<string, unknown>).createAgent = async () => { throw Object.assign(new Error("bad request"), { status: 400 }); };
  const meter = meterFor(b.client, 40, c);
  await meter.begin();
  const pool = await poolWith(b.client, meter);
  await assert.rejects(pool.openStore("walmart"), /bad request/);
  assert.equal(await meter.used(), 0);
});
