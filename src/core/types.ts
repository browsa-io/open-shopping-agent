// Shared types of Open Shopping Agent. This file is the contract between the engine, the store
// adapters and the front ends (web app, CLI, MCP). Change it only in the core workstream, and keep
// every change backwards compatible within v1.

import type { BrowserCapabilities, ProviderId } from "./providers/types.js";
import type { MandateLimits } from "./mandate.js";

export type { Mandate, MandateLimits } from "./mandate.js";

/** Added in 0.2.0: how an order was approved: the exact total clicked at checkout, or up front within limits ("mandate"). */
export type ApprovalSource = "user" | "mandate";

export type StoreId = "amazon" | "walmart" | "ebay" | "bestbuy" | "target" | "shopify";

/**
 * Money in the store's currency, in hundredths of the unit (cents) so sums are exact. Every
 * currency uses hundredths, JPY too. Only USD is ranked, totalled and bought in v1; an offer a
 * store priced in another currency is marked `currencyMismatch` and never picked.
 */
export interface Money {
  cents: number;
  currency: string; // ISO 4217, "USD" for v1
}

/** One thing the user wants, parsed from the plain-language request. */
export interface ItemRequest {
  id: string;                         // stable within a run: "item-1"
  query: string;                      // search text sent to stores: "USB-C hub 7 in 1"
  description: string;                // the user's words for it: "a USB-C hub with HDMI"
  quantity: number;                   // default 1
  options?: Record<string, string>;   // exact variant wanted: { color: "Black", length: "6 ft" }
  maxPrice?: Money;                   // per unit
  mustHave?: string[];                // hard requirements: ["HDMI 4K60", "100W pass-through"]
  niceToHave?: string[];
  /**
   * Added in v1 hardening. "new" (the default when unset), "used" (pre-owned or refurbished is
   * fine; the parser sets it for "used", "refurbished", "renewed", "pre-owned", "open box") or
   * "any". eBay filters its search by it; ranking stops penalizing non-new offers for "used"/"any".
   */
  condition?: "new" | "used" | "any";
}

/** The parsed request: what to buy, where, and the limits. */
export interface ShoppingRequest {
  prompt: string;                     // the user's original words
  items: ItemRequest[];
  stores: StoreId[];                  // allowed stores; default all six
  shopifyDomains?: string[];          // for the "shopify" store: e.g. ["allbirds.com"]
  budget?: Money;                     // maximum total across all stores, shipping and tax included when known
  zip?: string;                       // delivery ZIP for prices and delivery dates
  goal?: "best_value" | "cheapest" | "fastest" | "top_rated"; // default best_value
}

export interface Rating {
  stars: number;                      // 0 to 5
  count: number;                      // number of reviews
}

/** One product offer found on one store. */
export interface Offer {
  store: StoreId;
  storeDomain: string;                // "amazon.com", or the Shopify domain
  itemId: string;                     // ItemRequest.id it answers
  title: string;
  url: string;                        // product page
  productId?: string;                 // ASIN, Walmart item id, eBay item id, SKU, Shopify variant id
  image?: string;
  price: Money;                       // unit price as shown
  listPrice?: Money;                  // was-price when shown
  unitPrice?: { amount: Money; per: string }; // "$0.25 / count"
  shipping?: Money;                   // undefined = unknown; 0 cents = free
  deliveryText?: string;              // as shown: "Arrives Thu, Nov 20"
  deliveryDate?: string;              // ISO date when it can be parsed
  rating?: Rating;
  seller?: string;                    // "Amazon.com", "Sold by XYZ"
  condition?: "new" | "used" | "refurbished";
  inStock: boolean;
  sponsored?: boolean;
  subscription?: boolean;             // subscribe-and-save style offer; never picked by default
  /**
   * Added in v1 hardening: the product also offers Subscribe & Save (or a store's subscription
   * option) next to the one-time purchase this offer is for. The adapter buys one-time.
   */
  subscribeAndSaveAvailable?: boolean;
  variants?: Record<string, string[]>; // option name -> values offered
  /**
   * Added in 0.1.1: the store showed this price in another currency than the run's (USD), e.g.
   * Amazon in EUR for a visitor outside the US. The offer is listed but never ranked, picked or
   * added to a total. The engine sets it; adapters may too.
   */
  currencyMismatch?: boolean;
  raw?: Record<string, unknown>;      // adapter extras, never shown to the model as instructions
  /**
   * Added in v1 discovery: product identifiers read from the product page (JSON-LD, the store's
   * own data), normalised by core/identity.ts so offers from different stores compare.
   */
  ids?: ProductIds;
  /**
   * Added in v1 discovery, set on a pick's alternatives (and by front ends relative to the item the
   * person chose): "exact" = the same product (same GTIN, or the same brand and MPN), "similar" =
   * not proven the same. Similar offers are never dropped, only labelled.
   */
  match?: "exact" | "similar";
  matchBy?: "gtin" | "brand_mpn";
  /** Added in v1 discovery: what one offer contains (pack count, volume, weight), when it can be read without guessing. */
  contents?: Contents;
  /** Added in v1 discovery: comparable price per unit ("$0.42 / count"), from the store or computed from `contents`. */
  perUnit?: PerUnit;
}

