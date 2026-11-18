// RunHub: shared by the web server, the CLI and the MCP server. It starts runs on the engine port,
// keeps each live run's events for late subscribers (SSE replay), holds the engine's "fill cart?"
// and "review checkout?" questions as open gates until a person answers, and checks approvals
// against the review total before passing them to the engine.

import type { CheckoutReview, Limits, Money, RunEvent, RunSummary, StoreId } from "../core/types.js";
import type { EnginePort, GateStep, PlanChoice, RunListItem, RunRecord, RunStatus } from "./engine-port.js";

export interface Gate { step: GateStep; store: StoreId }

export type HubMessage =
  | { kind: "event"; event: RunEvent }
  | { kind: "gate"; gate: Gate; open: boolean };

export interface StartOptions {
  limits?: Partial<Limits>;
  zip?: string;
  shopifyDomains?: string[];
  /** false: stop after the comparison (no gates, no carts). Default true. */
  checkout?: boolean;
  /** A cart at every store with every item, instead of the best store per item. */
  everyStore?: boolean;
}

export interface LiveRun {
  runId: string;
  prompt: string;
  startedAt: string;
  status: RunStatus;
  events: RunEvent[];
  gates: Gate[];
  summary?: RunSummary;
  done: Promise<RunSummary>;
}

type Listener = (m: HubMessage) => void;

interface Internal extends LiveRun {
  engine: EnginePort;
  resolvers: Map<string, (yes: boolean) => void>;
  listeners: Set<Listener>;
  /** Stores the person asked to fill (fillCarts); their later cart questions answer yes. */
  autoCart?: Set<StoreId>;
}

const gateKey = (step: GateStep, store: StoreId) => `${step}:${store}`;

export class RunHub {
  private runs = new Map<string, Internal>();

  constructor(public engine: EnginePort) {}

  /** Use another engine for new runs (after a settings change); running runs keep theirs. */
  setEngine(engine: EnginePort): void {
    this.engine = engine;
  }

  start(prompt: string, opts: StartOptions = {}): LiveRun {
    const early: RunEvent[] = [];
    let run: Internal | undefined;
    const onEvent = (e: RunEvent) => (run ? this.push(run, e) : early.push(e));
    const confirm = opts.checkout === false ? undefined : (step: GateStep, store: StoreId) =>
      new Promise<boolean>((resolve) => {
        if (!run || run.status !== "running") return resolve(false);
        // After "Fill carts", a store that gained a pick (setPlan) is filled without asking again.
        if (step === "cart" && run.autoCart?.has(store)) return resolve(true);
        const key = gateKey(step, store);
        run.gates.push({ step, store });
        run.resolvers.set(key, resolve);
        this.notify(run, { kind: "gate", gate: { step, store }, open: true });
      });
    const engine = this.engine;
    const handle = engine.run(prompt, { onEvent, limits: opts.limits, zip: opts.zip, shopifyDomains: opts.shopifyDomains, everyStore: opts.everyStore, confirm });
    run = {
      engine, runId: handle.runId, prompt, startedAt: new Date().toISOString(), status: "running", events: [], gates: [],
      resolvers: new Map(), listeners: new Set(), done: handle.done,
    };
    this.runs.set(run.runId, run);
    for (const e of early) this.push(run, e);
    handle.done.then((s) => {
      run!.summary = s;
      if (run!.status === "running") run!.status = "done";
      for (const g of [...run!.gates]) this.answer(run!.runId, g.step, g.store, false);
    });
    return run;
  }

  private push(run: Internal, e: RunEvent) {
    run.events.push(e);
    if (e.type === "done") {
      run.summary = e.summary;
      if (run.status === "running") run.status = "done";
    }
    this.notify(run, { kind: "event", event: e });
  }

  private notify(run: Internal, m: HubMessage) {
    for (const l of [...run.listeners]) {
      try { l(m); } catch { /* ignore listener errors */ }
    }
  }

  get(runId: string): LiveRun | undefined {
    return this.runs.get(runId);
  }

