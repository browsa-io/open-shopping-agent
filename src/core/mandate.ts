// Up-front approval ("mandate"), added in 0.2.0. Pure functions, no I/O.
//
// A mandate is the person's "buy without asking, up to $X per order" given before the run. With
// one, the engine makes the approval itself from a store's checkout review when the review total
// is within it, and places the order without a prompt. Outside it, the engine asks as before and
// says why. The approval still goes through approvalProblem (limits.ts), the same gate as a
// clicked approval: exact total of this run's review, no subscriptions or memberships, the budget,
// one order per store, and the adapter re-reads the total right before the click.
//
// Only the person grants a mandate: the CLI flags (confirmed once in a terminal), the web app's
// "Buy without asking" setting (confirmed, same-origin, loopback or token), or the MCP server's
// environment. No MCP tool argument and nothing a model writes can create or widen one.

import { randomBytes } from "node:crypto";
import type { Money, StoreId } from "./types.js";
import { formatMoney } from "../stores/util.js";

/** "$60" for whole dollars, "$59.99" otherwise. */
export function dollars(m: Money): string {
  return m.currency === "USD" && m.cents % 100 === 0 ? `$${(m.cents / 100).toLocaleString("en-US")}` : formatMoney(m);
}

const STORES: StoreId[] = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"];

/** Where the person granted the mandate. */
export type MandateSource = "cli" | "web" | "mcp_env" | "library";

export interface Mandate {
  /** Random id: an approval made under this mandate carries it. */
  id: string;
  /** Most one order may cost, in USD (the checkout review total, shipping and tax included). */
  maxTotal: Money;
  /** Most all orders of the run may cost together (orders placed, placing or unknown count). */
  maxRunTotal?: Money;
  /** Store ids ("walmart", "shopify" = any Shopify shop) or Shopify domains ("allbirds.com"). Unset: any store of the run. */
  stores?: string[];
  /** ISO time after which it no longer buys. Unset: until the run ends. */
  expiresAt?: string;
  /** Most orders under this mandate in the run. Unset: one per store (the engine never orders twice at a store in a run). */
  maxOrders?: number;
  grantedBy: "user";
  grantedAt: string;
  via: MandateSource;
}

/** The limits as logged with each order bought under the mandate. */
export interface MandateLimits {
  maxTotal: Money;
  maxRunTotal?: Money;
  stores?: string[];
  expiresAt?: string;
  maxOrders?: number;
}

/** What a front end collects from the person. Amounts are dollars ("60", 60) or Money in USD. */
export interface MandateInput {
  maxTotal: number | string | Money;
  maxRunTotal?: number | string | Money;
  stores?: string | string[];
  /** ISO time, or a duration from now: "2h", "30m", "1d". */
  expiresAt?: string;
  expiresIn?: string;
  maxOrders?: number | string;
}

export class MandateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MandateError";
  }
}

/** Hard ceiling for one order under a mandate (a typo like 6000 for 60 is refused, not bought). */
export const MANDATE_MAX_CENTS = 1_000_000;

function usd(v: number | string | Money | undefined, what: string): Money | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let cents: number;
  if (typeof v === "object") {
    if ((v.currency ?? "USD").toUpperCase() !== "USD") throw new MandateError(`${what} must be in US dollars`);
    cents = v.cents;
  } else {
    const s = String(v).trim().replace(/^\$/, "").replace(/,/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new MandateError(`${what} must be an amount in dollars, like 60 or 59.99`);
    cents = Math.round(Number(s) * 100);
  }
  if (!Number.isInteger(cents) || cents <= 0) throw new MandateError(`${what} must be more than $0`);
  if (cents > MANDATE_MAX_CENTS) throw new MandateError(`${what} is over the ${formatMoney({ cents: MANDATE_MAX_CENTS, currency: "USD" })} limit for buying without asking`);
  return { cents, currency: "USD" };
}

/** "2h" -> 7200000. Minutes, hours or days; at least 1 minute, at most 30 days. */
export function parseDuration(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)\s*$/i.exec(s);
  if (!m) throw new MandateError(`"${s}" is not a duration; use minutes, hours or days, like 30m, 2h or 1d`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase()[0];
  const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
  if (ms < 60_000 || ms > 30 * 86_400_000) throw new MandateError("The expiry must be between 1 minute and 30 days");
  return Math.round(ms);
}

/** "walmart", "Best Buy", "walmart.com" -> store id; "allbirds.com" -> the domain; "shopify" stays. */
export function normalizeStoreEntry(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const alias: Record<string, StoreId> = { "best buy": "bestbuy", "best-buy": "bestbuy", amzn: "amazon", bby: "bestbuy" };
  const id = alias[s] ?? (STORES.includes(s as StoreId) ? (s as StoreId) : STORES.find((x) => s === `${x}.com`));
  if (id) return id;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return s;
  throw new MandateError(`Unknown store "${raw}" for buying without asking. Use amazon, walmart, ebay, bestbuy, target, shopify or a Shopify domain.`);
}