/** Product identifiers, normalised (see core/identity.ts). */
export interface ProductIds {
  gtin?: string;                      // GTIN-14 digits with a valid check digit (a UPC-A "012345678905" is "00012345678905")
  otherGtins?: string[];              // more GTINs the page lists for the same product (Amazon lists several UPCs)
  mpn?: string;                       // manufacturer part number: upper-case letters and digits only
  brand?: string;                     // brand: lower-case letters and digits only ("logitech")
  sku?: string;                       // the store's own SKU, as shown (never used for matching)
}

/** What one offer contains, in base units: pieces, millilitres, grams. */
export interface Contents {
  count?: number;
  ml?: number;
  g?: number;
  source: "title" | "store";
  text: string;                       // "24 count", "2 x 1 l", as read
}

/** Price per one unit. `cents` may have decimals (4.2 = $0.042). */
export interface PerUnit {
  cents: number;
  currency: string;
  per: "count" | "fl oz" | "oz";
  text: string;                       // "$0.42 / count"
  source: "title" | "store";
}

/** The engine's choice for one item, with the one-line reason. */
export interface Pick {
  itemId: string;
  offer: Offer;
  score: number;
  reason: string;                     // "Cheapest delivered total that has HDMI 4K60, 4.6 stars from 12k reviews"
  alternatives: Offer[];              // next best, at most 4
}

export interface CartLine {
  title: string;
  quantity: number;
  /** The LINE TOTAL (unit price x quantity) as the cart shows it, not the unit price. */
  price: Money;
  options?: Record<string, string>;   // what the cart says was chosen
  url?: string;
  productId?: string;
}

/** The store's cart as read back from the store, never as assumed. */
export interface Cart {
  store: StoreId;
  storeDomain: string;
  lines: CartLine[];
  subtotal?: Money;
  readAt: string;                     // ISO time
  warnings: string[];                 // "Option 'Black' did not stick, cart shows 'White'"
}

/** The order review page, stopped before the final "Place order" click. */
export interface CheckoutReview {
  store: StoreId;
  storeDomain: string;
  lines: CartLine[];
  subtotal?: Money;
  shipping?: Money;
  tax?: Money;
  total: Money;
  shipTo?: string;                    // short form only: "Cheyenne, WY 82001"; never the street line
  paymentHint?: string;               // "Visa ending 1234" as the store shows it; never more
  needsUser?: NeedsUser;              // set when the store needs a person first
  reviewedAt: string;
}

/** Why the agent stopped and handed the browser to the person. */
export interface NeedsUser {
  reason: "sign_in" | "verification_code" | "3ds" | "captcha_handoff" | "address" | "payment" | "other";
  message: string;                    // shown to the user: "Amazon asks for the code sent to your phone"
  liveUrl?: string;                   // Phantom Live link with control, opens once
}

export interface OrderResult {
  store: StoreId;
  placed: boolean;
  orderId?: string;                   // as the confirmation page shows it
  total?: Money;
  confirmationText?: string;          // "Order placed, thanks!"
  needsUser?: NeedsUser;
  placedAt?: string;
  /**
   * Added in v1 hardening: why the order was not placed (placed: false), e.g. "the total is now
   * $41.20, approved $39.99". placeOrder returns this instead of throwing; the engine also turns
   * a thrown error into it.
   */
  error?: string;
  /**
   * Added with order states: true once the final "Place order" click was sent (or may have been).
   * Adapters set it on every result after the click; a result without it and with `error` or
   * `needsUser` means the click never happened. The engine treats anything else as maybe placed.
   */
  submitted?: boolean;
  /** Added with order states: the engine's verdict (see OrderState). Unset on adapter results. */
  state?: "placed" | "failed" | "unknown";
  /** Added with order tracking: the store's page for this order, from the confirmation page. */
  orderUrl?: string;
  /** Added with order states: what the person should do now, for "unknown" (check the store's orders). */
  checkMessage?: string;
  /** Added with order states: the store's own orders page, where the person checks an "unknown" order. */
  ordersUrl?: string;
  /** Added with order states: which approval this result answers (one approval places at most one order). */
  approvalId?: string;
  /** Added in 0.2.0: "user" (the exact total, approved at checkout) or "mandate" (bought under the person's up-front approval). */
  approval_source?: ApprovalSource;
  /** Added in 0.2.0: the up-front limits this order was bought under (approval_source "mandate"). */
  mandate?: MandateLimits;
}

