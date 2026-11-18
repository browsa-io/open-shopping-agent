// The run's own Browsa credits: what the browsers and AI tasks this run created cost, nothing else.
//
// Other runs on the same account (a second run, the web app, a teammate) do not count. The meter
// knows the browser ids (agent ids) and task ids (job ids) the run made, and reads their charges
// from the credit ledger (GET /v1/credits/ledger, rows carry agent_id or the job id). When the
// ledger cannot be read it asks each browser for its own totals (GET /v1/agents/{id}:
// credits_charged and credits_refunded), and when that fails too it estimates from how long each
// browser ran at the published rate, and says "about".
//
// Browsa billing as of 2026-11-18: a fresh browser holds 5 credits for its 30-minute
// limit and keeps 1 per started 12 minutes it ran; the rest comes back when it stops. Browsa's
// residential exit is billed per started 20 MB. A session on a saved profile is 1 credit, a new
// saved profile 50. So the cap counts a fresh browser that is still open by the time it has run
// so far (at least 1), not by what Browsa holds for it.

import { LimitError } from "./limits.js";

/** One started block of browser time costs 1 credit (Browsa billing). */
export const BROWSER_BLOCK_MS = 12 * 60_000;
/** Ledger rows read at once (the endpoint's most). */
const LEDGER_LIMIT = 500;
/** Rows of a saved profile from before the run belong to earlier runs; allow for clock skew. */
const SKEW_MS = 60_000;

/** Credits a fresh browser keeps for running `ms`: 1 per started 12 minutes, at least 1. */
export function browserTimeCredits(ms: number): number {
  if (!Number.isFinite(ms) || ms <= BROWSER_BLOCK_MS) return 1;
  return Math.ceil(ms / BROWSER_BLOCK_MS);
}

/** Where the meter reads charges. Both are optional; without them it estimates. */
export interface SpendSource {
  /** GET /v1/credits/ledger?limit=N (newest first, `entries` with agent_id, reason, delta, created_at). */
  ledger?: (limit: number) => Promise<Record<string, any>>;
  /** GET /v1/agents/{id} (credits_charged, credits_refunded, proxy_credits). */
  agent?: (id: string) => Promise<Record<string, any>>;
}

/** What the browser pool tells the meter after each thing it paid for. */
export type SpendEvent =
  /** A browser the run opened. `reserved` is the spend() it answers (0 when none). */
  | { type: "browser"; id: string; mode: "burner" | "persistent" | "session"; reserved: number; created?: boolean; dataBilled?: boolean }
  /** The browser was stopped. */
  | { type: "browser_closed"; id: string }
  /** An AI task (or a session's first task). `agentIds` are its own browsers. */
  | { type: "job"; id: string; reserved: number; agentIds?: string[]; creditsCharged?: number; done: boolean }
  /** A reservation that bought nothing (the create failed). */
  | { type: "released"; reserved: number };

export interface Spend {
  credits: number;
  /** False when part of it is estimated ("about"). */
  exact: boolean;
}

interface BrowserItem {
  kind: "browser";
  id: string;
  mode: "burner" | "persistent" | "session";
  openedAt: number;
  closedAt?: number;
  sessions: number;
  created: boolean;
}
interface JobItem {
  kind: "job";
  id: string;
  reserved: number;
  agentIds: string[];
  creditsCharged?: number;
  done: boolean;
}

interface LedgerRow { agentId: string; reason: string; delta: number; at: number }

/** Counts this run's own Browsa credits and keeps it under Limits.maxCreditsPerRun. */
export class CreditMeter {
  private startedAt = 0;
  /** Reserved by spend() and not yet answered by a browser or job event. */
  private pending = 0;
  private browsers = new Map<string, BrowserItem>();
  private jobs = new Map<string, JobItem>();
  private readonly now: () => number;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private source: SpendSource | undefined, readonly max: number, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Mark the start of the run (rows of saved profiles from before it are not counted). */
  async begin(): Promise<void> {
    this.startedAt = this.now();
  }

