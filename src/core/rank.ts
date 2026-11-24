// Ranking: pure functions that score the offers found for one item and pick one, with a one-line
// factual reason. Goals: best_value (default), cheapest, fastest, top_rated.
//
// An accessory for the item asked for ("ESR for AirPods Pro 3 Case" when the item is "AirPods Pro
// 3") is left out when some offer is the item itself: a person who names a product wants the
// product, not its case or charger. See accessoryOf(). With a model number in the query, offers
// for another model, and offers priced far below the model's offers, are left out the same way.
//
// What counts: the delivered total (unit price x quantity + shipping), the rating weighted by how
// many reviews back it (Bayesian average), the delivery date, whether the title matches the item
// and its hard requirements. Sponsored, used and refurbished offers are penalized. Out of stock,
// subscription, membership and over-the-limit offers are never picked. The price per unit
// (core/units.ts) only breaks exact ties (same score, same delivered total).

import type { ItemRequest, Money, Offer, Pick, ShoppingRequest } from "./types.js";
import { formatMoney } from "../stores/util.js";
import { commonPer, compareUnitPrice } from "./units.js";

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
/** The exclusion reason of an accessory for the item (see accessoryOf). */
export const ACCESSORY_REASON = "accessory, not the item itself";
/** The exclusion reason of an offer without the model the query names ("AirPods 5" for "AirPods Pro 3"). */
export const MODEL_REASON = "another model, not the item itself";
/** The exclusion reason of an offer priced far below the named model's offers (see scoreOffers). */
export const PRICE_REASON = "priced far below the item, not the item itself";
const NOT_THE_ITEM = new Set([ACCESSORY_REASON, MODEL_REASON, PRICE_REASON]);
const MEMBERSHIP = /\b(prime membership|amazon prime|walmart\+|walmart plus|membership|free trial|trial offer|subscription box|gift card)\b/i;

// ---------- accessories ----------

// Words that name an accessory (or an accessory-type product: a query with one of them asks for an
// accessory, so nothing is left out). Singular forms; plurals are matched too.
const ACCESSORY_WORDS = new Set([
  "case", "cover", "charger", "cable", "cord", "protector", "strap", "band", "tip", "eartip", "skin", "sleeve",
  "pouch", "holder", "mount", "stand", "dock", "hub", "adapter", "dongle", "splitter", "replacement", "refill",
  "keychain", "lanyard", "hook", "clip", "decal", "sticker", "shell", "film", "cushion", "earpad", "bumper",
  "folio", "holster", "grip", "bag", "battery", "batteries", "controller", "remote", "stylus", "keyboard", "accessory",
  "accessories", "attachment", "part", "spare", "wrap", "guard",
]);
// "for", "compatible with" and the like: what follows is the product the accessory is for.
const ACCESSORY_MARKER = /\b(?:compatible\s+(?:with|for)|designed\s+for|made\s+for|replacement\s+for|works\s+with|fits|for)\b/i;
// One word allowed between the product name and the accessory word: "AirPods Pro 3 Silicone Case".
const ACCESSORY_ADJ = "silicone|protective|carrying|leather|clear|hard|soft|magnetic|travel|shockproof|rugged|slim";

function isAccessoryWord(w: string): boolean {
  return ACCESSORY_WORDS.has(w) || ACCESSORY_WORDS.has(w.replace(/s$/, "")) || ACCESSORY_WORDS.has(w.replace(/es$/, ""));
}

/** True when the query itself asks for an accessory ("airpods pro 3 case", "usb c hub", "charger for pixel"). */
export function asksForAccessory(query: string): boolean {
  if (/\b(?:for|compatible|fits)\b/i.test(query)) return true;
  return words(query).some(isAccessoryWord);
}

// Accessory words that name the thing sold even with no "for" ("Silicone AirPods Case with Clip"),
// and the words before them that make them part of the product instead ("MagSafe Charging Case",
// "Jet Black Aluminum Case").
const ACCESSORY_HEAD = /\b(?:case|cover|sleeve|skin|protector|pouch|holster|folio|bumper|shell|decal|sticker|keychain|lanyard)(?:e?s)?\b/giu;
const PART_OF_PRODUCT = new Set(["charging", "charge", "aluminum", "aluminium", "titanium", "steel", "ceramic", "gold", "silver"]);

