// Shared view helpers for the surfaces (web server, CLI, MCP): store names, money text and the
// comparison rows built from the RunEvent stream.

import type { Money, Offer, Pick, RunEvent, StoreId } from "../core/types.js";
import { formatMoney } from "../stores/util.js";

export const STORE_IDS: StoreId[] = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"];

export const STORE_NAMES: Record<StoreId, string> = {
  amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target", shopify: "Shopify",
};

export function storeName(store: StoreId, domain?: string): string {
  return store === "shopify" && domain ? domain : STORE_NAMES[store] ?? store;
}

export function money(m: Money | undefined): string {
  return formatMoney(m);
}

export function dollarsToMoney(value: number | string, currency = "USD"): Money | undefined {
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return { cents: Math.round(n * 100), currency };
}

/** " (IDR, not compared)" for an offer a store priced in another currency than US dollars, else "". */
export function currencyMark(o: Offer): string {
  return o.currencyMismatch ? ` (${o.price.currency}, not compared)` : "";
}

/** Price plus shipping when shipping is known; undefined shipping counts as unknown (price only). */
export function deliveredCents(o: Offer): number {
  return o.price.cents + (o.shipping?.cents ?? 0);
}

export function shippingText(o: Offer): string {
  if (!o.shipping) return "not shown";
  return o.shipping.cents === 0 ? "Free" : money(o.shipping);
}

export function ratingText(o: Offer): string {
  if (!o.rating) return "";
  return `${o.rating.stars.toFixed(1)} (${o.rating.count.toLocaleString("en-US")})`;
}

export interface CompareRow {
  offer: Offer;
  best: boolean;
  alternative: boolean;
}

export interface CompareItem {
  itemId: string;
  label: string;
  pick?: Pick;
  rows: CompareRow[];
}

/** Build the comparison per item from events: every offer, cheapest delivered first, pick on top. */
export function compareFromEvents(events: RunEvent[]): CompareItem[] {
  const labels = new Map<string, string>();
  const offers = new Map<string, Offer[]>();
  let picks: Pick[] = [];
  for (const e of events) {
    if (e.type === "parsed") for (const it of e.request.items) labels.set(it.id, it.description || it.query);
    if (e.type === "offers") {
      const list = offers.get(e.itemId) ?? [];
      list.push(...e.offers);
      offers.set(e.itemId, list);
    }
    if (e.type === "picks") picks = e.picks;
  }
  const ids = new Set<string>([...labels.keys(), ...offers.keys()]);
  return [...ids].map((itemId) => {
    const pick = picks.find((p) => p.itemId === itemId);
    const keyOf = (o: Offer) => `${o.store}|${o.url}`;
    const bestKey = pick ? keyOf(pick.offer) : undefined;
    const altKeys = new Set((pick?.alternatives ?? []).map(keyOf));
    // Offers in another currency (currencyMismatch) are listed last: their numbers do not compare.
    const rows = (offers.get(itemId) ?? [])
      .slice()
      .sort((a, b) => Number(!!a.currencyMismatch) - Number(!!b.currencyMismatch) || deliveredCents(a) - deliveredCents(b))
      .map((offer) => ({ offer, best: keyOf(offer) === bestKey, alternative: altKeys.has(keyOf(offer)) }));
    rows.sort((a, b) => Number(b.best) - Number(a.best));
    return { itemId, label: labels.get(itemId) ?? itemId, pick, rows };
  });
}

/** Mask a secret for display: "bk_live_abcd...wxyz" -> "bk_l••••wxyz". Never returns the full key. */
export function maskKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}