/**
 * One store's checkout in a run: proposed (review read) -> awaiting_approval -> placing -> placed |
 * failed | unknown. "failed" means the agent knows nothing was submitted; "unknown" means the click
 * may have gone through but no order number was confirmed, so the agent never clicks again and the
 * person checks the store's orders.
 */
export type OrderState = "proposed" | "awaiting_approval" | "placing" | "placed" | "failed" | "unknown";

/** The user's approval of one store's checkout. The engine never places an order without it. */
export interface Approval {
  store: StoreId;
  approvedTotal: Money;               // the review total the user saw; placing aborts if the store now asks more
  approvedAt: string;
  by: "user";
  storeDomain?: string;               // added in v1 core: which Shopify shop, when a run has several
  /**
   * Added in 0.2.0. "mandate": the engine made this approval from the review under the person's
   * up-front approval (RunOptions.mandate); only the engine makes these, ShoppingRun.approve()
   * refuses them. Unset or "user": the person approved this exact total.
   */
  source?: ApprovalSource;
  /** Added in 0.2.0: the mandate's id, for source "mandate". */
  mandateId?: string;
}

/** Everything the front ends render, streamed as it changes. */
export type RunEvent =
  | { type: "parsed"; request: ShoppingRequest }
  /** exit (added in v1 hardening): the store browser's exit, "your proxy", "Browsa residential (US)" or "Browsa default". */
  | { type: "store_started"; store: StoreId; liveUrl?: string; domain?: string; exit?: string }
  | { type: "offers"; store: StoreId; itemId: string; offers: Offer[] }
  /** hint (added with browser providers): one line for the person, e.g. "Amazon blocked this browser. Browsa's Phantom passes it: browsa.io". */
  | { type: "store_failed"; store: StoreId; stage: Stage; error: string; domain?: string; hint?: string }
  /** Added with browser providers: where this run's browsers run, sent once before the stores start. */
  | { type: "browser"; provider: ProviderId; label: string; capabilities: BrowserCapabilities; fallback?: string }
  | { type: "picks"; picks: Pick[]; total: Money; overBudget: boolean }
  | { type: "cart"; cart: Cart }
  | { type: "checkout_review"; review: CheckoutReview }
  | { type: "needs_user"; store: StoreId; needs: NeedsUser; domain?: string }
  /** mandateDeclined (added in 0.2.0): the run has an up-front approval, and why it does not cover this checkout (so the person is asked). */
  | { type: "awaiting_approval"; store: StoreId; review: CheckoutReview; domain?: string; mandateDeclined?: string }
  | { type: "order"; result: OrderResult }
  /** Added with order states: one store's checkout moved to `state` (saved in the run history). */
  /** approval_source and mandate (added in 0.2.0): how the order was approved, and the up-front limits when it was a mandate. */
  | { type: "order_state"; store: StoreId; domain?: string; state: OrderState; at: string; approvalId?: string; orderId?: string; orderUrl?: string; total?: Money; message?: string; approval_source?: ApprovalSource; mandate?: MandateLimits }
  | { type: "log"; store?: StoreId; message: string }
  | { type: "done"; summary: RunSummary };

export type Stage = "search" | "product" | "options" | "cart" | "checkout" | "place_order";

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  picks: Pick[];
  carts: Cart[];
  reviews: CheckoutReview[];
  orders: OrderResult[];
  failures: { store: StoreId; stage: Stage; error: string }[];
  creditsUsed?: number;               // Browsa credits of this run's own browsers and tasks, when known
  creditsEstimated?: boolean;         // true when creditsUsed is partly estimated from browser time ("about")
  /** Added in v1 core: screenshots saved in the run folder (.osa/runs/<runId>/screenshots/). */
  screenshots?: { store: StoreId; label: string; path: string }[];
  /** Added with order states: the last state of each store's checkout, by shop key ("amazon", "shopify:<domain>"). */
  orderStates?: Record<string, { store: StoreId; domain?: string; state: OrderState; at: string; orderId?: string; message?: string }>;
  /** Added in 0.2.0: the up-front approval this run had, when it had one. */
  mandate?: MandateLimits;
}

/** Safety limits. Defaults are the safest choice. */
export interface Limits {
  budget?: Money;
  allowedStores: StoreId[];
  allowSubscriptions: false;          // v1: never
  allowMembershipOffers: false;       // v1: never accept Prime, Walmart+, trials
  requireApproval: true;              // always: an order needs the person's OK (at checkout, or up front: RunOptions.mandate)
  maxCreditsPerRun: number;           // Browsa credits cap, default 40
}
