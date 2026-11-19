// What each store's cart would get from the picks, for --dry-run (CLI) and dry_run (MCP).
// Nothing is added to any cart.

import type { Money, Pick, StoreId } from "../core/types.js";

export interface CartPlan {
  store: StoreId;
  storeDomain: string;
  lines: { title: string; quantity: number; price: Money; url: string }[];
  /** Price x quantity of the lines, before shipping and tax. */
  subtotal: Money;
}

export function cartPlan(picks: Pick[], items: { id: string; quantity: number }[]): CartPlan[] {
  const by = new Map<string, CartPlan>();
  for (const pk of picks) {
    if (pk.offer.subscription) continue; // never picked for a cart
    const k = `${pk.offer.store}|${pk.offer.storeDomain}`;
    const qty = items.find((i) => i.id === pk.itemId)?.quantity ?? 1;
    const c = by.get(k) ?? { store: pk.offer.store, storeDomain: pk.offer.storeDomain, lines: [], subtotal: { cents: 0, currency: pk.offer.price.currency } };
    const line = { cents: pk.offer.price.cents * qty, currency: pk.offer.price.currency };
    c.lines.push({ title: pk.offer.title, quantity: qty, price: line, url: pk.offer.url });
    c.subtotal = { cents: c.subtotal.cents + line.cents, currency: c.subtotal.currency };
    by.set(k, c);
  }
  return [...by.values()];
}
