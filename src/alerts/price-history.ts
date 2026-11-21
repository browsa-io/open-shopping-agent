// Price history per watch (0.3.0 preview, behind OSA_PRICE_HISTORY=1). Pure functions over the
// checks a watch already keeps on this computer (.osa/watches/<id>.jsonl): nothing new is stored
// and nothing leaves the machine.

import type { HistoryEntry } from "./types.js";
import type { StoreId } from "../core/types.js";

/** OSA_PRICE_HISTORY=1 (or true/on/yes) turns the price history view on. Off by default. */
export function priceHistoryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.OSA_PRICE_HISTORY ?? "").trim());
}

/** One point: the best in-stock delivered price a check found. */
export interface PricePoint {
  at: string;          // ISO time of the check
  cents: number;
  store: StoreId;
  storeDomain: string;
}

export interface PriceHistory {
  currency: string;
  points: PricePoint[];          // oldest first
  /** Checks that found a price, and all checks read (failed or out-of-stock checks have no point). */
  priced: number;
  checks: number;
  low?: PricePoint;
  high?: PricePoint;
  first?: PricePoint;
  last?: PricePoint;
}

/**
 * The price points of a watch, oldest first. A check counts when it finished, found an in-stock
 * offer and its total is in `currency`: a price in another currency is never mixed in.
 */
export function priceHistory(entries: HistoryEntry[], currency = "USD"): PriceHistory {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const points: PricePoint[] = [];
  for (const e of sorted) {
    const b = e.best;
    if (!e.ok || !b || !b.inStock || b.total.currency !== currency || !Number.isFinite(b.total.cents) || b.total.cents <= 0) continue;
    if (Number.isNaN(new Date(e.at).getTime())) continue;
    points.push({ at: e.at, cents: b.total.cents, store: b.store, storeDomain: b.storeDomain });
  }
  const by = (pick: (a: PricePoint, b: PricePoint) => boolean) => points.reduce<PricePoint | undefined>((m, p) => (!m || pick(p, m) ? p : m), undefined);
  return {
    currency, points, priced: points.length, checks: sorted.length,
    // the earliest lowest and the earliest highest
    low: by((a, b) => a.cents < b.cents), high: by((a, b) => a.cents > b.cents),
    first: points[0], last: points[points.length - 1],
  };
}
