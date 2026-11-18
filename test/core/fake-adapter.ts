// An offline store adapter and browser for engine tests. No network, no Playwright.

import { writeFile } from "node:fs/promises";
import type { Page } from "playwright-core";
import type { Approval, Cart, CartLine, CheckoutReview, ItemRequest, Money, Offer, OrderResult, StoreId } from "../../src/core/types.js";
import type { StoreAdapter, StoreContext } from "../../src/stores/adapter.js";
import type { StoreBrowser } from "../../src/core/browsers.js";

export const usd = (dollars: number): Money => ({ cents: Math.round(dollars * 100), currency: "USD" });

export function offer(store: StoreId, title: string, price: number, extra: Partial<Offer> = {}): Offer {
  return {
    store, storeDomain: `${store}.com`, itemId: "", title, url: `https://${store}.com/p/${encodeURIComponent(title)}`,
    price: usd(price), inStock: true, shipping: usd(0), rating: { stars: 4.5, count: 500 }, ...extra,
  };
}

export interface FakeOptions {
  /** Offers by a word in the query ("cable" -> offers). */
  catalog: Record<string, Offer[]>;
  searchDelayMs?: number;
  failSearch?: boolean;
  failCart?: boolean;
  /** Extra added to the checkout total (tax), so tests can check the approval total. */
  taxCents?: number;
  needsSignIn?: boolean;
  /** Price change between review and placing: placeOrder sees a different total. */
  priceJumpCents?: number;
  /** A line added at checkout, like a membership upsell. */
  extraReviewLine?: CartLine;
}

export class FakeAdapter implements StoreAdapter {
  name: string;
  domains: string[];
  cart: CartLine[] = [];
  calls = { search: 0, addToCart: 0, reviewCheckout: 0, placeOrder: 0, details: 0 };
  placed: Approval[] = [];

  constructor(public id: StoreId, public o: FakeOptions) {
    this.name = id;
    this.domains = [`${id}.com`];
  }

  searchUrl(q: string, domain: string): string {
    return `https://${domain}/s?q=${encodeURIComponent(q)}`;
  }

  async search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
    this.calls.search++;
    if (this.o.searchDelayMs) await new Promise((r) => setTimeout(r, this.o.searchDelayMs));
    if (this.o.failSearch) throw new Error(`${this.id} search page changed`);
    const key = Object.keys(this.o.catalog).find((k) => item.query.toLowerCase().includes(k));
    ctx.log(`searched ${item.query}`);
    return (key ? this.o.catalog[key] : []).slice(0, limit).map((o) => ({ ...o, itemId: item.id }));
  }

  async addToCart(_ctx: StoreContext, o: Offer, quantity: number, options?: Record<string, string>): Promise<Cart> {
    this.calls.addToCart++;
    if (this.o.failCart) throw new Error("add to cart button missing");
    this.cart.push({ title: o.title, quantity, price: { cents: o.price.cents * quantity, currency: o.price.currency }, options, url: o.url });
    return this.readCart();
  }

  async readCart(): Promise<Cart> {
    const subtotal = this.cart.reduce((s, l) => s + l.price.cents, 0);
    return { store: this.id, storeDomain: `${this.id}.com`, lines: [...this.cart], subtotal: usd(subtotal / 100), readAt: new Date().toISOString(), warnings: [] };
  }

  async reviewCheckout(ctx: StoreContext): Promise<CheckoutReview> {
    this.calls.reviewCheckout++;
    const lines = [...this.cart, ...(this.o.extraReviewLine ? [this.o.extraReviewLine] : [])];
    const subtotal = lines.reduce((s, l) => s + l.price.cents, 0);
    const tax = this.o.taxCents ?? 0;
    const review: CheckoutReview = {
      store: this.id, storeDomain: `${this.id}.com`, lines, subtotal: { cents: subtotal, currency: "USD" },
      shipping: usd(0), tax: { cents: tax, currency: "USD" }, total: { cents: subtotal + tax, currency: "USD" },
      shipTo: "Cheyenne, WY 82001", reviewedAt: new Date().toISOString(),
    };
    if (this.o.needsSignIn) review.needsUser = { reason: "sign_in", message: `${this.id} asks you to sign in`, liveUrl: await ctx.liveLink() };
    return review;
  }

  async placeOrder(_ctx: StoreContext, approval: Approval): Promise<OrderResult> {
    this.calls.placeOrder++;
    // A real adapter re-reads the total and refuses on a mismatch; the fake does the same.
    const subtotal = this.cart.reduce((s, l) => s + l.price.cents, 0) + (this.o.taxCents ?? 0) + (this.o.priceJumpCents ?? 0);
    if (subtotal !== approval.approvedTotal.cents) return { store: this.id, placed: false, confirmationText: "total changed" };
    this.placed.push(approval);
    return { store: this.id, placed: true, orderId: `FAKE-${this.placed.length}`, total: { cents: subtotal, currency: "USD" }, placedAt: new Date().toISOString() };
  }
}

/** A detail-capable fake: details() fills shipping. */
export class FakeDetailAdapter extends FakeAdapter {
  async details(_ctx: StoreContext, o: Offer): Promise<Offer> {
    this.calls.details++;
    return { ...o, shipping: usd(4.99), deliveryText: "Arrives Fri" };
  }
}

export interface FakeBrowserLog {
  opened: { store: StoreId; domain: string }[];
  closed: StoreId[];
}

/** openBrowser for ShoppingAgentOptions: a fake page whose screenshot writes a tiny file. */
export function fakeBrowsers(log: FakeBrowserLog = { opened: [], closed: [] }, failStores: StoreId[] = []) {
  const open = async (store: StoreId, domain: string, spend: (n: number, what: string) => Promise<number>): Promise<StoreBrowser> => {
    if (failStores.includes(store)) throw new Error(`${store} browser failed to start`);
    await spend(5, `${store} browser`);
    log.opened.push({ store, domain });
    const page = {
      url: () => `https://${domain}/`,
      screenshot: async ({ path }: { path: string }) => { await writeFile(path, "png"); return Buffer.from("png"); },
      isClosed: () => false,
    } as unknown as Page;
    return {
      store, agentId: `agt_fake_${store}`, mode: "burner", page,
      context(dom, extra): StoreContext {
        return {
          store, domain: dom, zip: extra.zip, page, agentId: `agt_fake_${store}`, signal: extra.signal,
          log: extra.log ?? (() => {}),
          aiTask: async () => { throw new Error("no AI in tests"); },
          liveLink: async () => `https://browsa.io/live?agent=agt_fake_${store}#c=secretcode`,
          newPage: async () => page,
        } as StoreContext;
      },
      async close() { log.closed.push(store); },
    };
  };
  return { open, log };
}
