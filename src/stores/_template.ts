// Template: add a store in one file.
//
// 1. Copy this file to src/stores/<store>.ts and rename `exampleStore`.
// 2. Add the store id to `StoreId` in src/core/types.ts (core workstream) and register the
//    adapter in src/stores/index.ts.
// 3. Save trimmed fixtures (search answer, product answer, cart answer) in
//    test/fixtures/<store>/ and test the pure parsers on them; live tests are opt-in (OSA_LIVE=1).
//
// How the good adapters work, in order of preference:
//   a) The store's own JSON. Most stores load search results, products and the cart from JSON
//      APIs. Call them with fetch() inside the store's page (ctx.page.evaluate), so cookies and
//      bot check tokens go with the call. See target.ts (redsky API) and shopify.ts (/cart.js).
//   b) JSON embedded in the page (__NEXT_DATA__, application/ld+json, window.__STATE__).
//   c) Stable selectors: ids, data-test / data-testid attributes, aria roles and labels.
//      Avoid generated CSS class names; they change every deploy.
//   d) ctx.aiTask(): a Browsa agent task on the same browser profile. Slow and costs credits:
//      at most once per stage, only after a), b) and c) failed.
//
// Rules: never sign in to an account, never type card or address details, never click the final
// "Place order" outside placeOrder(), and placeOrder() aborts unless the total still equals the
// approved total. When the store needs the person, return `needsUser` with a live link.
// Name the browser "Phantom" in any text a person reads.

import type { Approval, Cart, CheckoutReview, ItemRequest, Offer, OrderResult } from "../core/types.js";
import type { StoreAdapter, StoreContext } from "./adapter.js";
import { needsUser, nowIso, parseMoney } from "./util.js";

const ORIGIN = "https://www.example.com";

/**
 * Keep parsing in pure functions like this one: they take the store's JSON (or text pulled out of
 * the page) and return contract types, so unit tests can run them on saved fixtures without a browser.
 */
export function parseExampleSearch(json: Record<string, any>, itemId: string, limit: number): Offer[] {
  return (json.results ?? []).slice(0, limit).flatMap((r: Record<string, any>): Offer[] => {
    const price = parseMoney(r.priceText); // "$12.99" -> { cents: 1299, currency: "USD" }
    if (!price || !r.title) return [];
    return [{
      store: "amazon", // replace with your StoreId once it is added to types.ts
      storeDomain: "example.com",
      itemId,
      title: r.title,
      url: new URL(r.url, ORIGIN).toString(),
      productId: r.sku,
      price,
      inStock: r.inStock !== false,
      sponsored: r.sponsored === true, // flag ads; the engine ranks them down
      subscription: false, // flag subscribe-and-save offers; the engine never picks them by default
    }];
  });
}

export const exampleStore: StoreAdapter = {
  id: "amazon", // replace with your StoreId
  name: "Example Store",
  domains: ["example.com", "www.example.com"],

  searchUrl(query: string): string {
    return `${ORIGIN}/search?q=${encodeURIComponent(query)}`;
  },

  async search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
    // Hint: open the store once so cookies exist, then call its search API from the page:
    //   await ctx.page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    //   const json = await ctx.page.evaluate(async (q) => (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json(), item.query);
    //   return parseExampleSearch(json, item.id, limit);
    // If the store shows a bot check, wait for Phantom to pass it, retry once, then throw a clear error.
    void ctx; void item; void limit;
    throw new Error("example store: search() not implemented");
  },

  async details(ctx: StoreContext, offer: Offer): Promise<Offer> {
    // Hint: fetch the product's JSON, fill price, listPrice, shipping, deliveryText, rating,
    // seller and `variants` (option name -> values offered). Return a new object.
    void ctx;
    return { ...offer };
  },

  async addToCart(ctx: StoreContext, offer: Offer, quantity: number, options?: Record<string, string>): Promise<Cart> {
    // Hint: resolve the variant for `options`, choose one-time purchase (never a subscription),
    // add `quantity`, then read the cart back with readCart() and push a warning for every option
    // or quantity that did not stick: "Option 'Black' did not stick, cart shows 'White'".
    void ctx; void offer; void quantity; void options;
    throw new Error("example store: addToCart() not implemented");
  },

  async readCart(ctx: StoreContext): Promise<Cart> {
    // Hint: read the cart as the store shows it (its cart JSON or the cart page), never as assumed.
    void ctx;
    return { store: "amazon", storeDomain: "example.com", lines: [], readAt: nowIso(), warnings: [] };
  },

  async clearCart(ctx: StoreContext): Promise<void> {
    // Hint: remove every line (used by tests and "clear cart").
    void ctx;
  },

  async reviewCheckout(ctx: StoreContext): Promise<CheckoutReview> {
    // Hint: go to checkout and stop on the review page. Decline memberships and trials. Read the
    // subtotal, shipping, tax and total. shipTo is "City, ST 12345" only; paymentHint is "Visa
    // ending 1234" at most. If the store asks for sign-in, a code, an address or payment, return
    // the review with needsUser set instead of guessing:
    const nu = await needsUser(ctx, "sign_in", "Example Store asks you to sign in. Sign in in the live browser, then continue.");
    return { store: "amazon", storeDomain: "example.com", lines: [], total: { cents: 0, currency: "USD" }, needsUser: nu, reviewedAt: nowIso() };
  },

  async placeOrder(ctx: StoreContext, approval: Approval): Promise<OrderResult> {
    // Hint: re-read the total first; if it differs from approval.approvedTotal by even one cent,
    // return { placed: false, error } with the new total. Only then click "Place order" and read the
    // confirmation page (order id as shown). Every result after the click has submitted: true.
    // Also add src/orders/<store>.ts so the engine can read the confirmation and order pages.
    void ctx; void approval;
    return { store: "amazon", placed: false, error: "example store: placeOrder() not implemented" };
  },
};

export default exampleStore;
