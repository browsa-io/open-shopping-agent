// The store adapter contract: one file per store in src/stores/<id>.ts, registered in
// src/stores/index.ts. An adapter knows one store's pages. The engine (src/core) decides what to
// buy, enforces the limits and asks for approval; an adapter never decides on its own to pay.

import type { Page } from "playwright-core";
import type {
  Approval, Cart, CheckoutReview, ItemRequest, Money, NeedsUser, Offer, OrderResult, StoreId,
} from "../core/types.js";
import type { BrowserCapabilities } from "../core/providers/types.js";

/** What the engine hands an adapter for one store in one run. */
export interface StoreContext {
  store: StoreId;
  domain: string;                     // "amazon.com", or the Shopify shop domain
  zip?: string;
  /** The store's Phantom browser page (Playwright over CDP on a Browsa browser). */
  page: Page;
  /** Browsa agent id of this store's browser profile (cookies, carts and logins persist). */
  agentId: string;
  /**
   * AI fallback: run a Browsa agent task and return its JSON result. Use it only when the direct
   * code path failed (layout change, unexpected dialog). It costs more credits and time, so
   * adapters call it at most once per stage.
   *
   * Where it runs: on a saved profile (persistent) the task uses the same profile, so it sees the
   * same cookies and cart; in session mode it runs on the very same browser. On a fresh (burner)
   * browser it is a standalone task in its own browser that starts at `startUrl` or the current
   * page URL: its cookies and cart are separate from ours. Set `sameBrowser: true` for tasks that
   * must act on this browser's page or cart (add to cart, choose an option); on a fresh browser
   * those fail at once without spending credits.
   */
  aiTask<T = unknown>(task: string, opts?: { schema?: object; maxSteps?: number; startUrl?: string; sameBrowser?: boolean }): Promise<T>;
  /** A Phantom Live link with control, for handing the browser to the person. Opens once. */
  liveLink(): Promise<string>;
  /**
   * Replace a crashed, closed or frozen tab: open a fresh page in the same browser context (same
   * cookies and cart), close the old one, set `ctx.page` and return it. The new page is blank.
   * Added in v1 hardening; adapters use it through util's replacePage().
   */
  newPage(): Promise<Page>;
  log(message: string): void;
  signal: AbortSignal;
  /**
   * What this browser can do (added with browser providers). Unset on Phantom on Browsa, which has
   * every capability. On your own Chrome or a CDP browser: no captcha solving, and aiTask throws
   * CapabilityMissing without a model key.
   */
  capabilities?: BrowserCapabilities;
}

export interface StoreAdapter {
  id: StoreId;
  name: string;                       // "Amazon"
  /** Domains this adapter serves; "*" for the generic Shopify adapter. */
  domains: string[];
  /** Search URL for a query; used by search() and shown in run history. */
  searchUrl(query: string, domain: string): string;

  /** Search one item; return up to `limit` offers, sponsored and subscription offers flagged. */
  search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]>;

  /** Optional: open the product page and fill price, shipping, delivery, variants, seller. */
  details?(ctx: StoreContext, offer: Offer): Promise<Offer>;

  /**
   * Choose the item's options (colour, size, length), choose one-time purchase over subscription,
   * add `quantity` to the cart, then read the cart back. Must report a warning in the returned
   * cart when an option did not stick.
   */
  addToCart(ctx: StoreContext, offer: Offer, quantity: number, options?: Record<string, string>): Promise<Cart>;

  /** Read the cart as the store shows it now. */
  readCart(ctx: StoreContext): Promise<Cart>;

  /** Remove everything this run added (used by tests and by "clear cart"). */
  clearCart?(ctx: StoreContext): Promise<void>;

  /**
   * Go to checkout and stop on the order review page, before the final "Place order" click.
   * Decline membership and trial offers. If the store needs the person (sign-in, code, 3-D Secure,
   * address, payment), return a review with `needsUser` set and a live link instead of guessing.
   */
  reviewCheckout(ctx: StoreContext): Promise<CheckoutReview>;

  /**
   * Click "Place order" only if the review total still equals approval.approvedTotal (re-read it
   * first). Read the confirmation page back. The engine calls this only with the user's approval.
   * When the total changed, return `{ placed: false, error: "..." }` without clicking (do not throw).
   */
  placeOrder(ctx: StoreContext, approval: Approval): Promise<OrderResult>;
}

/** Helpers every adapter uses; implemented in src/stores/util.ts. */
export interface AdapterUtil {
  parseMoney(text: string, currency?: string): Money | undefined;
  needsUser(ctx: StoreContext, reason: NeedsUser["reason"], message: string): Promise<NeedsUser>;
}
