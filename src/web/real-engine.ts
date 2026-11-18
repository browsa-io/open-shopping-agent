// RealEngine: the EnginePort over the real engine (ShoppingAgent, src/core). Used by the web app,
// the CLI and the MCP server when a Browsa key is set.
//
// Per run: search and pick on Phantom browsers, then for each store with a pick ask
// confirm("cart") -> fill that store's cart -> confirm("checkout") -> checkout review ->
// "awaiting_approval" (wait for approve or cancel) or "needs_user" (the person finishes in Phantom
// Live, then may review the checkout again). The run closes its browsers when every store is done.
// approve() goes to ShoppingRun.approve, which re-checks the approval against the review and the
// limits before the adapter re-reads the total on the store and clicks "Place order".

import type { Approval, Money, RunEvent, RunSummary, StoreId } from "../core/types.js";
import { ShoppingAgent, ShoppingRun, errText, shopKey, type ShoppingAgentOptions } from "../core/engine.js";
import { getRun as readRun, listRuns as readRuns, newRunId } from "../core/history.js";
import { STORE_NAMES } from "../stores/index.js";
import type { EnginePort, GateStep, PlanChoice, RunHandle, RunListItem, RunOptions, RunRecord, RunStatus } from "./engine-port.js";
import { applyChoices } from "./plan.js";

export interface RealEngineOptions extends ShoppingAgentOptions {
  /** An agent to use instead of new ShoppingAgent(options) (tests). */
  agent?: ShoppingAgent;
  /** How long a "fill cart?" or "review checkout?" question waits for an answer. Default 15 minutes. */
  gateTimeoutMs?: number;
  /** How long a checkout review waits for approval. Default 20 minutes (the engine refuses older reviews). */
  approvalTimeoutMs?: number;
  /** How long the browser stays open after placing an order needs the person (3-D Secure). Default 10 minutes. */
  holdMs?: number;
  /** Checkout reviews per store, counting the ones after a sign-in in Phantom Live. Default 3. */
  maxReviews?: number;
}

type Outcome = "approved" | "declined" | "timeout" | "hold";

interface Live {
  runId: string;
  prompt: string;
  startedAt: string;
  status: RunStatus;
  events: RunEvent[];
  opts: RunOptions;
  abort: AbortController;
  run?: ShoppingRun;
  summary?: RunSummary;
  cancelled: Set<StoreId>;
  cancelledAll: boolean;
  /** shopKey -> slot, for checkouts awaiting approval. */
  waiters: Map<string, { outcome: Promise<Outcome>; resolve: (o: Outcome) => void }>;
  /** Pending questions and holds that cancel() ends. */
  stops: Set<{ store?: StoreId; stop: () => void }>;
  /** Per-store cart and checkout flows; setPlan() may add stores while they run. */
  flows: Map<StoreId, Promise<void>>;
  flowing: boolean;
}

const CANCELLED_NOTE = "Run cancelled";

/** Where the person takes over on this run's browser: Phantom Live, the local window, or the CDP provider's viewer. */
function takeOverPlace(run: ShoppingRun): string {
  const p = run.provider;
  if (!p || p.id === "browsa") return "Phantom Live";
  if (p.id === "local") return p.capabilities.liveLink === "window" ? "the browser window" : "a headed browser (run without OSA_HEADLESS=1)";
  return "your remote browser";
}

export class RealEngine implements EnginePort {
  readonly demo = false;
  readonly agent: ShoppingAgent;
  private readonly dataDir: string;
  private readonly live = new Map<string, Live>();

  constructor(private readonly o: RealEngineOptions = {}) {
    const { agent, gateTimeoutMs: _g, approvalTimeoutMs: _a, holdMs: _h, maxReviews: _m, ...agentOptions } = o;
    this.agent = agent ?? new ShoppingAgent(agentOptions);
    this.dataDir = this.agent.options.dataDir ?? ".osa";
  }

  run(prompt: string, opts: RunOptions): RunHandle {
    const runId = newRunId();
    const st: Live = {
      runId, prompt, startedAt: new Date().toISOString(), status: "running", events: [], opts,
      abort: new AbortController(), cancelled: new Set(), cancelledAll: false, waiters: new Map(), stops: new Set(),
      flows: new Map(), flowing: false,
    };
    this.live.set(runId, st);
    const done = this.drive(st).then(
      (s) => { st.status = st.cancelledAll ? "cancelled" : "done"; return s; },
      (e) => {
        st.status = "failed";
        return this.fallbackSummary(st, e);
      },
    );
    return { runId, done };
  }