/** Make a mandate from what the person gave. Throws MandateError with a plain reason. */
export function makeMandate(input: MandateInput, via: MandateSource, now = new Date()): Mandate {
  if (!input || typeof input !== "object") throw new MandateError("No amount given for buying without asking");
  const maxTotal = usd(input.maxTotal, "The amount per order");
  if (!maxTotal) throw new MandateError("Buying without asking needs an amount per order, like 60");
  const maxRunTotal = usd(input.maxRunTotal, "The amount for the whole run");
  if (maxRunTotal && maxRunTotal.cents < maxTotal.cents) throw new MandateError("The amount for the whole run is less than the amount per order");
  const list = typeof input.stores === "string" ? input.stores.split(",") : Array.isArray(input.stores) ? input.stores : [];
  if (input.stores !== undefined && typeof input.stores !== "string" && !Array.isArray(input.stores)) throw new MandateError("stores must be a list");
  const stores = [...new Set(list.map(String).filter((x) => x.trim()).map(normalizeStoreEntry))];
  let expiresAt: string | undefined;
  const exp = input.expiresIn ?? input.expiresAt;
  if (exp !== undefined && exp !== null && String(exp).trim() !== "") {
    const text = String(exp).trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
      const t = Date.parse(text);
      if (!Number.isFinite(t)) throw new MandateError(`"${text}" is not a time`);
      if (t <= now.getTime()) throw new MandateError("The expiry is in the past");
      if (t - now.getTime() > 30 * 86_400_000) throw new MandateError("The expiry must be within 30 days");
      expiresAt = new Date(t).toISOString();
    } else {
      expiresAt = new Date(now.getTime() + parseDuration(text)).toISOString();
    }
  }
  let maxOrders: number | undefined;
  if (input.maxOrders !== undefined && input.maxOrders !== null && String(input.maxOrders).trim() !== "") {
    const n = Number(input.maxOrders);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new MandateError("maxOrders must be a whole number from 1 to 20");
    maxOrders = n;
  }
  const m: Mandate = {
    id: "mnd_" + randomBytes(8).toString("hex"), maxTotal, grantedBy: "user", grantedAt: now.toISOString(), via,
  };
  if (maxRunTotal) m.maxRunTotal = maxRunTotal;
  if (stores.length) m.stores = stores;
  if (expiresAt) m.expiresAt = expiresAt;
  if (maxOrders) m.maxOrders = maxOrders;
  return m;
}

/** Check a mandate handed to the engine (it may come from a library caller). Returns why it is unusable. */
export function invalidMandate(m: unknown): string | undefined {
  const x = m as Partial<Mandate> | undefined;
  if (!x || typeof x !== "object") return "no mandate";
  if (x.grantedBy !== "user") return "an up-front approval must come from the person";
  if (typeof x.id !== "string" || !x.id) return "the up-front approval has no id";
  const t = x.maxTotal;
  if (!t || !Number.isInteger(t.cents) || t.cents <= 0 || t.currency !== "USD") return "the up-front approval needs an amount per order in USD";
  if (t.cents > MANDATE_MAX_CENTS) return "the up-front approval is over the limit for buying without asking";
  if (x.maxRunTotal && (!Number.isInteger(x.maxRunTotal.cents) || x.maxRunTotal.currency !== "USD" || x.maxRunTotal.cents <= 0)) return "the run amount must be in USD";
  if (x.expiresAt !== undefined && !Number.isFinite(Date.parse(x.expiresAt))) return "the expiry is not a time";
  if (x.maxOrders !== undefined && (!Number.isInteger(x.maxOrders) || x.maxOrders < 1)) return "maxOrders must be at least 1";
  if (x.stores !== undefined && (!Array.isArray(x.stores) || x.stores.some((s) => typeof s !== "string"))) return "stores must be a list";
  return undefined;
}

/** True when the mandate lets the agent buy at this store (Shopify: by "shopify" or the shop's domain). */
export function mandateCovers(m: Mandate, store: StoreId, domain?: string): boolean {
  if (!m.stores?.length) return true;
  if (m.stores.includes(store)) return true;
  if (store !== "shopify") return false;
  if (!domain) return m.stores.some((s) => s.includes(".")); // a Shopify shop is named: the gate checks the domain
  const d = domain.toLowerCase().replace(/^www\./, "");
  return m.stores.some((s) => s === d);
}

export interface MandateCheck {
  store: StoreId;
  storeDomain?: string;
  /** The checkout review total this order would be approved for. */
  total: Money;
  now: Date;
  /** Orders under this mandate already placing, placed or unknown in this run. */
  ordersSoFar: number;
  /** All orders of the run so far (placed, placing, unknown), before this one. */
  runTotal: Money;
}

