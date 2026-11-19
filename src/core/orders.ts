// Orders across runs, from the run history: every checkout that got past an approval (placing,
// placed, failed, unknown), with the order number, total, time and the store's order page from the
// confirmation, plus the last status read from that page (tracking.json in the run's folder).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalSource, MandateLimits, Money, OrderResult, OrderState, RunEvent, StoreId } from "./types.js";
import { getRun, listRuns, runDir } from "./history.js";
import { orderPages, type TrackingInfo } from "../orders/index.js";
import { unknownMessage } from "./order-state.js";

const DOMAINS: Record<StoreId, string> = {
  amazon: "amazon.com", walmart: "walmart.com", ebay: "ebay.com", bestbuy: "bestbuy.com", target: "target.com", shopify: "",
};
const NAMES: Record<StoreId, string> = { amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target", shopify: "Shopify" };

export type OrderEntryState = Extract<OrderState, "placing" | "placed" | "failed" | "unknown">;

export interface TrackingRecord extends TrackingInfo {
  checkedAt: string;
  /** Why the page could not be read (no saved profile, the store blocked the browser). */
  error?: string;
}

export interface OrderEntry {
  runId: string;
  prompt?: string;
  store: StoreId;
  storeDomain: string;
  /** "amazon" or "shopify:<domain>": the shop key within the run. */
  shop: string;
  state: OrderEntryState;
  orderId?: string;
  total?: Money;
  /** When the order was placed, or the time of its last state. */
  at: string;
  /** The store's page for this order, from the confirmation page. */
  orderUrl?: string;
  /** The store's orders list, to check an order by hand. */
  ordersUrl: string;
  /** For "unknown": check your orders on the store. For "failed": why. */
  message?: string;
  tracking?: TrackingRecord;
  /** Added in 0.2.0: "user" (approved at checkout) or "mandate" (bought under the person's up-front approval). */
  approval_source?: ApprovalSource;
  /** Added in 0.2.0: the up-front limits, for approval_source "mandate". */
  mandate?: MandateLimits;
}

const PAST_APPROVAL = new Set<OrderState>(["placing", "placed", "failed", "unknown"]);

/**
 * The orders of one run from its events. `live` is true while the run is still going; a saved run
 * that stopped in "placing" (the app was closed mid-click) shows as "unknown".
 */
export function ordersFromEvents(runId: string, prompt: string | undefined, events: RunEvent[], o: { live?: boolean } = {}): OrderEntry[] {
  const byShop = new Map<string, OrderEntry>();
  const domainOf = (store: StoreId, d?: string) => d || DOMAINS[store];
  const keyOf = (store: StoreId, d?: string) => (store === "shopify" ? `shopify:${d ?? ""}` : store);
  const base = (store: StoreId, d: string | undefined, at: string): OrderEntry => {
    const domain = domainOf(store, d);
    return { runId, ...(prompt ? { prompt } : {}), store, storeDomain: domain, shop: keyOf(store, d), state: "placing", at, ordersUrl: orderPages(store).ordersUrl(domain) };
  };
  for (const e of events) {
    if (e.type === "order_state" && PAST_APPROVAL.has(e.state)) {
      const k = keyOf(e.store, e.domain);
      // A new approval after a failure starts a new entry for the same shop.
      const prev = byShop.get(k);
      const entry = prev && prev.state !== "failed" ? prev : base(e.store, e.domain, e.at);
      entry.state = e.state as OrderEntryState;
      entry.at = e.at;
      if (e.orderId) entry.orderId = e.orderId;
      if (e.orderUrl) entry.orderUrl = e.orderUrl;
      if (e.total) entry.total = e.total;
      if (e.message) entry.message = e.message; else if (e.state === "placing") delete entry.message;
      if (e.approval_source) entry.approval_source = e.approval_source;
      if (e.mandate) entry.mandate = e.mandate;
      byShop.set(k, entry);
    } else if (e.type === "order") {
      const r: OrderResult = e.result;
      const d = r.store === "shopify" ? domainFrom(r) : undefined;
      const k = keyOf(r.store, d);
      let entry = byShop.get(k);
      if (!entry) {
        // Runs saved before order states: the order event alone.
        entry = base(r.store, d, r.placedAt ?? "");
        entry.state = r.state ?? (r.placed ? "placed" : "failed");
        byShop.set(k, entry);
      }
      if (r.orderId) entry.orderId = r.orderId;
      if (r.orderUrl) entry.orderUrl = r.orderUrl;
      if (r.total) entry.total = r.total;
      if (r.placedAt) entry.at = r.placedAt;
      if (r.ordersUrl) entry.ordersUrl = r.ordersUrl;
      if (entry.state === "unknown" && r.checkMessage) entry.message = r.checkMessage;
      if (entry.state === "failed" && !entry.message) entry.message = r.error ?? r.confirmationText ?? r.needsUser?.message;
    }
  }
  const out = [...byShop.values()];
  if (!o.live) {
    for (const x of out) {
      if (x.state !== "placing") continue;
      x.state = "unknown";
      x.message = `The agent stopped while placing this order. ${unknownMessage(x.store === "shopify" ? x.storeDomain : NAMES[x.store], x.ordersUrl)}`;
    }
  }
  return out;
}

function domainFrom(r: OrderResult): string | undefined {
  for (const u of [r.orderUrl, r.ordersUrl]) {
    if (!u) continue;
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch { /* not a URL */ }
  }
  return undefined;
}

export async function readTracking(dataDir: string, runId: string): Promise<Record<string, TrackingRecord>> {
  try { return JSON.parse(await readFile(join(runDir(dataDir, runId), "tracking.json"), "utf8")); } catch { return {}; }
}

/** Save what a store's order page showed for one order of a run (tracking.json in the run's folder). */
export async function saveTracking(dataDir: string, runId: string, shop: string, t: TrackingRecord): Promise<void> {
  const all = await readTracking(dataDir, runId);
  all[shop] = t;
  await writeFile(join(runDir(dataDir, runId), "tracking.json"), JSON.stringify(all, null, 2) + "\n");
}

/**
 * Orders in the run history, newest first. `liveEvents` gives the events of runs still going (they
 * are not "unknown" while placing). Failed checkouts are left out unless `all`.
 */
export async function listOrders(dataDir = ".osa", o: { limit?: number; all?: boolean; liveEvents?: (runId: string) => RunEvent[] | undefined } = {}): Promise<OrderEntry[]> {
  const out: OrderEntry[] = [];
  for (const r of await listRuns(dataDir, 1000)) {
    const live = o.liveEvents?.(r.runId);
    let events = live;
    let prompt = r.prompt;
    if (!events) {
      const saved = await getRun(r.runId, dataDir);
      if (!saved) continue;
      events = saved.events.map(({ at: _at, ...e }) => e as RunEvent);
      prompt = saved.request?.prompt ?? prompt;
    }
    if (!events.some((e) => e.type === "order" || e.type === "order_state")) continue;
    const tracking = await readTracking(dataDir, r.runId);
    for (const x of ordersFromEvents(r.runId, prompt, events, { live: !!live })) {
      if (tracking[x.shop]) x.tracking = tracking[x.shop];
      out.push(x);
    }
  }
  const shown = o.all ? out : out.filter((x) => x.state !== "failed");
  return shown.sort((a, b) => b.at.localeCompare(a.at)).slice(0, o.limit ?? 200);
}