  private emit(st: Live, e: RunEvent): void {
    st.events.push(e);
    if (e.type === "done") st.summary = e.summary;
    // Open the approval slot before anyone sees the event, so an approve() right after it finds it.
    if (e.type === "awaiting_approval") {
      const key = shopKey(e.store, e.domain ?? e.review.storeDomain);
      let resolve!: (o: Outcome) => void;
      const outcome = new Promise<Outcome>((r) => (resolve = r));
      st.waiters.set(key, { outcome, resolve });
    }
    try { st.opts.onEvent(e); } catch { /* a listener error never stops the run */ }
  }

  private async drive(st: Live): Promise<RunSummary> {
    const { opts } = st;
    const run = new ShoppingRun(this.agent, {
      onEvent: (e) => this.emit(st, e),
      limits: opts.limits,
      until: "picks",
      close: false,
      signal: st.abort.signal,
      runId: st.runId,
      zip: opts.zip,
      shopifyDomains: opts.shopifyDomains,
      everyStore: opts.everyStore,
      defaultStores: opts.limits?.allowedStores?.length ? opts.limits.allowedStores : undefined,
    });
    st.run = run;
    try {
      await run.start(st.prompt);
      if (!st.cancelledAll && opts.confirm && run.picks.length && !run.overBudget) {
        st.flowing = true;
        for (const s of new Set(run.picks.map((p) => p.offer.store))) this.startFlow(st, run, s);
        // setPlan() can add a store's flow while these run: wait until no new flow appeared.
        for (let seen = -1; seen !== st.flows.size;) {
          seen = st.flows.size;
          await Promise.all([...st.flows.values()]);
        }
        st.flowing = false;
      }
    } catch (e) {
      run.note(`Run error: ${errText(e)}`);
    } finally {
      if (st.cancelledAll) run.note(CANCELLED_NOTE);
    }
    return run.close();
  }

  private startFlow(st: Live, run: ShoppingRun, store: StoreId): void {
    if (st.flows.has(store)) return;
    st.flows.set(store, this.storeFlow(st, run, store).catch((e) => run.note(`Stopped: ${errText(e)}`, store))
      .finally(() => run.releaseCapped(store).catch(() => {})));
  }

  /**
   * The person's picks before any cart is filled: swap offers, change quantities, skip items.
   * Emits a new "picks" event (also saved in the run history) and starts the cart and checkout
   * steps for stores that gained a pick.
   */
  async setPlan(runId: string, choices: PlanChoice[]): Promise<void> {
    const st = this.live.get(runId);
    const run = st?.run;
    if (!st || !run || st.status !== "running" || !run.picks.length) throw new Error("This run is not waiting at the comparison");
    if (run.carts.size) throw new Error("A cart is already filled. Start a new search to change the picks.");
    const applied = applyChoices(run.request, run.picks, run.offers, choices, run.budget ?? run.request.budget);
    for (const [id, q] of applied.quantities) {
      const item = run.request.items.find((i) => i.id === id);
      if (item) item.quantity = q;
    }
    run.picks = applied.picks;
    run.total = applied.total;
    run.overBudget = applied.overBudget;
    // ShoppingRun's emit also records the event in the run history.
    run["emit"]({ type: "picks", picks: applied.picks, total: applied.total, overBudget: applied.overBudget });
    run.note(`You changed the picks: ${applied.picks.length} item${applied.picks.length === 1 ? "" : "s"}, ${(applied.total.cents / 100).toFixed(2)} ${applied.total.currency}`);
    if (st.flowing && !applied.overBudget) for (const s of new Set(applied.picks.map((p) => p.offer.store))) this.startFlow(st, run, s);
  }

  private stopped(st: Live, store: StoreId): boolean {
    return st.cancelledAll || st.cancelled.has(store) || !!st.run?.isClosed;
  }

