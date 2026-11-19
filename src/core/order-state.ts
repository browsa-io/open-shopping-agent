// The order state machine of one store's checkout in a run. Pure: no I/O.
//
//   proposed -> awaiting_approval -> placing -> placed | failed | unknown
//
// "proposed": the agent read the store's order review. "awaiting_approval": the review can be
// approved. "placing": an approval passed the gate and the adapter was called; from here the click
// may happen at any moment. "placed": the store showed an order number. "failed": the agent knows the
// final click was never sent (the total changed, the store needs the person first). "unknown": the
// click may have gone through but no order number was read back. "placed" and "unknown" are final
// for the run: the agent never clicks Place order again for that store.

import { createHash } from "node:crypto";
import type { Approval, OrderState, StoreId } from "./types.js";

const NEXT: Record<OrderState | "none", OrderState[]> = {
  none: ["proposed"],
  proposed: ["proposed", "awaiting_approval"],
  awaiting_approval: ["proposed", "awaiting_approval", "placing"],
  placing: ["placed", "failed", "unknown"],
  // Nothing was submitted: a new review may start again.
  failed: ["proposed"],
  placed: [],
  unknown: [],
};

export function canMove(from: OrderState | undefined, to: OrderState): boolean {
  return NEXT[from ?? "none"].includes(to);
}

/** True while placing and after an order that is (or may be) placed: no new order at that store. */
export function blocksNewOrder(s: OrderState | undefined): boolean {
  return s === "placed" || s === "unknown" || s === "placing";
}

export class OrderStateError extends Error {
  constructor(readonly from: OrderState | undefined, readonly to: OrderState, key: string) {
    super(`order state of ${key} cannot go from ${from ?? "nothing"} to ${to}`);
    this.name = "OrderStateError";
  }
}

export interface StateEntry {
  store: StoreId;
  domain?: string;
  state: OrderState;
  at: string;
  orderId?: string;
  message?: string;
}

/** Per shop key ("amazon", "shopify:<domain>"): the current state and its history. */
export class OrderTracker {
  private readonly now: Map<string, StateEntry> = new Map();
  readonly history: (StateEntry & { key: string })[] = [];
  /** Approvals already used (one approval places at most one order, ever). */
  private readonly usedApprovals = new Set<string>();

  get(key: string): StateEntry | undefined {
    return this.now.get(key);
  }

  state(key: string): OrderState | undefined {
    return this.now.get(key)?.state;
  }

  /** Move `key` to `to`; throws OrderStateError on a move the machine does not allow. */
  move(key: string, to: OrderState, entry: Omit<StateEntry, "state" | "at"> & { at?: string }): StateEntry {
    const from = this.state(key);
    if (!canMove(from, to)) throw new OrderStateError(from, to, key);
    const e: StateEntry = { ...entry, state: to, at: entry.at ?? new Date().toISOString() };
    for (const k of Object.keys(e) as (keyof StateEntry)[]) if (e[k] === undefined) delete e[k];
    this.now.set(key, e);
    this.history.push({ key, ...e });
    return e;
  }

  /** Mark an approval as used. Returns false when it was used before (a double click). */
  useApproval(id: string): boolean {
    if (this.usedApprovals.has(id)) return false;
    this.usedApprovals.add(id);
    return true;
  }

  snapshot(): Record<string, StateEntry> {
    return Object.fromEntries(this.now);
  }
}

/** A stable id for one approval: the same click sent twice gets the same id. */
export function approvalId(runId: string, a: Approval): string {
  const body = [runId, a.store, a.storeDomain ?? "", a.approvedTotal?.cents, a.approvedTotal?.currency, a.approvedAt].join("|");
  return "apr_" + createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** What the person reads for an order in the "unknown" state. */
export function unknownMessage(storeName: string, ordersUrl?: string): string {
  return `${storeName} may have taken this order, but no order number was confirmed. Check your orders on ${storeName}${ordersUrl ? ` (${ordersUrl})` : ""} before you try again. The agent will not click Place order again for this checkout.`;
}