  /**
   * True when a browser of the run used an exit billed per GB: its last data charge reaches the
   * ledger a few seconds after it stops (the proxy reports every 15 s).
   */
  get dataBilled(): boolean { return this.billedData; }
  private billedData = false;

  track(e: SpendEvent): void {
    if (e.type === "released") { this.pending = Math.max(0, this.pending - e.reserved); return; }
    if (e.type === "browser_closed") {
      const b = this.browsers.get(e.id);
      if (b && b.closedAt === undefined) b.closedAt = this.now();
      return;
    }
    this.pending = Math.max(0, this.pending - e.reserved);
    if (e.type === "browser") {
      if (!e.id) return;
      if (e.dataBilled) this.billedData = true;
      const b = this.browsers.get(e.id);
      if (b) { b.sessions++; b.closedAt = undefined; b.created ||= !!e.created; return; }
      this.browsers.set(e.id, { kind: "browser", id: e.id, mode: e.mode, openedAt: this.now(), sessions: 1, created: !!e.created });
      return;
    }
    if (!e.id) return;
    const j = this.jobs.get(e.id);
    const agentIds = [...new Set([...(j?.agentIds ?? []), ...(e.agentIds ?? []).filter(Boolean)])];
    this.jobs.set(e.id, {
      kind: "job", id: e.id, reserved: Math.max(j?.reserved ?? 0, e.reserved), agentIds,
      creditsCharged: e.creditsCharged ?? j?.creditsCharged, done: e.done || !!j?.done,
    });
  }

  /** Credits this run used so far (the number shown to the user). */
  async used(): Promise<number> {
    return (await this.measure()).credits;
  }

  /**
   * This run's spend: from the ledger rows of its own browsers and tasks when the ledger can be
   * read, else from each browser's own totals, else estimated. A fresh browser that is still open
   * counts the time it has run (Browsa holds 5 credits for it until it stops).
   */
  async measure(): Promise<Spend> {
    const rows = await this.ledgerRows();
    if (rows) return { credits: this.pending + this.sumFromLedger(rows), exact: this.pending === 0 };
    let exact = this.pending === 0;
    let credits = this.pending;
    for (const b of this.browsers.values()) {
      const got = b.mode === "burner" ? await this.fromAgent(b) : undefined;
      if (got === undefined) exact = false;
      credits += got ?? this.estimateBrowser(b);
    }
    for (const j of this.jobs.values()) {
      if (!j.done || j.creditsCharged === undefined) exact = false;
      credits += j.done ? j.creditsCharged ?? j.reserved : j.reserved;
    }
    return { credits, exact };
  }

  /**
   * Before something that can cost up to `n` credits. Throws LimitError when it does not fit.
   * Returns the credits still free (at most n), the cap to give an AI task.
   */
  spend(n: number, what: string): Promise<number> {
    // One check at a time, so stores opening in parallel cannot all pass on the same figure.
    const p = this.lock.then(() => this.spendNow(n, what));
    this.lock = p.catch(() => {});
    return p;
  }

  private async spendNow(n: number, what: string): Promise<number> {
    // A non-number would turn every later check into NaN comparisons that never refuse.
    if (!Number.isFinite(n) || n < 0) throw new LimitError("credits", `${what}: no valid credit cap (${n}); refusing to start it`);
    const used = (await this.measure()).credits;
    const left = this.max - used;
    if (n > left) {
      throw new LimitError("credits", `${what} can cost up to ${n} credits; this run has ${Math.max(0, left)} of its ${this.max} left (raise maxCreditsPerRun to allow it)`);
    }
    const give = Math.min(n, left);
    this.pending += give;
    return give;
  }

  // -------------------------------------------------------------------------------------------