  /** Ask the person; false on no, on cancel, or when nobody answers in time. */
  private async ask(st: Live, step: GateStep, store: StoreId): Promise<boolean> {
    if (this.stopped(st, store) || !st.opts.confirm) return false;
    const ms = this.o.gateTimeoutMs ?? 15 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    let entry: { store?: StoreId; stop: () => void } | undefined;
    const answer = await Promise.race([
      st.opts.confirm(step, store).catch(() => false),
      new Promise<boolean | "timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
        entry = { store, stop: () => resolve(false) };
        st.stops.add(entry);
      }),
    ]);
    clearTimeout(timer);
    if (entry) st.stops.delete(entry);
    if (answer === "timeout") {
      st.run?.note(`No answer in ${Math.round(ms / 60_000)} minutes, stopping here`, store);
      return false;
    }
    return answer === true && !this.stopped(st, store);
  }

  private async storeFlow(st: Live, run: ShoppingRun, store: StoreId): Promise<void> {
    const name = STORE_NAMES[store];
    if (!(await this.ask(st, "cart", store))) {
      run.note("Cart skipped", store);
      return;
    }
    let carts;
    try {
      carts = await run.fillCart(store);
    } catch (e) {
      run.note(`Cart not filled: ${errText(e)}`, store);
      return;
    }
    let domains = [...new Set(carts.map((c) => c.storeDomain))];
    if (!domains.length || this.stopped(st, store)) return;

    const max = Math.max(1, this.o.maxReviews ?? 3);
    for (let n = 0; n < max; n++) {
      if (!(await this.ask(st, "checkout", store))) {
        run.note(n === 0 ? "Checkout review skipped; the cart stays filled" : "Stopped; the cart stays filled", store);
        return;
      }
      run.note(`Going to the ${name} checkout; it stops before Place order`, store);
      const waits: Promise<void>[] = [];
      const needs: string[] = [];
      for (const d of domains) {
        if (this.stopped(st, store)) return;
        let review;
        try {
          review = await run.reviewCheckout(store, d);
        } catch {
          continue; // reported as store_failed
        }
        if (review.needsUser) needs.push(d);
        else waits.push(this.awaitApproval(st, run, store, d));
      }
      await Promise.all(waits);
      if (!needs.length || this.stopped(st, store)) return;
      if (run.capped) {
        // With a browser cap the next store needs this browser: hand off here instead of holding it.
        run.note("Browsers are capped (OSA_MAX_BROWSERS), so this store stops at its hand-off and its browser is closed for the next store", store);
        return;
      }
      if (n + 1 < max) run.note(`Finish in ${takeOverPlace(run)}, then review the checkout again`, store);
      domains = needs;
    }
  }

  private async awaitApproval(st: Live, run: ShoppingRun, store: StoreId, domain: string): Promise<void> {
    const key = shopKey(store, domain);
    const slot = st.waiters.get(key);
    if (!slot) return; // the engine did not offer this review for approval
    const ms = this.o.approvalTimeoutMs ?? 20 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      slot.outcome,
      new Promise<Outcome>((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); }),
    ]);
    clearTimeout(timer);
    if (st.waiters.get(key) === slot) st.waiters.delete(key);
    if (outcome === "timeout") run.note(`No approval in ${Math.round(ms / 60_000)} minutes, not bought. The cart stays filled.`, store);
    else if (outcome === "declined") run.note("Not bought; the cart stays filled", store);
    else if (outcome === "hold") await this.hold(st, run, store);
  }

  /** Keep the browser open while the person finishes in Phantom Live (until cancel or holdMs). */
  private async hold(st: Live, run: ShoppingRun, store: StoreId): Promise<void> {
    const ms = this.o.holdMs ?? 10 * 60_000;
    run.note(`Finish in ${takeOverPlace(run)}. The browser stays open for ${Math.round(ms / 60_000)} minutes.`, store);
    let timer: NodeJS.Timeout | undefined;
    let entry: { store?: StoreId; stop: () => void } | undefined;
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      entry = { store, stop: resolve };
      st.stops.add(entry);
    });
    clearTimeout(timer);
    if (entry) st.stops.delete(entry);
  }

  async approve(runId: string, approval: Approval): Promise<void> {
    const st = this.live.get(runId);
    if (!st?.run) throw new Error(`Run ${runId} is not running`);
    const store = approval.store;
    const keys = [...st.waiters.keys()].filter((k) => k === store || k.startsWith(`${store}:`));
    let key = approval.storeDomain && store === "shopify" ? shopKey(store, approval.storeDomain) : keys.length === 1 ? keys[0] : undefined;
    if (store !== "shopify" && keys.includes(store)) key = store;
    const resolve = key ? st.waiters.get(key)?.resolve : undefined;
    if (!key || !resolve) throw new Error(`Nothing at ${STORE_NAMES[store] ?? store} is waiting for approval in run ${runId}`);
    const domain = store === "shopify" ? key.slice("shopify:".length) : undefined;
    // Throws LimitError("approval") without touching the store when the approval does not match.
    const result = await st.run.approve(store, domain ? { ...approval, storeDomain: domain } : approval, domain);
    resolve(result.needsUser ? "hold" : "approved");
  }

  async cancel(runId: string, store?: StoreId): Promise<void> {
    const st = this.live.get(runId);
    if (!st) throw new Error(`Unknown run ${runId}`);
    if (store) st.cancelled.add(store);
    else {
      st.cancelledAll = true;
      st.abort.abort();
      // Stop the browsers now (Browsa bills browser time), not when the steps in flight notice.
      // No wait for late data charges: a stop must be quick.
      await st.run?.close({ settle: false }).catch(() => undefined);
    }
    for (const [k, slot] of [...st.waiters]) if (!store || k === store || k.startsWith(`${store}:`)) slot.resolve("declined");
    for (const s of [...st.stops]) if (!store || s.store === store) s.stop();
  }

  async listRuns(limit = 50): Promise<RunListItem[]> {
    const items = await readRuns(this.dataDir, limit);
    const out: RunListItem[] = [];
    for (const it of items) {
      const rec = await this.getRun(it.runId);
      if (rec) {
        const { events: _e, summary: _s, ...item } = rec;
        out.push(item);
      }
    }
    return out;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const st = this.live.get(runId);
    if (st) {
      const parsed = st.events.find((e): e is Extract<RunEvent, { type: "parsed" }> => e.type === "parsed");
      return {
        runId, prompt: st.prompt, startedAt: st.startedAt, finishedAt: st.summary?.finishedAt, status: st.status,
        stores: parsed?.request.stores ?? [], shopifyDomains: shopifyDomains(st.events), picksTotal: picksTotal(st.events),
        orders: st.events.filter((e) => e.type === "order" && e.result.placed).length,
        events: [...st.events], summary: st.summary,
      };
    }
    const saved = await readRun(runId, this.dataDir);
    if (!saved) return undefined;
    const events = saved.events.map(({ at: _at, ...e }) => e as RunEvent);
    const done = events.some((e) => e.type === "done");
    const cancelled = events.some((e) => e.type === "log" && e.message === CANCELLED_NOTE);
    return {
      runId,
      prompt: saved.request?.prompt ?? "",
      startedAt: saved.summary?.startedAt ?? "",
      finishedAt: done ? saved.summary?.finishedAt : undefined,
      status: cancelled ? "cancelled" : done ? "done" : "failed",
      stores: saved.request?.stores ?? [],
      shopifyDomains: shopifyDomains(events),
      picksTotal: picksTotal(events),
      orders: saved.summary?.orders.filter((o) => o.placed).length ?? 0,
      events,
      summary: saved.summary,
    };
  }

  private fallbackSummary(st: Live, e: unknown): RunSummary {
    if (st.summary) return st.summary;
    const now = new Date().toISOString();
    const summary: RunSummary = st.run?.summary() ?? {
      runId: st.runId, startedAt: st.startedAt, finishedAt: now, picks: [], carts: [], reviews: [], orders: [], failures: [],
    };
    this.emit(st, { type: "log", message: `Run error: ${errText(e)}` });
    this.emit(st, { type: "done", summary });
    return summary;
  }
}

/** The Shopify shops a run searched, from its events. */
export function shopifyDomains(events: RunEvent[]): string[] | undefined {
  const out = new Set<string>();
  for (const e of events) {
    if (!("store" in e) || e.store !== "shopify") continue;
    if ((e.type === "store_started" || e.type === "store_failed") && e.domain) out.add(e.domain);
    if (e.type === "offers") for (const o of e.offers) if (o.storeDomain) out.add(o.storeDomain);
  }
  return out.size ? [...out] : undefined;
}

function picksTotal(events: RunEvent[]): Money | undefined {
  const p = [...events].reverse().find((e): e is Extract<RunEvent, { type: "picks" }> => e.type === "picks");
  return p?.total;
}