const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Is the title an accessory for the product the query names, not the product? Three shapes:
 *   "ESR for AirPods Pro 3 Case", "Silicone Cover Compatible with AirPods Pro 3": an accessory word,
 *     and the query's words come after "for" / "compatible with" while little of them comes before;
 *   "AirPods Pro 3 Case", "Apple Watch Series 11 Band": the product's name directly followed by an
 *     accessory word (one adjective allowed);
 *   "AirPods Pro (3rd Generation) Case with Clip": a case, cover, sleeve, skin... word after at
 *     least half of the query's words and before any "with" / "includes" / "+", not part of the
 *     product ("Charging Case", "Aluminum Case") and not followed by "included".
 * Never when the query asks for an accessory itself. "Apple AirPods Pro 3 ... with USB-C Charging
 * Case" is the product (the case comes after "with", and the name comes first).
 */
export function accessoryOf(query: string, title: string): boolean {
  if (asksForAccessory(query)) return false;
  const q = words(query).filter((w) => !STOP.has(w));
  if (!q.length) return false;
  if (!words(title).some(isAccessoryWord)) return false;
  const m = ACCESSORY_MARKER.exec(title);
  if (m && titleMatch(query, title.slice(m.index + m[0].length)) >= 0.6 && titleMatch(query, title.slice(0, m.index)) < 0.5) return true;
  // The query's words in order (or its last words, at least 60% of them, so "apple airpods pro 3"
  // also finds "AirPods Pro 3 Case"), then an accessory word.
  const sep = "[^\\p{L}\\p{N}]*";
  const nouns = [...ACCESSORY_WORDS].map(escapeRe).join("|");
  for (let from = 0; q.length - from >= Math.max(1, Math.ceil(q.length * 0.6)); from++) {
    const name = q.slice(from).map(escapeRe).join(sep);
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${name}[^\\p{L}\\p{N}]+(?:(?:${ACCESSORY_ADJ})[^\\p{L}\\p{N}]+)?(?:${nouns})(?:e?s)?(?![\\p{L}\\p{N}])`, "iu");
    if (re.test(title)) return true;
  }
  for (const h of title.matchAll(ACCESSORY_HEAD)) {
    const before = title.slice(0, h.index);
    if (/\b(?:with|includes?|including|plus)\b|\+/i.test(before)) break;
    if (PART_OF_PRODUCT.has(words(before).at(-1) ?? "")) continue;
    if (/^[^\p{L}\p{N}]*(?:included|includes)\b/iu.test(title.slice(h.index! + h[0].length))) continue;
    if (titleMatch(query, before) >= 0.5) return true;
  }
  return false;
}

// Words that make a model ("AirPods Pro 3", "iPhone 17 Pro Max"); they count only next to a model number.
const MODEL_WORDS = new Set(["pro", "max", "mini", "plus", "ultra", "lite", "se", "xl", "fe"]);
// Units: a number with one of these is a size or a count ("30 lb", "65w", "4k"), not a model.
const UNIT = /^(?:lb|lbs|pound|pounds|oz|ounce|ounces|ml|l|liter|liters|litre|litres|g|kg|ft|feet|foot|in|inch|inches|pack|pk|packs|count|ct|pc|pcs|piece|pieces|w|watt|watts|mah|gb|tb|mb|mm|cm|m|v|volt|volts|hz|k|p|qt|gal|gallon|gallons|x|yd|yard|yards|sq|cup|cups|cu|ply|sheets|rolls)$/;
const ORDINALS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/**
 * The words of the query that name a model: numbers that are not sizes or counts ("3" in "AirPods
 * Pro 3", "17" and "ps5"), and with one of them "pro", "max", "mini"... [] for a generic query
 * ("usb c hub hdmi", "dry dog food 30 lb").
 */
export function modelTokens(query: string): string[] {
  const ws = words(query);
  const nums: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (!/\d/.test(w)) continue;
    if (/^\d+[a-z]+$/.test(w) && UNIT.test(w.replace(/^\d+/, ""))) continue;
    if (/^\d+$/.test(w) && ((ws[i + 1] && UNIT.test(ws[i + 1])) || /^(?:size|sz|of|set|pack)$/.test(ws[i - 1] ?? ""))) continue;
    nums.push(w);
  }
  if (!nums.length) return [];
  return [...new Set([...nums, ...ws.filter((w) => MODEL_WORDS.has(w))])];
}

/** Does the title name this word? A number also matches its ordinal: "3" in "(3rd Generation)", "Third". */
function hasWord(titleWords: Set<string>, flat: string, w: string): boolean {
  if (titleWords.has(w) || (w.length >= 3 && flat.includes(w)) || titleWords.has(w.replace(/s$/, "")) || titleWords.has(`${w}s`)) return true;
  if (/^\d+$/.test(w)) {
    if ([...titleWords].some((t) => new RegExp(`^${w}(?:st|nd|rd|th)$`).test(t))) return true;
    if (ORDINALS[Number(w)] && titleWords.has(ORDINALS[Number(w)])) return true;
  }
  return false;
}

/** True when the title names every model word of the query (see modelTokens). */
export function hasModel(tokens: string[], title: string): boolean {
  if (!tokens.length) return true;
  const tw = new Set(words(title));
  const flat = squash(title);
  return tokens.every((t) => hasWord(tw, flat, t));
}

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
  for (const w of q) if (hasWord(titleWords, flat, w)) hit++;
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
  if (offer.currencyMismatch || offer.price.currency !== currency) return `currency_mismatch: priced in ${offer.price.currency}, not ${currency}`;
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
  // A named product, not something else that names it. Only when the query does not ask for an
  // accessory, and only when some offer is the item itself; otherwise nothing changes.
  //   - Accessories (its case, charger, cover) are left out when some offer is not an accessory
  //     and names the item.
  //   - With a model in the query ("AirPods Pro 3"), offers without it ("AirPods 5", "AirPods Pro
  //     (1/2 Generation)", "EarPods") are left out when some offer names the model, and so are offers
  //     under 40% of the median price of two or more offers that name it (a $10 "case" whose title
  //     reads like the product).
  if (!asksForAccessory(item.query)) {
    const open = all.filter((s) => !s.excluded);
    const acc = new Set(open.filter((s) => accessoryOf(item.query, s.offer.title)));
    const products = open.filter((s) => !acc.has(s) && s.titleMatch >= 0.6);
    if (acc.size && products.length) for (const s of acc) s.excluded = ACCESSORY_REASON;
    const tokens = modelTokens(item.query);
    const exact = products.filter((s) => hasModel(tokens, s.offer.title));
    if (tokens.length && exact.length) {
      for (const s of open) if (!s.excluded && !hasModel(tokens, s.offer.title)) s.excluded = MODEL_REASON;
      if (exact.length >= 2) {
        const prices = exact.map((s) => s.offer.price.cents).sort((a, b) => a - b);
        const mid = prices.length >> 1;
        const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
        for (const s of open) if (!s.excluded && s.offer.price.cents < median * 0.4) s.excluded = PRICE_REASON;
      }
    }
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
  // Unit price only breaks ties (same score and same delivered total); it never changes the score.
  const per = commonPer(pool.map((s) => s.offer));
  pool.sort((a, b) => b.score - a.score || a.total.cents - b.total.cents || compareUnitPrice(a.offer, b.offer, per) || b.rating - a.rating);
  return [...pool, ...excluded];
}

/**
 * Mark offers priced in another currency than `currency` (currencyMismatch), and drop a shipping
 * cost in another currency than the price (it becomes unknown). Returns the offers and the other
 * currencies seen, e.g. ["EUR"].
 */
export function markCurrency(offers: Offer[], currency = "USD"): { offers: Offer[]; shown: string[] } {
  const shown = new Set<string>();
  const out = offers.map((o) => {
    let x = o;
    if (x.shipping && x.shipping.currency !== x.price.currency) x = { ...x, shipping: undefined };
    if (x.listPrice && x.listPrice.currency !== x.price.currency) x = { ...x, listPrice: undefined };
    if (x.price.currency !== currency || x.currencyMismatch) {
      shown.add(x.price.currency);
      if (!x.currencyMismatch) x = { ...x, currencyMismatch: true };
    }
    return x;
  });
  shown.delete(currency);
  return { offers: out, shown: [...shown] };
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
  const notTheItem = scored.filter((s) => NOT_THE_ITEM.has(s.excluded ?? "")).map((s) => `${s.offer.store}|${s.offer.url}`);
  return {
    itemId: item.id,
    offer: best.offer,
    score: best.score,
    reason: reasonFor(item, best, pool, opts.goal ?? "best_value", scored),
    alternatives: pool.slice(1, 5).map((s) => s.offer),
    ...(notTheItem.length ? { notTheItem: notTheItem.slice(0, 50) } : {}),
  };
}

const STORE_NAMES: Record<string, string> = { amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target" };

/** Cut a text at a word boundary, with "…" when something was cut. Never mid-word. */
export function clipWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if ([...t].length <= max) return t;
  const cut = [...t].slice(0, max + 1).join("");
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.4 ? cut.slice(0, at) : cut.slice(0, -1)).replace(/[\s,;:.(-]+$/, "")}…`;
}

/** "9 left out: 5 out of stock, 4 over $15.00 each" for the offers that were found but not compared; "" when none. */
export function leftOutText(all: ScoredOffer[]): string {
  const out = all.filter((s) => s.excluded);
  if (!out.length) return "";
  const counts = new Map<string, number>();
  for (const s of out) {
    // "currency_mismatch: priced in EUR, not USD" -> "priced in EUR, not USD"; "does not list a, b" is one group.
    const why = s.excluded!.replace(/^currency_mismatch:\s*/, "").replace(/^does not list .*/, "without what you asked for in the title");
    // "3 accessories (not the item itself)": the count reads as a plural.
    if (why === ACCESSORY_REASON) { counts.set("accessory", (counts.get("accessory") ?? 0) + 1); continue; }
    if (why === MODEL_REASON) { counts.set("model", (counts.get("model") ?? 0) + 1); continue; }
    if (why === PRICE_REASON) { counts.set("price", (counts.get("price") ?? 0) + 1); continue; }
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  const groups = [...counts].sort((a, b) => b[1] - a[1]).map(([why, n]) =>
    why === "accessory" ? `${n} ${n === 1 ? "accessory" : "accessories"} (not the item itself)`
    : why === "model" ? `${n} ${n === 1 ? "other model" : "other models"}`
    : why === "price" ? `${n} priced far below the item`
    : `${n} ${why}`);
  return `${out.length} left out: ${groups.join(", ")}`;
}

/**
 * One factual line: what makes the pick win, its delivered total, shipping, rating, delivery, store.
 * The count is the offers that were compared (the pool); with `all` (every offer found for the
 * item) it also says how many were found and why the others were left out.
 */
export function reasonFor(item: ItemRequest, best: ScoredOffer, pool: ScoredOffer[], goal: Goal, all?: ScoredOffer[]): string {
  const o = best.offer;
  const n = pool.length;
  const parts: string[] = [];
  const cheapest = pool.every((s) => s.total.cents >= best.total.cents);
  const qty = item.quantity > 1 ? ` for ${item.quantity}` : "";
  const totalText = `${formatMoney(best.total)}${qty} ${o.shipping === undefined ? "plus shipping" : "delivered"}`;
  if (n === 1) parts.push(`Only offer that fits (${totalText})`);
  else if (goal === "fastest" && best.days !== undefined && pool.every((s) => s.days === undefined || s.days >= best.days!)) parts.push(`Soonest delivery of the ${n} offers compared (${totalText})`);
  else if (goal === "top_rated" && pool.every((s) => s.rating <= best.rating)) parts.push(`Best rating for its review count of the ${n} offers compared (${totalText})`);
  else if (cheapest) parts.push(`Lowest ${o.shipping === undefined ? "price" : "delivered total"} of the ${n} offers compared: ${totalText}`);
  else parts.push(`${totalText}, best mix of price and rating of the ${n} offers compared`);

  if (o.shipping === undefined) parts.push("shipping not shown");
  else if (o.shipping.cents === 0) parts.push("free shipping");
  else parts.push(`${formatMoney(o.shipping)} shipping`);
  if (o.rating && o.rating.count > 0) parts.push(`${o.rating.stars.toFixed(1)} stars from ${o.rating.count.toLocaleString("en-US")} reviews`);
  else parts.push("no reviews shown");
  if (o.deliveryText) parts.push(clipWords(o.deliveryText, 60));
  const met = (item.mustHave ?? []).filter((r) => !best.missing.includes(r));
  if (met.length) parts.push(`lists ${met.join(", ")}`);
  if (best.missing.length) parts.push(`title does not list ${best.missing.join(", ")}`);
  if (o.perUnit) parts.push(o.perUnit.text);
  if (o.condition && o.condition !== "new") parts.push(o.condition);
  if (o.sponsored) parts.push("sponsored");
  parts.push(o.store === "shopify" ? o.storeDomain : STORE_NAMES[o.store] ?? o.store);
  const left = all ? leftOutText(all) : "";
  return parts.join(", ") + (left ? `. ${all!.length} found, ${left}` : "");
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
      const shown = [...new Set(mine.filter((o) => o.currencyMismatch || o.price.currency !== currency).map((o) => o.price.currency))];
      unpicked.push({
        itemId: item.id,
        reason: !mine.length ? "no offers found"
          : shown.length && mine.every((o) => o.currencyMismatch || o.price.currency !== currency) ? `every offer was priced in ${shown.join(", ")}, not ${currency}; none can be compared`
          : `no offer fits (${reasons.slice(0, 3).join("; ")})`,
      });
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