  /** The ledger rows since the run started, or undefined when they cannot all be read. */
  private async ledgerRows(): Promise<LedgerRow[] | undefined> {
    if (!this.browsers.size && !this.jobs.size) return [];
    if (!this.source?.ledger) return undefined;
    let body: Record<string, any>;
    try { body = await this.source.ledger(LEDGER_LIMIT); } catch { return undefined; }
    const list = Array.isArray(body?.entries) ? body.entries : Array.isArray(body) ? body : undefined;
    if (!list) return undefined;
    const rows: LedgerRow[] = [];
    for (const r of list) {
      const delta = Number(r?.delta);
      const at = Date.parse(String(r?.created_at ?? ""));
      if (!Number.isFinite(delta)) continue;
      rows.push({ agentId: String(r?.agent_id ?? ""), reason: String(r?.reason ?? ""), delta, at: Number.isFinite(at) ? at : NaN });
    }
    // Newest first, at most LEDGER_LIMIT: a full page whose oldest row is after the run started
    // may have cut off this run's first rows (a busy account).
    if (list.length >= LEDGER_LIMIT) {
      const oldest = Math.min(...rows.map((r) => r.at).filter(Number.isFinite));
      if (!(oldest <= this.startedAt - SKEW_MS)) return undefined;
    }
    return rows;
  }

  private sumFromLedger(rows: LedgerRow[]): number {
    const since = this.startedAt - SKEW_MS;
    let total = 0;
    for (const b of this.browsers.values()) {
      const mine = rows.filter((r) => r.agentId === b.id && (b.mode !== "persistent" || !(r.at < since)));
      if (b.mode === "burner" && b.closedAt === undefined) {
        // Still open: Browsa holds 5 credits for it until it stops. Count the time it ran so far
        // and the data it moved (proxy debits), not the hold.
        const other = mine.filter((r) => !r.reason.startsWith("debit:agent:"));
        total += browserTimeCredits(this.now() - b.openedAt) + sumDebits(other);
      } else {
        total += sumNet(mine);
      }
    }
    for (const j of this.jobs.values()) {
      // A task on a saved profile charges that profile's session, counted with the browser above.
      const ids = new Set([j.id, ...j.agentIds].filter((id) => !this.browsers.has(id)));
      const mine = rows.filter((r) => ids.has(r.agentId) || (r.reason.includes(j.id) && !this.browsers.has(r.agentId)));
      const got = sumNet(mine);
      // Running: what the task may still cost. Done: the ledger, or the job's own figure when its
      // debit is not in the ledger yet (it is written a little after the task ends).
      total += j.done ? Math.max(got, j.creditsCharged ?? 0) : Math.max(got, j.reserved);
    }
    return total;
  }

  /** A fresh browser's own totals (GET /v1/agents/{id}), or undefined. */
  private async fromAgent(b: BrowserItem): Promise<number | undefined> {
    if (!this.source?.agent) return undefined;
    try {
      const a = await this.source.agent(b.id);
      const charged = num(a?.credits_charged), refunded = num(a?.credits_refunded);
      if (charged === undefined) return undefined;
      if (b.closedAt === undefined && !/destroyed|stopped|expired|failed/.test(String(a?.status ?? ""))) {
        return browserTimeCredits(this.now() - b.openedAt) + (num(a?.proxy_credits) ?? 0);
      }
      return Math.max(0, charged - (refunded ?? 0));
    } catch {
      return undefined;
    }
  }

  /** The published rate: browser time for a fresh browser, 1 per saved-profile session, 50 per new profile. */
  private estimateBrowser(b: BrowserItem): number {
    if (b.mode === "persistent") return b.sessions + (b.created ? 50 : 0);
    return browserTimeCredits((b.closedAt ?? this.now()) - b.openedAt);
  }
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Charged minus refunded, never below 0. */
function sumNet(rows: LedgerRow[]): number {
  return Math.max(0, -rows.reduce((s, r) => s + r.delta, 0));
}

/** Only the charges. */
function sumDebits(rows: LedgerRow[]): number {
  return -rows.reduce((s, r) => s + (r.delta < 0 ? r.delta : 0), 0);
}
