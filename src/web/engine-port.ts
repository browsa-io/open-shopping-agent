// The engine port: the small surface the web app, the CLI and the MCP server use to drive a run.
// The real engine (src/core, ShoppingAgent) is wired to this at integration; until then the
// surfaces run against MockEngine (src/web/mock-engine.ts), which replays made-up demo data.

import type {
  Approval, Limits, Money, RunEvent, RunSummary, StoreId,
} from "../core/types.js";

/** A step the engine asks the person about before doing it, per store. */
export type GateStep = "cart" | "checkout";

export interface RunOptions {
  /** Every RunEvent, in order, as it happens. */
  onEvent: (event: RunEvent) => void;
  /** Safety limits; the engine fills the defaults (approval always required). */
  limits?: Partial<Limits>;
  zip?: string;
  shopifyDomains?: string[];
  /** A cart at every store with every item (compare real delivered totals) instead of the best store per item. */
  everyStore?: boolean;
  /**
   * Called before the engine fills a store's cart ("cart") and before it goes to that store's
   * checkout review ("checkout"). Resolve true to go ahead, false to stop that store there.
   * Several stores may ask at once. If omitted, the engine stops after the comparison ("picks").
   */
  confirm?: (step: GateStep, store: StoreId) => Promise<boolean>;
}

export interface RunHandle {
  runId: string;
  /** Resolves with the summary after the "done" event; never rejects (failures are in the summary). */
  done: Promise<RunSummary>;
}

export type RunStatus = "running" | "done" | "cancelled" | "failed";

export interface RunListItem {
  runId: string;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  stores: StoreId[];
  picksTotal?: Money;
  orders: number;          // orders placed
}

export interface RunRecord extends RunListItem {
  events: RunEvent[];
  summary?: RunSummary;
}

/**
 * The person's change to one item before the carts are filled: another offer from this run
 * (offerKey = `${store}|${url}`), another quantity, or skip the item.
 */
export interface PlanChoice {
  itemId: string;
  offerKey?: string;
  quantity?: number;
  skip?: boolean;
}

export interface EnginePort {
  /**
   * Optional: replace the picks with the person's choices before any cart is filled. Emits a new
   * "picks" event. Stores that gain a pick get their own cart and checkout steps (and questions).
   * Throws when a choice names an offer that is not in this run.
   */
  setPlan?(runId: string, choices: PlanChoice[]): Promise<void>;
  /** True when the engine returns made-up demo data (MockEngine). The UI shows a badge. */
  readonly demo: boolean;
  /** Start a run. Returns at once; events arrive through opts.onEvent. */
  run(prompt: string, opts: RunOptions): RunHandle;
  /**
   * The person approved one store's checkout. Called only after "awaiting_approval" for that
   * store, with approval.approvedTotal equal to that review's total. The engine re-checks the
   * total on the store before clicking "Place order" and emits an "order" event.
   */
  approve(runId: string, approval: Approval): Promise<void>;
  /** Stop one store (declines its pending gate or approval), or the whole run when store is omitted. */
  cancel(runId: string, store?: StoreId): Promise<void>;
  /** Past and current runs, newest first (history lives in .osa/runs/). */
  listRuns(limit?: number): Promise<RunListItem[]>;
  /** One run with all its events, or undefined. */
  getRun(runId: string): Promise<RunRecord | undefined>;
}
