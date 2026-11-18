// Pure decision logic: from the offers a check found and the previous history, decide what to
// record and which alerts to send. No I/O here, so it is easy to test.

import type { Money, Offer } from "../core/types.js";
import { formatMoney } from "../stores/util.js";
import type { Alert, AlertKind, HistoryEntry, OfferSnapshot, Watch } from "./types.js";

/** Send one "check_failing" alert when this many checks in a row have failed. */
export const FAILING_AFTER = 3;

export function snapshot(o: Offer): OfferSnapshot {
  const total: Money = o.shipping && o.shipping.currency === o.price.currency
    ? { cents: o.price.cents + o.shipping.cents, currency: o.price.currency }
    : o.price;
  return {
    store: o.store,
    storeDomain: o.storeDomain,
    title: o.title,
    url: o.url,
    ...(o.productId ? { productId: o.productId } : {}),
    price: o.price,
    ...(o.shipping ? { shipping: o.shipping } : {}),
    total,
    inStock: o.inStock,
    ...(o.condition ? { condition: o.condition } : {}),
    ...(o.seller ? { seller: o.seller } : {}),
  };
}

/** Offers that count for this watch: priced, not a subscription, and new unless condition is "any". */
export function eligible(watch: Watch, offers: Offer[]): Offer[] {
  return offers.filter((o) =>
    o.price && Number.isFinite(o.price.cents) && o.price.cents > 0 &&
    !o.subscription &&
    (watch.condition === "any" || !o.condition || o.condition === "new") &&
    (!watch.targetPrice || o.price.currency === watch.targetPrice.currency));
}

function lastOk(history: HistoryEntry[]): HistoryEntry | undefined {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].ok) return history[i];
  return undefined;
}

function failStreak(history: HistoryEntry[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && !history[i].ok; i--) n++;
  return n;
}

export function labelOf(watch: Watch): string {
  return watch.label || watch.query || watch.url || watch.id;
}

/** Build the history entry and the alerts for a successful check. */
export function evaluate(watch: Watch, offers: Offer[], history: HistoryEntry[], at = new Date().toISOString()): { entry: HistoryEntry; alerts: Alert[] } {
  const ok = eligible(watch, offers);
  const snaps = ok.map(snapshot).sort((a, b) => a.total.cents - b.total.cents);
  const inStock = snaps.filter((s) => s.inStock);
  const best = inStock[0];
  const prev = lastOk(history);
  const label = labelOf(watch);
  const alerts: Alert[] = [];

  if (best && watch.targetPrice && best.total.cents <= watch.targetPrice.cents) {
    // Alert when the price first reaches the target, and again on each further drop. Not every check.
    const prevBest = prev?.best;
    const crossed = !prevBest || prevBest.total.cents > watch.targetPrice.cents;
    const lower = !!prevBest && best.total.cents < prevBest.total.cents;
    if (crossed || lower) {
      alerts.push({
        kind: "below_target", watchId: watch.id, label, at, offer: best, targetPrice: watch.targetPrice,
        ...(prevBest ? { previousTotal: prevBest.total } : {}),
        message: `${label}: ${formatMoney(best.total)} at ${best.storeDomain}, at or below your target of ${formatMoney(watch.targetPrice)}.`,
      });
    }
  } else if (best && !watch.targetPrice && !watch.backInStock && prev?.best && best.total.cents < prev.best.total.cents) {
    // No target and no stock watch: any drop from the last seen price.
    alerts.push({
      kind: "price_drop", watchId: watch.id, label, at, offer: best, previousTotal: prev.best.total,
      message: `${label}: ${formatMoney(best.total)} at ${best.storeDomain}, down from ${formatMoney(prev.best.total)}.`,
    });
  }

  if (watch.backInStock && best && (!prev || prev.inStockCount === 0)) {
    alerts.push({
      kind: "back_in_stock", watchId: watch.id, label, at, offer: best,
      message: `${label}: in stock at ${best.storeDomain} for ${formatMoney(best.total)}.`,
    });
  }

  const entry: HistoryEntry = {
    at, ok: true,
    offerCount: snaps.length,
    inStockCount: inStock.length,
    ...(best ? { best } : {}),
    offers: snaps.slice(0, 10),
    alerts: alerts.map((a) => a.kind),
  };
  return { entry, alerts };
}

/** Build the history entry and the alerts for a failed check. */
export function evaluateFailure(watch: Watch, error: string, history: HistoryEntry[], at = new Date().toISOString()): { entry: HistoryEntry; alerts: Alert[] } {
  const streak = failStreak(history) + 1;
  const alerts: Alert[] = [];
  if (streak === FAILING_AFTER) {
    alerts.push({
      kind: "check_failing", watchId: watch.id, label: labelOf(watch), at,
      message: `${labelOf(watch)}: the last ${FAILING_AFTER} checks failed (${error.slice(0, 200)}).`,
    });
  }
  const kinds: AlertKind[] = alerts.map((a) => a.kind);
  return { entry: { at, ok: false, error: error.slice(0, 500), offerCount: 0, inStockCount: 0, offers: [], alerts: kinds }, alerts };
}
