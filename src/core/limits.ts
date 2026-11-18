// Safety limits and the approval gate. Pure functions (the credit meter is in credits.ts).
// v1 rules that no option can turn off: approval before every order, no subscriptions, no
// memberships or trials.

import type { Approval, CartLine, CheckoutReview, Limits, Money, ShoppingRequest, StoreId } from "./types.js";
import { formatMoney } from "../stores/util.js";
import { STORE_IDS } from "../stores/index.js";

export type LimitCode = "budget" | "store_not_allowed" | "credits" | "approval" | "subscription" | "membership";

export class LimitError extends Error {
  constructor(public code: LimitCode, message: string) {
    super(message);
    this.name = "LimitError";
  }
}

export const DEFAULT_MAX_CREDITS = 40;

export function defaultLimits(): Limits {
  return {
    allowedStores: [...STORE_IDS],
    allowSubscriptions: false,
    allowMembershipOffers: false,
    requireApproval: true,
    // OSA_MAX_CREDITS sets the default cap for the CLI, web app and MCP.
    maxCreditsPerRun: Number.isFinite(Number(process.env.OSA_MAX_CREDITS)) && Number(process.env.OSA_MAX_CREDITS) > 0 ? Math.floor(Number(process.env.OSA_MAX_CREDITS)) : DEFAULT_MAX_CREDITS,
  };
}

/** Fill in defaults. Throws when a caller tries to turn off a v1 safety rule. */
export function resolveLimits(partial: Partial<Limits> = {}): Limits {
  const p = partial as Partial<Record<keyof Limits, unknown>>;
  if (p.requireApproval === false) throw new LimitError("approval", "requireApproval cannot be turned off in v1: every order needs the user's approval");
  if (p.allowSubscriptions === true) throw new LimitError("subscription", "subscriptions are not allowed in v1");
  if (p.allowMembershipOffers === true) throw new LimitError("membership", "membership and trial offers are not allowed in v1");
  const d = defaultLimits();
  const allowed = Array.isArray(partial.allowedStores) ? partial.allowedStores.filter((s) => STORE_IDS.includes(s)) : d.allowedStores;
  const maxCredits = typeof partial.maxCreditsPerRun === "number" && Number.isFinite(partial.maxCreditsPerRun) && partial.maxCreditsPerRun >= 0
    ? Math.floor(partial.maxCreditsPerRun) : d.maxCreditsPerRun;
  const out: Limits = { ...d, allowedStores: allowed, maxCreditsPerRun: maxCredits };
  if (partial.budget) out.budget = partial.budget;
  return out;
}

/** The tighter of the request's budget and the limits' budget. */
export function effectiveBudget(limits: Limits, request?: ShoppingRequest): Money | undefined {
  const a = limits.budget;
  const b = request?.budget;
  if (a && b) return a.cents <= b.cents ? a : b;
  return a ?? b;
}

/** Stores the run may use: asked for, allowed and not excluded. */
export function allowedStores(request: ShoppingRequest, limits: Limits): { stores: StoreId[]; refused: StoreId[] } {
  const stores = request.stores.filter((s) => limits.allowedStores.includes(s));
  const refused = request.stores.filter((s) => !limits.allowedStores.includes(s));
  return { stores, refused };
}

const MEMBERSHIP_LINE = /(\bamazon prime\b|\bprime (?:membership|free trial|trial)\b|\bwalmart\+|\bwalmart plus\b|\bmembership\b|\bfree trial\b|\btrial (?:offer|period|membership)\b|\bmy best buy (?:plus|total)\b|\bebay plus\b|\btarget circle 360\b|\bshipping pass\b)/i;
const SUBSCRIPTION_LINE = /\b(subscribe\s*(?:&|and)\s*save|subscription|auto[- ]?renew|auto[- ]?ship|autoship|every \d+ (?:weeks?|months?)|monthly plan)\b/i;

/** Cart or review lines that are memberships, trials or subscriptions. */
export function forbiddenLines(lines: CartLine[]): { line: CartLine; why: "membership" | "subscription" }[] {
  const out: { line: CartLine; why: "membership" | "subscription" }[] = [];
  for (const line of lines) {
    const text = `${line.title} ${Object.values(line.options ?? {}).join(" ")}`;
    if (SUBSCRIPTION_LINE.test(text)) out.push({ line, why: "subscription" });
    else if (MEMBERSHIP_LINE.test(line.title)) out.push({ line, why: "membership" });
  }
  return out;
}