  /** Replays past events and open gates to the listener, then streams. Returns unsubscribe. */
  subscribe(runId: string, listener: Listener, replay = true): () => void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    if (replay) {
      for (const e of run.events) listener({ kind: "event", event: e });
      for (const g of run.gates) listener({ kind: "gate", gate: g, open: true });
    }
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /** Resolves when test(run) is true (checked now and after every message), or rejects on timeout. */
  waitFor(runId: string, test: (run: LiveRun) => boolean, timeoutMs = 300_000): Promise<LiveRun> {
    const run = this.runs.get(runId);
    if (!run) return Promise.reject(new Error(`Unknown run ${runId}`));
    if (test(run)) return Promise.resolve(run);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("Timed out waiting for the run")); }, timeoutMs);
      const off = this.subscribe(runId, () => {
        if (test(run)) { clearTimeout(timer); off(); resolve(run); }
      }, false);
    });
  }

  /** Answer an open gate. Returns false when no such gate is open. */
  answer(runId: string, step: GateStep, store: StoreId, yes: boolean): boolean {
    const run = this.runs.get(runId);
    const key = gateKey(step, store);
    const resolve = run?.resolvers.get(key);
    if (!run || !resolve) return false;
    run.resolvers.delete(key);
    run.gates = run.gates.filter((g) => gateKey(g.step, g.store) !== key);
    this.notify(run, { kind: "gate", gate: { step, store }, open: false });
    resolve(yes);
    return true;
  }

  /**
   * "Fill carts": apply the person's plan (when given), then answer every open cart question:
   * yes for stores that have a pick, no for the others. Stores that gain a pick later are filled
   * without asking again. Returns the stores being filled.
   */
  async fillCarts(runId: string, choices?: PlanChoice[]): Promise<StoreId[]> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") throw new HubError(409, "This run is not running");
    if (choices?.length) {
      if (!run.engine.setPlan) throw new HubError(409, "This engine cannot change the picks");
      try {
        await run.engine.setPlan(runId, choices);
      } catch (e) {
        throw new HubError(409, (e as Error).message);
      }
    }
    let picks: { offer: { store: StoreId } }[] = [];
    let over = false;
    for (const e of run.events) if (e.type === "picks") { picks = e.picks; over = e.overBudget; }
    if (over) throw new HubError(409, "The picks are over your budget. Choose cheaper ones or search again with a higher budget.");
    const stores = new Set(picks.map((p) => p.offer.store));
    run.autoCart = stores;
    for (const g of [...run.gates]) if (g.step === "cart") this.answer(runId, "cart", g.store, stores.has(g.store));
    return [...stores];
  }

  /** The review now awaiting approval for this store, if any. */
  pendingReview(runId: string, store: StoreId): CheckoutReview | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    let review: CheckoutReview | undefined;
    for (const e of run.events) {
      if (e.type === "awaiting_approval" && e.store === store) review = e.review;
      if (e.type === "order" && e.result.store === store) review = undefined;
      if (e.type === "store_failed" && e.store === store) review = undefined;
    }
    return review;
  }

  /**
   * The person approved this store's checkout for `approvedTotal`. Throws unless it equals the
   * total of the review awaiting approval, so a changed price is never bought silently.
   */
  async approve(runId: string, store: StoreId, approvedTotal: Money): Promise<CheckoutReview> {
    const review = this.pendingReview(runId, store);
    if (!review) throw new HubError(409, `Nothing at ${store} is waiting for approval`);
    if (approvedTotal.cents !== review.total.cents || approvedTotal.currency !== review.total.currency) {
      throw new HubError(409, `Approved total ${(approvedTotal.cents / 100).toFixed(2)} does not match the review total ${(review.total.cents / 100).toFixed(2)}`);
    }
    const run = this.runs.get(runId)!;
    try {
      await run.engine.approve(runId, { store, approvedTotal: review.total, approvedAt: new Date().toISOString(), by: "user", storeDomain: review.storeDomain });
    } catch (e) {
      throw new HubError(409, (e as Error).message);
    }
    return review;
  }

  async cancel(runId: string, store?: StoreId): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new HubError(404, `Unknown run ${runId}`);
    if (!store) run.status = "cancelled";
    for (const g of [...run.gates]) if (!store || g.store === store) this.answer(runId, g.step, g.store, false);
    await run.engine.cancel(runId, store);
  }

  /**
   * Stop every run that has not ended and wait until each has closed its browsers (at most
   * `timeoutMs`). For shutting the server down: Phantom browsers left open keep their credits held.
   */
  async cancelAll(timeoutMs = 20_000): Promise<number> {
    const open = [...this.runs.values()].filter((r) => !r.summary);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(open.map(async (r) => { await this.cancel(r.runId).catch(() => {}); await r.done; })),
      new Promise<void>((res) => { timer = setTimeout(res, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    return open.length;
  }

  /** Live runs merged with the engine's history, newest first. */
  async list(limit = 50): Promise<RunListItem[]> {
    const fromEngine = await this.engine.listRuns(limit).catch(() => [] as RunListItem[]);
    const seen = new Set(fromEngine.map((r) => r.runId));
    const live: RunListItem[] = [...this.runs.values()].filter((r) => !seen.has(r.runId)).map((r) => ({
      runId: r.runId, prompt: r.prompt, startedAt: r.startedAt, status: r.status, stores: [], orders: 0,
    }));
    return [...live, ...fromEngine].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async record(runId: string): Promise<(RunRecord & { gates: Gate[] }) | undefined> {
    const live = this.runs.get(runId);
    const stored = await (live?.engine ?? this.engine).getRun(runId).catch(() => undefined);
    if (!live && !stored) return undefined;
    if (!live) return { ...stored!, gates: [] };
    return {
      ...(stored ?? { stores: [], orders: 0 }),
      runId, prompt: live.prompt, startedAt: stored?.startedAt ?? live.startedAt, status: live.status,
      events: live.events, summary: live.summary, gates: live.gates,
    };
  }
}

export class HubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
