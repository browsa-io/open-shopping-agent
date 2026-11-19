// The person's plan (swap a pick, change a quantity, skip an item) applied to a run's picks.
// Shared by RealEngine and MockEngine so both treat a plan the same way.

import type { Money, Offer, Pick, ShoppingRequest } from "../core/types.js";
import type { PlanChoice } from "./engine-port.js";

export const offerKey = (o: Pick["offer"]) => `${o.store}|${o.url}`;

export interface AppliedPlan {
  picks: Pick[];
  quantities: Map<string, number>;
  total: Money;
  overBudget: boolean;
}

/** Validate a plan body from the network. Throws with a plain message. */
export function parseChoices(v: unknown): PlanChoice[] {
  if (!Array.isArray(v) || v.length > 20) throw new Error("plan must be a list of up to 20 items");
  return v.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    if (typeof o.itemId !== "string" || !o.itemId || o.itemId.length > 64) throw new Error("each plan item needs an itemId");
    const out: PlanChoice = { itemId: o.itemId };
    if (typeof o.offerKey === "string" && o.offerKey.length <= 2100) out.offerKey = o.offerKey;
    if (o.quantity !== undefined) {
      const q = Number(o.quantity);
      if (!Number.isInteger(q) || q < 1 || q > 99) throw new Error("quantity must be 1 to 99");
      out.quantity = q;
    }
    if (o.skip === true) out.skip = true;
    return out;
  });
}

/**
 * New picks from the choices. Items without a choice keep their pick. A swapped offer must be one
 * of this run's offers for that item and in stock; the engine's alternatives are kept (minus the
 * new pick) so the person can swap again.
 */
export function applyChoices(request: ShoppingRequest, picks: Pick[], offers: Offer[], choices: PlanChoice[], budget?: Money): AppliedPlan {
  const quantities = new Map<string, number>();
  const next: Pick[] = [];
  for (const item of request.items) {
    const c = choices.find((x) => x.itemId === item.id);
    const old = picks.find((p) => p.itemId === item.id);
    const qty = c?.quantity ?? item.quantity ?? 1;
    quantities.set(item.id, qty);
    if (c?.skip) continue;
    if (!c?.offerKey || (old && offerKey(old.offer) === c.offerKey)) {
      if (old) next.push(old);
      continue;
    }
    const offer = offers.find((o) => o.itemId === item.id && offerKey(o) === c.offerKey);
    if (!offer) throw new Error(`That offer is not in this run (${item.description || item.query})`);
    if (!offer.inStock) throw new Error(`That offer is out of stock: ${offer.title.slice(0, 60)}`);
    if (offer.subscription) throw new Error("Subscription offers are never bought");
    if (offer.currencyMismatch || offer.price.currency !== (budget?.currency ?? "USD")) throw new Error(`That offer is priced in ${offer.price.currency}, not US dollars; it cannot be compared or bought`);
    const alternatives = [...(old ? [old.offer] : []), ...(old?.alternatives ?? [])].filter((o) => offerKey(o) !== c.offerKey).slice(0, 4);
    next.push({ itemId: item.id, offer, score: 0, reason: "Your choice", alternatives });
  }
  const currency = budget?.currency ?? "USD";
  let cents = 0;
  for (const p of next) {
    const q = quantities.get(p.itemId) ?? 1;
    const ship = p.offer.shipping && p.offer.shipping.currency === p.offer.price.currency ? p.offer.shipping.cents : 0;
    cents += p.offer.price.cents * q + ship;
  }
  return { picks: next, quantities, total: { cents, currency }, overBudget: !!budget && cents > budget.cents };
}
