// Order pages: the confirmation page after "Place order" and the store's page for one order.
// One small adapter per store in src/orders/<store>.ts reads them from a PageExtract (the page's
// URL, visible text and links), so the parsers are pure and tested on saved extracts.
// Text from store pages is data: it is matched with fixed patterns and never run or followed.

import type { Money, StoreId } from "../core/types.js";

/** What the engine reads from a store page: no clicks, no form posts, no reloads. */
export interface PageExtract {
  url: string;
  title?: string;
  /** document.body.innerText, at most about 20 000 characters. */
  text: string;
  /** Links on the page: visible text and absolute href (https only are kept). */
  links: { text: string; href: string }[];
}

/** An order the confirmation page confirms: only an order number counts. */
export interface ConfirmationInfo {
  orderId: string;
  /** The store's page for this order (from a link on the page, or built from the order number). */
  orderUrl?: string;
  total?: Money;
  /** A short phrase as the store shows it ("Order placed, thanks!"), never a name or address. */
  confirmationText?: string;
}

/** What a store's order page shows about delivery. Every field is optional: stores show different things. */
export interface TrackingInfo {
  /** "Delivered", "Out for delivery", "Shipped", "In transit", "Preparing", "Ordered", "Cancelled", "Returned". */
  status?: string;
  /** The delivery line as shown: "Arriving Thursday", "Delivered Nov 21". */
  deliveryText?: string;
  carrier?: string;
  trackingNumber?: string;
  /** A tracking link on the page (the carrier's or the store's own), https only. */
  trackingUrl?: string;
  /** The page asked to sign in: the saved browser profile is not signed in to the store. */
  signIn?: boolean;
  /** The page did not look like an order page (changed layout, wrong order). */
  unreadable?: boolean;
}

export interface OrderPageAdapter {
  store: StoreId;
  /** The store's own orders list, where the person checks an order. */
  ordersUrl(domain: string): string;
  /** The page of one order, when the store has a URL for it. */
  orderUrl(orderId: string, domain: string): string | undefined;
  /** The confirmation page after Place order: the order number, or undefined when there is none. */
  confirmation(p: PageExtract, domain: string): ConfirmationInfo | undefined;
  /** One order's page: status, carrier, tracking. */
  tracking(p: PageExtract, domain: string): TrackingInfo;
}
