// Ranking: pure functions that score the offers found for one item and pick one, with a one-line
// factual reason. Goals: best_value (default), cheapest, fastest, top_rated.
//
// What counts: the delivered total (unit price x quantity + shipping), the rating weighted by how
// many reviews back it (Bayesian average), the delivery date, whether the title matches the item
// and its hard requirements. Sponsored, used and refurbished offers are penalized. Out of stock,
// subscription, membership and over-the-limit offers are never picked.

import type { ItemRequest, Money, Offer, Pick, ShoppingRequest } from "./types.js";
import { formatMoney } from "../stores/util.js";

export type Goal = NonNullable<ShoppingRequest["goal"]>;

export interface RankOptions {
  goal?: Goal;
  /** "Now", for delivery-date scoring. Default: the current time. */
  now?: Date;
  /** Currency the run works in; offers in another currency are left out. Default USD. */
  currency?: string;
  /** Bayesian prior: mean stars and how many reviews it weighs. Default 3.8 and 30. */
  priorStars?: number;
  priorWeight?: number;
}

export interface ScoredOffer {
  offer: Offer;
  /** Delivered total for the item's quantity: price x quantity + shipping (unknown shipping = 0). */
  total: Money;
  score: number;
  /** Why it can never be picked, when it cannot. */
  excluded?: string;
  /** Hard requirements the title does not mention. */
  missing: string[];
  titleMatch: number;            // 0..1 share of the query words in the title
  rating: number;                // Bayesian stars, 0..5
  days?: number;                 // days until delivery, when the date is known
}

const WEIGHTS: Record<Goal, { price: number; rating: number; match: number; speed: number }> = {
  best_value: { price: 0.45, rating: 0.3, match: 0.15, speed: 0.1 },
  cheapest: { price: 0.75, rating: 0.1, match: 0.15, speed: 0 },
  fastest: { price: 0.2, rating: 0.1, match: 0.15, speed: 0.55 },
  top_rated: { price: 0.15, rating: 0.6, match: 0.15, speed: 0.1 },
};

const STOP = new Set(["a", "an", "the", "for", "of", "and", "or", "with", "in", "on", "to", "pack", "set", "new", "my", "me", "x"]);
const MEMBERSHIP = /\b(prime membership|amazon prime|walmart\+|walmart plus|membership|free trial|trial offer|subscription box|gift card)\b/i;

/** Delivered total for `quantity` units: unit price x quantity + shipping (unknown shipping counts as 0). */
export function deliveredTotal(offer: Offer, quantity: number): Money {
  const ship = offer.shipping && offer.shipping.currency === offer.price.currency ? offer.shipping.cents : 0;
  return { cents: offer.price.cents * Math.max(1, quantity) + ship, currency: offer.price.currency };
}

/**
 * Bayesian average rating: (prior * weight + stars * count) / (weight + count). An offer with
 * 5 stars from 3 reviews scores below 4.6 stars from 10,000. No rating = the prior.
 */
export function bayesianRating(rating: Offer["rating"], prior = 3.8, weight = 30): number {
  if (!rating || !Number.isFinite(rating.stars) || !Number.isFinite(rating.count) || rating.count <= 0) return prior;
  const stars = Math.min(5, Math.max(0, rating.stars));
  return (prior * weight + stars * rating.count) / (weight + rating.count);
}