export interface ApprovalCheck {
  store: StoreId;
  storeDomain?: string;
  review: CheckoutReview | undefined;
  approval: Approval | undefined;
  limits: Limits;
  budget?: Money;
  /** Total of orders already placed in this run. */
  placed: Money | undefined;
  /** Stores (or store:domain) already ordered in this run. */
  ordered: Set<string>;
  now?: Date;
  /** How old a review may be when approved. Default 20 minutes. */
  maxReviewAgeMs?: number;
}

/**
 * The approval gate. Returns why placing the order is refused, or undefined when it may go ahead.
 * The order goes ahead only when the user approved exactly the total of this run's review of this
 * store, the review is recent, nothing needs the person, and the limits hold.
 */
export function approvalProblem(c: ApprovalCheck): string | undefined {
  const { store, review, approval, limits } = c;
  if (limits.requireApproval !== true) return "requireApproval must be true";
  if (!limits.allowedStores.includes(store)) return `${store} is not an allowed store`;
  if (!approval) return "no approval";
  if (approval.by !== "user") return "the approval must come from the user";
  if (approval.store !== store) return `the approval is for ${approval.store}, not ${store}`;
  if (c.storeDomain && approval.storeDomain && approval.storeDomain !== c.storeDomain) return `the approval is for ${approval.storeDomain}, not ${c.storeDomain}`;
  if (!review) return "there is no checkout review for this store in this run; call reviewCheckout first";
  if (review.store !== store) return "the review is for another store";
  if (review.needsUser) return `the store needs the person first: ${review.needsUser.message}`;
  const at = approval.approvedTotal;
  if (!at || !Number.isInteger(at.cents) || typeof at.currency !== "string") return "the approval has no valid total";
  if (at.currency !== review.total.currency || at.cents !== review.total.cents) {
    return `the approved total ${formatMoney(at)} does not match the review total ${formatMoney(review.total)}`;
  }
  if (review.total.cents <= 0) return "the review total is zero; refusing to place an order that cannot be checked";
  const now = c.now ?? new Date();
  const reviewed = Date.parse(review.reviewedAt);
  if (!Number.isFinite(reviewed)) return "the review has no time";
  if (now.getTime() - reviewed > (c.maxReviewAgeMs ?? 20 * 60_000)) return "the review is too old; review the checkout again";
  const approvedAt = Date.parse(approval.approvedAt);
  if (!Number.isFinite(approvedAt) || approvedAt + 5_000 < reviewed) return "the approval was given before this review";
  const key = c.storeDomain ? `${store}:${c.storeDomain}` : store;
  if (c.ordered.has(key)) return "an order was already placed for this store in this run";
  const bad = forbiddenLines(review.lines);
  if (bad.length) return `the checkout has a ${bad[0].why} line: ${bad[0].line.title}`;
  if (c.budget) {
    if (c.budget.currency !== review.total.currency) return `the budget is in ${c.budget.currency}, the checkout in ${review.total.currency}`;
    const after = (c.placed?.cents ?? 0) + review.total.cents;
    if (after > c.budget.cents) return `the order would bring the run to ${formatMoney({ cents: after, currency: review.total.currency })}, over the ${formatMoney(c.budget)} budget`;
  }
  return undefined;
}

/** Make an Approval for a review: what front ends send after the user clicks "Approve". */
export function approvalFor(review: CheckoutReview, now = new Date()): Approval {
  return { store: review.store, storeDomain: review.storeDomain, approvedTotal: { ...review.total }, approvedAt: now.toISOString(), by: "user" };
}

// The run's credit meter lives in credits.ts (it counts only this run's own browsers and tasks).
export { CreditMeter } from "./credits.js";

/** The balance in a GET /v1/credits answer. */
export function balanceOf(r: Record<string, any> | undefined): number | undefined {
  if (!r) return undefined;
  for (const k of ["balance", "credits", "credit_balance", "remaining", "available"]) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}