/**
 * Why this order is outside the mandate (the agent then asks the person), or undefined when the
 * mandate covers it. Plain words: they are shown to the person.
 */
export function mandateProblem(m: Mandate, c: MandateCheck): string | undefined {
  const bad = invalidMandate(m);
  if (bad) return bad;
  const where = c.store === "shopify" && c.storeDomain ? c.storeDomain : c.store;
  if (!mandateCovers(m, c.store, c.storeDomain)) return `${where} is not one of the stores you approved up front (${m.stores!.join(", ")})`;
  if (m.expiresAt && c.now.getTime() >= Date.parse(m.expiresAt)) return `your up-front approval expired at ${m.expiresAt.slice(0, 16).replace("T", " ")} UTC`;
  if (c.total.currency !== "USD") return `the checkout is in ${c.total.currency}; up-front approval is for US dollars only`;
  if (c.total.cents > m.maxTotal.cents) return `the total ${formatMoney(c.total)} is over your up-front limit of ${dollars(m.maxTotal)} per order`;
  if (m.maxRunTotal) {
    const after = (c.runTotal.currency === "USD" ? c.runTotal.cents : 0) + c.total.cents;
    if (after > m.maxRunTotal.cents) return `this order would bring the run to ${formatMoney({ cents: after, currency: "USD" })}, over your up-front limit of ${dollars(m.maxRunTotal)} for the run`;
  }
  if (m.maxOrders !== undefined && c.ordersSoFar >= m.maxOrders) return `your up-front approval allows ${m.maxOrders} order${m.maxOrders === 1 ? "" : "s"} in this run, and ${c.ordersSoFar === 1 ? "one was" : `${c.ordersSoFar} were`} already placed`;
  return undefined;
}

export function mandateLimits(m: Mandate): MandateLimits {
  const l: MandateLimits = { maxTotal: { ...m.maxTotal } };
  if (m.maxRunTotal) l.maxRunTotal = { ...m.maxRunTotal };
  if (m.stores?.length) l.stores = [...m.stores];
  if (m.expiresAt) l.expiresAt = m.expiresAt;
  if (m.maxOrders !== undefined) l.maxOrders = m.maxOrders;
  return l;
}

/** "up to $60 per order at walmart, target" (with the run cap and expiry when set). */
export function mandateText(m: MandateLimits): string {
  const parts = [`up to ${dollars(m.maxTotal)} per order ${m.stores?.length ? `at ${m.stores.join(", ")}` : "at any store in this run"}`];
  if (m.maxRunTotal) parts.push(`${dollars(m.maxRunTotal)} in all`);
  if (m.maxOrders !== undefined) parts.push(`at most ${m.maxOrders} order${m.maxOrders === 1 ? "" : "s"}`);
  parts.push(m.expiresAt ? `until ${m.expiresAt.slice(0, 16).replace("T", " ")} UTC` : "for this run only");
  return parts.join(", ");
}

/** What the CLI, web app and MCP show for an order bought under the mandate. */
export function boughtUnderMandateText(m: Pick<MandateLimits, "maxTotal">): string {
  return `Bought under your up-front approval (up to ${dollars(m.maxTotal)})`;
}

/** The question the CLI asks once at start. */
export function mandateQuestion(m: MandateLimits): string {
  return `Buy without asking, ${mandateText(m)}?`;
}

const truthy = (v: string | undefined) => /^(1|true|on|yes)$/i.test((v ?? "").trim());

/**
 * The MCP server's mandate, from the environment the person set for the server:
 * OSA_MCP_ALLOW_ORDERS=1 and OSA_MCP_APPROVE_UP_TO=60, with optional OSA_MCP_APPROVE_STORES,
 * OSA_MCP_APPROVE_EXPIRES (a duration from the server's start, or an ISO time),
 * OSA_MCP_APPROVE_RUN_TOTAL and OSA_MCP_APPROVE_MAX_ORDERS. Never from a tool call.
 * Throws MandateError when the variables are set but wrong (the server then refuses to start a mandate).
 */
export function mandateFromEnv(env: NodeJS.ProcessEnv, startedAt = new Date()): Mandate | undefined {
  const upTo = env.OSA_MCP_APPROVE_UP_TO?.trim();
  if (!upTo) return undefined;
  if (!truthy(env.OSA_MCP_ALLOW_ORDERS)) throw new MandateError("OSA_MCP_APPROVE_UP_TO needs OSA_MCP_ALLOW_ORDERS=1 as well");
  return makeMandate({
    maxTotal: upTo,
    maxRunTotal: env.OSA_MCP_APPROVE_RUN_TOTAL?.trim() || undefined,
    stores: env.OSA_MCP_APPROVE_STORES?.trim() || undefined,
    expiresIn: env.OSA_MCP_APPROVE_EXPIRES?.trim() || undefined,
    maxOrders: env.OSA_MCP_APPROVE_MAX_ORDERS?.trim() || undefined,
  }, "mcp_env", startedAt);
}