/** Lower-cased words of a text, for matching. "USB-C 4K60" -> ["usb", "c", "4k60", "usbc"]. */
export function words(text: string): string[] {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return t ? t.split(" ") : [];
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Share of the query's meaningful words that the title contains (0..1). */
export function titleMatch(query: string, title: string): number {
  const q = [...new Set(words(query).filter((w) => !STOP.has(w)))];
  if (!q.length) return 1;
  const titleWords = new Set(words(title));
  const flat = squash(title);
  let hit = 0;
  for (const w of q) {
    if (titleWords.has(w) || (w.length >= 3 && flat.includes(w)) || titleWords.has(w.replace(/s$/, "")) || titleWords.has(`${w}s`)) hit++;
  }
  return hit / q.length;
}

/** Hard requirements the offer does not mention in its title (or in raw text the adapter gave). */
export function missingRequirements(item: ItemRequest, offer: Offer): string[] {
  if (!item.mustHave?.length) return [];
  const extra = typeof offer.raw?.text === "string" ? ` ${offer.raw.text}` : "";
  const hay = `${offer.title}${extra}`;
  const flat = squash(hay);
  const hayWords = new Set(words(hay));
  return item.mustHave.filter((req) => {
    const ws = words(req).filter((w) => !STOP.has(w));
    if (!ws.length) return false;
    if (flat.includes(squash(req))) return false;
    return !ws.every((w) => hayWords.has(w) || (w.length >= 3 && flat.includes(w)));
  });
}

/** Why the offer can never be picked for the item, or undefined when it can. */
export function exclusionReason(item: ItemRequest, offer: Offer, currency = "USD"): string | undefined {
  if (!offer.inStock) return "out of stock";
  if (offer.subscription) return "subscription offer";
  if (MEMBERSHIP.test(offer.title)) return "membership or trial offer";
  if (!Number.isFinite(offer.price?.cents) || offer.price.cents <= 0) return "no price";
  if (offer.price.currency !== currency) return `priced in ${offer.price.currency}`;
  if (item.maxPrice && offer.price.cents > item.maxPrice.cents) return `over ${formatMoney(item.maxPrice)} each`;
  return undefined;
}

function daysUntil(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return Math.max(0, Math.round((d.getTime() - now.getTime()) / 86_400_000));
}

function wantsUsed(item: ItemRequest): boolean {
  if (item.condition === "used" || item.condition === "any") return true;
  if (item.condition === "new") return false;
  return /\b(used|refurbished|renewed|pre-owned|open box)\b/i.test(`${item.query} ${item.description}`);
}

/** Score every offer for the item. Sorted best first; excluded offers come last with score -1. */
export function scoreOffers(item: ItemRequest, offers: Offer[], opts: RankOptions = {}): ScoredOffer[] {
  const goal = opts.goal ?? "best_value";
  const now = opts.now ?? new Date();
  const currency = opts.currency ?? "USD";
  const w = WEIGHTS[goal];
  const used = wantsUsed(item);

  const all: ScoredOffer[] = dedupeOffers(offers).map((offer) => ({
    offer,
    total: deliveredTotal(offer, item.quantity),
    score: 0,
    excluded: exclusionReason(item, offer, currency),
    missing: missingRequirements(item, offer),
    titleMatch: titleMatch(item.query, offer.title),
    rating: bayesianRating(offer.rating, opts.priorStars, opts.priorWeight),
    days: daysUntil(offer.deliveryDate, now),
  }));

  // Hard requirements are hard only when some offer meets them all; otherwise titles may simply
  // not list them and the offers are ranked with a penalty instead.
  const eligible = all.filter((s) => !s.excluded);
  if (item.mustHave?.length && eligible.some((s) => s.missing.length === 0)) {
    for (const s of eligible) if (s.missing.length) s.excluded = `does not list ${s.missing.join(", ")}`;
  }
  const pool = all.filter((s) => !s.excluded);
  if (!pool.length) return all.map((s) => ({ ...s, score: -1 }));

  const minTotal = Math.min(...pool.map((s) => s.total.cents));
  const known = pool.map((s) => s.days).filter((d): d is number => d !== undefined);
  const minDays = known.length ? Math.min(...known) : undefined;

  for (const s of pool) {
    const price = minTotal / s.total.cents;                           // 1 for the cheapest
    const rating = s.rating / 5;
    const speed = s.days === undefined ? 0.35 : 1 / (1 + Math.max(0, s.days - (minDays ?? 0)) / 2);
    let score = w.price * price + w.rating * rating + w.match * s.titleMatch + w.speed * speed;
    if (s.offer.sponsored) score -= 0.05;
    if (!used && s.offer.condition && s.offer.condition !== "new") score -= 0.15;
    if (s.offer.shipping === undefined) score -= 0.02;
    if (s.missing.length) score -= Math.min(0.3, 0.12 * s.missing.length);
    if (s.titleMatch < 0.34) score -= 0.25;
    if (goal === "cheapest" && s.offer.rating && s.offer.rating.count >= 20 && s.offer.rating.stars < 3) score -= 0.2;
    s.score = Math.round(score * 10_000) / 10_000;
  }
  const excluded = all.filter((s) => s.excluded).map((s) => ({ ...s, score: -1 }));
  pool.sort((a, b) => b.score - a.score || a.total.cents - b.total.cents || b.rating - a.rating);
  return [...pool, ...excluded];
}

/** Same product listed twice (same store and URL or product id): keep the first. */
export function dedupeOffers(offers: Offer[]): Offer[] {
  const seen = new Set<string>();
  const out: Offer[] = [];
  for (const o of offers) {
    const k = `${o.store}|${o.storeDomain}|${o.productId || o.url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

/** The pick for one item, or undefined when no offer can be picked. */
export function pickForItem(item: ItemRequest, offers: Offer[], opts: RankOptions = {}): Pick | undefined {
  const scored = scoreOffers(item, offers, opts);
  const pool = scored.filter((s) => !s.excluded);
  if (!pool.length) return undefined;
  const best = pool[0];
  return {
    itemId: item.id,
    offer: best.offer,
    score: best.score,
    reason: reasonFor(item, best, pool, opts.goal ?? "best_value"),
    alternatives: pool.slice(1, 5).map((s) => s.offer),
  };
}

const STORE_NAMES: Record<string, string> = { amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target" };

/** One factual line: what makes the pick win, its delivered total, shipping, rating, delivery, store. */
export function reasonFor(item: ItemRequest, best: ScoredOffer, pool: ScoredOffer[], goal: Goal): string {
  const o = best.offer;
  const n = pool.length;
  const parts: string[] = [];
  const cheapest = pool.every((s) => s.total.cents >= best.total.cents);
  const qty = item.quantity > 1 ? ` for ${item.quantity}` : "";
  const totalText = `${formatMoney(best.total)}${qty} ${o.shipping === undefined ? "plus shipping" : "delivered"}`;
  if (n === 1) parts.push(`Only offer that fits (${totalText})`);
  else if (goal === "fastest" && best.days !== undefined && pool.every((s) => s.days === undefined || s.days >= best.days!)) parts.push(`Soonest delivery of ${n} offers (${totalText})`);
  else if (goal === "top_rated" && pool.every((s) => s.rating <= best.rating)) parts.push(`Best rating for its review count of ${n} offers (${totalText})`);
  else if (cheapest) parts.push(`Lowest ${o.shipping === undefined ? "price" : "delivered total"} of ${n} offers: ${totalText}`);
  else parts.push(`${totalText}, best mix of price and rating of ${n} offers`);

  if (o.shipping === undefined) parts.push("shipping not shown");
  else if (o.shipping.cents === 0) parts.push("free shipping");
  else parts.push(`${formatMoney(o.shipping)} shipping`);
  if (o.rating && o.rating.count > 0) parts.push(`${o.rating.stars.toFixed(1)} stars from ${o.rating.count.toLocaleString("en-US")} reviews`);
  else parts.push("no reviews shown");
  if (o.deliveryText) parts.push(o.deliveryText.length > 40 ? o.deliveryText.slice(0, 40).trim() : o.deliveryText);
  const met = (item.mustHave ?? []).filter((r) => !best.missing.includes(r));
  if (met.length) parts.push(`lists ${met.join(", ")}`);
  if (best.missing.length) parts.push(`title does not list ${best.missing.join(", ")}`);
  if (o.condition && o.condition !== "new") parts.push(o.condition);
  if (o.sponsored) parts.push("sponsored");
  parts.push(o.store === "shopify" ? o.storeDomain : STORE_NAMES[o.store] ?? o.store);
  return parts.join(", ");
}

export interface PickResult {
  picks: Pick[];
  total: Money;
  overBudget: boolean;
  /** Item ids with no offer that can be picked, with why. */
  unpicked: { itemId: string; reason: string }[];
}

/** Pick every item of the request from all offers found (any store) and add up the total. */
export function pickAll(request: ShoppingRequest, offers: Offer[], opts: Omit<RankOptions, "goal"> & { budget?: Money } = {}): PickResult {
  const currency = opts.currency ?? request.budget?.currency ?? "USD";
  const picks: Pick[] = [];
  const unpicked: PickResult["unpicked"] = [];
  let cents = 0;
  for (const item of request.items) {
    const mine = offers.filter((o) => o.itemId === item.id);
    const pick = pickForItem(item, mine, { ...opts, currency, goal: request.goal ?? "best_value" });
    if (pick) {
      picks.push(pick);
      cents += deliveredTotal(pick.offer, item.quantity).cents;
    } else {
      const reasons = [...new Set(scoreOffers(item, mine, { ...opts, currency }).map((s) => s.excluded).filter(Boolean))];
      unpicked.push({ itemId: item.id, reason: mine.length ? `no offer fits (${reasons.slice(0, 3).join("; ")})` : "no offers found" });
    }
  }
  const budget = opts.budget ?? request.budget;
  const total = { cents, currency };
  return { picks, total, overBudget: !!budget && cents > budget.cents, unpicked };
}

/**
 * "Every store" mode: pick every item at each store (each Shopify shop counts as a store) from that
 * store's own offers, so each store gets a full cart and the carts show real delivered totals side
 * by side. A store whose cart would go over the budget gets no picks (named in `unpicked`, item id
 * "*"). `total` is the cheapest complete store cart, the one you would buy; `overBudget` is true
 * only when every store is over the budget.
 */
export function pickEveryStore(request: ShoppingRequest, offers: Offer[], opts: Omit<RankOptions, "goal"> & { budget?: Money } = {}): PickResult & { storeTotals: { key: string; total: Money; complete: boolean }[] } {
  const currency = opts.currency ?? request.budget?.currency ?? "USD";
  const budget = opts.budget ?? request.budget;
  const groups = new Map<string, Offer[]>();
  for (const o of offers) {
    const key = o.store === "shopify" ? `shopify:${o.storeDomain}` : o.store;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const picks: Pick[] = [];
  const unpicked: PickResult["unpicked"] = [];
  const storeTotals: { key: string; total: Money; complete: boolean }[] = [];
  let within = 0;
  let tried = 0;
  for (const [key, mine] of groups) {
    const r = pickAll({ ...request, budget: undefined }, mine, { ...opts, currency, budget: undefined });
    if (!r.picks.length) continue;
    tried++;
    const label = key.startsWith("shopify:") ? key.slice(8) : STORE_NAMES[key] ?? key;
    if (budget && r.total.cents > budget.cents) {
      unpicked.push({ itemId: "*", reason: `${label}: the cart would be ${formatMoney(r.total)}, over the ${formatMoney(budget)} budget` });
      continue;
    }
    within++;
    picks.push(...r.picks);
    storeTotals.push({ key, total: r.total, complete: r.picks.length === request.items.length });
  }
  for (const item of request.items) {
    if (!picks.some((p) => p.itemId === item.id)) {
      unpicked.push({ itemId: item.id, reason: offers.some((o) => o.itemId === item.id) ? "no store has an offer that fits" : "no offers found" });
    }
  }
  const full = storeTotals.filter((s) => s.complete);
  const cheapest = (full.length ? full : storeTotals).reduce<Money | undefined>((m, s) => (!m || s.total.cents < m.cents ? s.total : m), undefined);
  return { picks, total: cheapest ?? { cents: 0, currency }, overBudget: !!budget && tried > 0 && within === 0, unpicked, storeTotals };
}
