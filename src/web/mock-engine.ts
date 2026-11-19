// MockEngine: replays a made-up but plausible run so the surfaces can be built and tested without
// a Browsa key. DEMO DATA ONLY: product names, brands, sellers, prices, ratings and order numbers
// are invented. No real people, no real stores are contacted, no credits are spent.

import type {
  Approval, Cart, CartLine, CheckoutReview, ItemRequest, Money, Offer, OrderResult, OrderState, Pick, ProductIds, RunEvent,
  RunSummary, ShoppingRequest, Stage, StoreId,
} from "../core/types.js";
import { labelSameItem } from "../core/identity.js";
import { withUnits } from "../core/units.js";
import type { EnginePort, PlanChoice, RunHandle, RunListItem, RunOptions, RunRecord, RunStatus } from "./engine-port.js";
import { ordersFromEvents, type OrderEntry, type TrackingRecord } from "../core/orders.js";
import { orderPages } from "../orders/index.js";
import { unknownMessage } from "../core/order-state.js";
import { approvalProblem, mandateApprovalFor, resolveLimits } from "../core/limits.js";
import { boughtUnderMandateText, invalidMandate, mandateLimits, mandateText } from "../core/mandate.js";

import { applyChoices } from "./plan.js";
import { STORE_IDS, deliveredCents } from "./format.js";

const storeNameOf = (s: StoreId, domain: string) => (s === "shopify" ? domain : ({ amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target" } as Record<string, string>)[s] ?? s);

export interface MockEngineOptions {
  /** Delay multiplier: 1 is a realistic pace (a run takes about 10 s), 0 replays instantly (tests). */
  speed?: number;
  /** Store that fails its search in the demo (default "target"); null for none. */
  failStore?: StoreId | null;
  /** Store that asks the person to sign in at checkout (default "ebay"); null for none. */
  signInStore?: StoreId | null;
  /** Base path for demo Phantom Live links (the web app serves a placeholder there); null for none. */
  liveBase?: string | null;
  /** Store whose demo order ends "unknown" (no order number shown) instead of placed; default none. */
  unknownStore?: StoreId | null;
}

const DOMAINS: Record<StoreId, string> = {
  amazon: "amazon.com", walmart: "walmart.com", ebay: "ebay.com", bestbuy: "bestbuy.com", target: "target.com",
  shopify: "demo-shop.example",
};

const BRANDS = ["Northbay", "Plainwire", "Arcwell", "Kestrel", "Lumo Basics", "Voltaro"];

interface Template { match: RegExp; titles: string[]; base: number; spread: number; options?: Record<string, string[]> }

const CATALOG: Template[] = [
  { match: /hub|dock|adapter/i, base: 2899, spread: 1400, titles: [
    "7-in-1 USB-C Hub, 4K60 HDMI, 100W PD, 2 USB-A, SD", "6-in-1 USB-C Hub, 4K HDMI, 100W pass-through",
    "8-in-1 USB-C Hub with Ethernet, 4K60 HDMI", "Slim 4-in-1 USB-C Hub, 4K30 HDMI", "USB-C Hub 5-in-1, aluminum, 4K HDMI"] },
  { match: /hdmi/i, base: 999, spread: 700, options: { length: ["3 ft", "6 ft", "10 ft"] }, titles: [
    "HDMI 2.1 Cable 6 ft, 8K60 / 4K120, 48Gbps", "High Speed HDMI Cable 6 ft, braided", "Ultra High Speed HDMI Cable 6.6 ft",
    "HDMI Cable 6 ft, 4K60, gold plated", "Certified HDMI 2.1 Cable 6 ft"] },
  { match: /charger|power/i, base: 2499, spread: 1500, titles: [
    "65W USB-C Charger, GaN, 3 ports", "45W USB-C Wall Charger, foldable", "100W GaN Charger, 4 ports", "30W USB-C Charger, compact"] },
  { match: /mouse/i, base: 1999, spread: 1800, titles: [
    "Wireless Mouse, silent clicks, USB-C", "Ergonomic Vertical Mouse, Bluetooth", "Compact Travel Mouse, 2.4 GHz"] },
  { match: /keyboard/i, base: 3999, spread: 3000, titles: [
    "Wireless Keyboard, low profile, multi-device", "Mechanical Keyboard 75%, hot-swap", "Compact Bluetooth Keyboard"] },
  { match: /headphone|earbud/i, base: 4999, spread: 4000, titles: [
    "Wireless Earbuds, ANC, 30 h battery", "Over-Ear Headphones, Bluetooth 5.3", "Open-Ear Sport Earbuds"] },
  { match: /batter/i, base: 1299, spread: 900, titles: [
    "AA Alkaline Batteries, Pack of 24", "AA Batteries, 48 Count", "AA Batteries, 12 Count (Pack of 2)", "Rechargeable AA Batteries, 8 Pack"] },
];

/**
 * Demo identifiers, the same for one demo model at every store so the demo shows exact matches.
 * GTINs use the GS1 restricted-circulation prefix 04, which is never a real product's number.
 */
function demoIds(model: string, withGtin: boolean): ProductIds {
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (Math.imul(h, 31) + model.charCodeAt(i)) >>> 0;
  const body = `04${String(h % 1e10).padStart(10, "0")}`;
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  const gtin = `0${body}${(10 - (sum % 10)) % 10}`;
  const [brand] = model.split("|");
  const ids: ProductIds = { brand: brand.toLowerCase().replace(/[^a-z0-9]/g, ""), mpn: `DM${String(h % 1e6).padStart(6, "0")}` };
  if (withGtin) ids.gtin = gtin;
  return ids;
}

const STORE_FACTOR: Record<StoreId, number[]> = {
  // price multiplier per item index; picks land on different stores so the demo shows two checkouts
  amazon: [0.94, 1.1, 1.0], walmart: [1.03, 0.98, 0.97], ebay: [0.99, 0.86, 1.05],
  bestbuy: [1.12, 1.15, 1.08], target: [1.05, 1.02, 0.99], shopify: [1.1, 1.08, 1.02],
};

const DAY = 86_400_000;

function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const usd = (cents: number): Money => ({ cents: Math.round(cents), currency: "USD" });
const round99 = (cents: number) => Math.max(99, Math.floor(cents / 100) * 100 + 99);
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function dayText(ms: number): { text: string; iso: string } {
  const d = new Date(ms);
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return { text: `Arrives ${wd}, ${md}`, iso: d.toISOString().slice(0, 10) };
}

/** Very small demo parser: "a and b under $60" -> two items and a budget. The real engine uses the LLM. */
export function parseDemoPrompt(prompt: string, stores: StoreId[], zip?: string): ShoppingRequest {
  let text = prompt.trim();
  let budget: Money | undefined;
  const b = text.match(/\b(?:under|below|less than|max|budget(?: of)?|up to)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
  if (b) {
    budget = usd(parseFloat(b[1]) * 100);
    text = text.replace(b[0], " ");
  }
  const parts = text.split(/\s*(?:,|;|\+|\band\b|\bplus\b)\s*/i).map((s) => s.trim()).filter((s) => s.length > 1);
  const items: ItemRequest[] = (parts.length ? parts : [text || "usb-c hub"]).slice(0, 3).map((p, i) => {
    const qty = p.match(/^(\d+)\s*(?:x\s+|\s+(?!(?:ft|feet|foot|in|inch|inches|m|cm|mm|w|tb|gb|pack)\b))/i);
    const description = qty ? p.slice(qty[0].length) : p;
    const len = description.match(/(\d+(?:\.\d)?)\s*(?:ft|feet|foot)\b/i);
    return {
      id: `item-${i + 1}`,
      query: description,
      description,
      quantity: qty ? Math.min(9, parseInt(qty[1], 10)) : 1,
      options: len ? { length: `${len[1]} ft` } : undefined,
    };
  });
  return { prompt, items, stores, budget, zip, goal: "best_value" };
}

function makeOffers(store: StoreId, domain: string, item: ItemRequest, itemIndex: number, now: number): Offer[] {
  const r = rng(`${store}|${item.query}`);
  const tpl = CATALOG.find((t) => t.match.test(item.query));
  const titles = tpl?.titles ?? [titleCase(item.query), `${titleCase(item.query)}, pack of 2`, `${titleCase(item.query)}, premium`];
  const base = tpl?.base ?? 1999 + Math.floor(r() * 3000);
  const spread = tpl?.spread ?? 1500;
  const factor = STORE_FACTOR[store][itemIndex % 3];
  const count = 3 + Math.floor(r() * 2);
  const out: Offer[] = [];
  for (let i = 0; i < count; i++) {
    r(); // keeps the demo's random sequence (prices, ratings) as before the brands became per model
    const t = (i + itemIndex) % titles.length;
    const brand = BRANDS[(t * 2 + itemIndex) % BRANDS.length];
    const title = `${brand} ${titles[t]}`;
    const price = round99((base + (i === 0 ? 0 : r() * spread)) * factor);
    const freeOver = store === "walmart" || store === "target" ? 3500 : 0;
    const shipping = store === "ebay" ? (i === 0 || r() < 0.5 ? 0 : 399) : store === "shopify" ? 599 : price >= freeOver ? 0 : 599;
    const days = store === "amazon" ? 1 + Math.floor(r() * 2) : store === "ebay" ? 4 + Math.floor(r() * 4) : 2 + Math.floor(r() * 3);
    const when = dayText(now + days * DAY);
    const stars = Math.round((3.9 + r() * 1.0) * 10) / 10;
    const seller =
      store === "amazon" ? (r() < 0.6 ? "Amazon.com" : `Sold by ${BRANDS[i % BRANDS.length]} Direct`) :
      store === "walmart" ? (r() < 0.5 ? "Walmart.com" : "Marketplace seller") :
      store === "ebay" ? `demo-seller-${100 + Math.floor(r() * 800)} (99.${Math.floor(r() * 9)}% positive)` :
      store === "bestbuy" ? "Best Buy" : store === "target" ? "Target" : domain;
    out.push(withUnits({
      // eBay listings often name only the brand and part number, no GTIN.
      ids: demoIds(`${brand}|${titles[t]}`, store !== "ebay"),
      store, storeDomain: domain, itemId: item.id, title,
      url: `https://${domain}/demo/${item.id}-${i + 1}`,
      productId: `DEMO-${store.toUpperCase()}-${itemIndex + 1}${i + 1}`,
      price: usd(price),
      listPrice: r() < 0.3 ? usd(price + 500) : undefined,
      shipping: usd(shipping),
      deliveryText: when.text,
      deliveryDate: when.iso,
      rating: { stars, count: Math.floor(40 + r() * r() * 14000) },
      seller,
      condition: store === "ebay" && i === count - 1 ? "refurbished" : "new",
      inStock: !(i === count - 1 && r() < 0.25),
      sponsored: i === 1 && (store === "amazon" || store === "walmart"),
      variants: tpl?.options,
      raw: { demo: true },
    }));
  }
  return out;
}

function rank(offers: Offer[]): Offer[] {
  const ok = offers.filter((o) => o.inStock && !o.subscription && o.condition !== "used");
  const score = (o: Offer) => {
    const stars = o.rating?.stars ?? 4;
    const count = o.rating?.count ?? 0;
    return deliveredCents(o) * (1 + (4.7 - stars) * 0.12) - Math.log10(count + 1) * 60;
  };
  return ok.sort((a, b) => score(a) - score(b));
}

function reasonFor(best: Offer, all: Offer[]): string {
  const cheapest = Math.min(...all.map(deliveredCents));
  const d = deliveredCents(best);
  const stars = best.rating ? `${best.rating.stars.toFixed(1)} stars from ${best.rating.count.toLocaleString("en-US")} reviews` : "no rating shown";
  const ship = best.shipping?.cents === 0 ? "free shipping" : "shipping included";
  if (d === cheapest) return `Lowest delivered price, ${ship}, ${stars}`;
  return `$${((d - cheapest) / 100).toFixed(2)} more than the cheapest but ${stars}`;
}

interface MockRun {
  record: RunRecord;
  opts: RunOptions;
  request?: ShoppingRequest;
  picks: Pick[];
  carts: Cart[];
  reviews: CheckoutReview[];
  orders: OrderResult[];
  failures: RunSummary["failures"];
  approvals: Map<StoreId, (a: Approval | null) => void>;
  cancelled: Set<StoreId>;
  cancelledAll: boolean;
  liveUrls: Map<StoreId, string>;
  all: Offer[];
  flows: Map<StoreId, Promise<void>>;
  flowing: boolean;
  /** Stores with an order under the up-front approval (placing, placed or unknown). */
  mandateOrders: Set<StoreId>;
  /** Totals of orders placing, placed or unknown, by store. */
  committed: Map<StoreId, Money>;
}

export class MockEngine implements EnginePort {
  readonly demo = true;
  private runs = new Map<string, MockRun>();
  private seq = 0;
  private speed: number;
  private failStore: StoreId | null;
  private signInStore: StoreId | null;
  private liveBase: string | null;
  private unknownStore: StoreId | null;
  private tracking = new Map<string, TrackingRecord>();

  constructor(opts: MockEngineOptions = {}) {
    this.unknownStore = opts.unknownStore ?? null;
    this.speed = opts.speed ?? 1;
    this.failStore = opts.failStore === undefined ? "target" : opts.failStore;
    this.signInStore = opts.signInStore === undefined ? "ebay" : opts.signInStore;
    this.liveBase = opts.liveBase === undefined ? "/demo-live.html" : opts.liveBase;
  }

  private wait(ms: number, run?: MockRun): Promise<void> {
    if (run?.cancelledAll) return Promise.resolve();
    const t = ms * this.speed;
    return t <= 0 ? new Promise((r) => setImmediate(r)) : new Promise((r) => setTimeout(r, t));
  }

  run(prompt: string, opts: RunOptions): RunHandle {
    const runId = `demo-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${(++this.seq).toString().padStart(3, "0")}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const stores = (opts.limits?.allowedStores?.length ? opts.limits.allowedStores : STORE_IDS.filter((s) => s !== "shopify"))
      .filter((s, i, a) => a.indexOf(s) === i);
    const record: RunRecord = {
      runId, prompt, startedAt: new Date().toISOString(), status: "running", stores, orders: 0, events: [],
    };
    const run: MockRun = {
      record, opts, picks: [], carts: [], reviews: [], orders: [], failures: [], approvals: new Map(),
      cancelled: new Set(), cancelledAll: false, liveUrls: new Map(), all: [], flows: new Map(), flowing: false,
      mandateOrders: new Set(), committed: new Map(),
    };
    this.runs.set(runId, run);
    const done = this.drive(run, prompt, stores).catch((e) => {
      this.emit(run, { type: "log", message: `demo engine error: ${(e as Error).message}` });
      return this.finish(run, "failed");
    });
    return { runId, done };
  }

  private emit(run: MockRun, e: RunEvent) {
    run.record.events.push(e);
    try { run.opts.onEvent(e); } catch { /* a listener error never stops the run */ }
  }

  private finish(run: MockRun, status: RunStatus): RunSummary {
    if (run.record.summary) return run.record.summary;
    const summary: RunSummary = {
      runId: run.record.runId, startedAt: run.record.startedAt, finishedAt: new Date().toISOString(),
      picks: run.picks, carts: run.carts, reviews: run.reviews, orders: run.orders, failures: run.failures,
      creditsUsed: 0,
      ...(run.opts.mandate && !invalidMandate(run.opts.mandate) ? { mandate: mandateLimits(run.opts.mandate) } : {}),
    };
    run.record.status = run.cancelledAll ? "cancelled" : status;
    run.record.finishedAt = summary.finishedAt;
    run.record.summary = summary;
    run.record.orders = run.orders.filter((o) => o.placed).length;
    this.emit(run, { type: "done", summary });
    return summary;
  }

  private fail(run: MockRun, store: StoreId, stage: Stage, error: string) {
    run.failures.push({ store, stage, error });
    this.emit(run, { type: "store_failed", store, stage, error });
  }

  private async drive(run: MockRun, prompt: string, stores: StoreId[]): Promise<RunSummary> {
    const { opts } = run;
    const now = Date.now();
    await this.wait(400, run);
    const request = parseDemoPrompt(prompt, stores, opts.zip);
    if (opts.limits?.budget && !request.budget) request.budget = opts.limits.budget;
    if (opts.shopifyDomains?.length) request.shopifyDomains = opts.shopifyDomains;
    run.request = request;
    this.emit(run, { type: "parsed", request });
    this.emit(run, { type: "log", message: "Demo engine: made-up products and prices, no store is contacted." });
    const mandate = opts.mandate && !invalidMandate(opts.mandate) ? opts.mandate : undefined;
    if (mandate) this.emit(run, { type: "log", message: `Up-front approval: buy without asking, ${mandateText(mandateLimits(mandate))}. Anything else waits for your OK.` });

    const domainOf = (s: StoreId) => (s === "shopify" ? opts.shopifyDomains?.[0] ?? DOMAINS.shopify : DOMAINS[s]);
    const all: Offer[] = [];
    await Promise.all(stores.map(async (store, si) => {
      await this.wait(150 + si * 180, run);
      if (run.cancelledAll) return;
      const liveUrl = this.liveBase ? `${this.liveBase}?store=${store}&run=${encodeURIComponent(run.record.runId)}` : undefined;
      if (liveUrl) run.liveUrls.set(store, liveUrl);
      this.emit(run, { type: "store_started", store, liveUrl });
      for (const [ii, item] of request.items.entries()) {
        await this.wait(900 + ((si * 7 + ii * 3) % 5) * 450, run);
        if (run.cancelledAll || run.cancelled.has(store)) return;
        if (store === this.failStore && ii === 0) {
          this.emit(run, { type: "log", store, message: "Search page did not finish loading, trying the AI fallback" });
          await this.wait(1200, run);
          this.fail(run, store, "search", "Demo: search results did not load in 30 s (AI fallback found none)");
          return;
        }
        const offers = makeOffers(store, domainOf(store), item, ii, now);
        all.push(...offers);
        this.emit(run, { type: "offers", store, itemId: item.id, offers });
      }
    }));
    if (run.cancelledAll) return this.finish(run, "cancelled");

    await this.wait(500, run);
    let total = 0;
    for (const item of request.items) {
      const mine = all.filter((o) => o.itemId === item.id && !run.cancelled.has(o.store));
      const ranked = rank(mine);
      if (!ranked.length) continue;
      const best = ranked[0];
      total += deliveredCents(best) * item.quantity;
      run.picks.push({
        itemId: item.id, offer: best, score: Math.round(1000 - deliveredCents(best) / 10) / 1000,
        reason: reasonFor(best, mine.filter((o) => o.inStock)), alternatives: labelSameItem(best, ranked.slice(1, 5)),
      });
    }
    const overBudget = !!request.budget && total > request.budget.cents;
    this.emit(run, { type: "picks", picks: run.picks, total: usd(total), overBudget });
    if (!opts.confirm || run.picks.length === 0) return this.finish(run, "done");

    if (overBudget) return this.finish(run, "done");
    run.all = all;
    run.flowing = true;
    for (const store of new Set(run.picks.map((p) => p.offer.store))) this.startFlow(run, store);
    for (let seen = -1; seen !== run.flows.size;) {
      seen = run.flows.size;
      await Promise.all([...run.flows.values()]);
    }
    run.flowing = false;
    return this.finish(run, "done");
  }

  private startFlow(run: MockRun, store: StoreId) {
    if (run.flows.has(store) || !run.request) return;
    run.flows.set(store, this.checkoutStore(run, store, run.request).catch((e) => this.emit(run, { type: "log", store, message: `Stopped: ${(e as Error).message}` })));
  }

  async setPlan(runId: string, choices: PlanChoice[]): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || !run.request || run.record.status !== "running" || !run.picks.length) throw new Error("This run is not waiting at the comparison");
    if (run.carts.length) throw new Error("A cart is already filled. Start a new search to change the picks.");
    const applied = applyChoices(run.request, run.picks, run.all, choices, run.request.budget);
    for (const [id, q] of applied.quantities) {
      const item = run.request.items.find((i) => i.id === id);
      if (item) item.quantity = q;
    }
    run.picks = applied.picks;
    this.emit(run, { type: "picks", picks: applied.picks, total: applied.total, overBudget: applied.overBudget });
    this.emit(run, { type: "log", message: `You changed the picks: ${applied.picks.length} item${applied.picks.length === 1 ? "" : "s"}` });
    if (run.flowing && !applied.overBudget) for (const s of new Set(applied.picks.map((p) => p.offer.store))) this.startFlow(run, s);
  }

  private async checkoutStore(run: MockRun, store: StoreId, request: ShoppingRequest) {
    const confirm = run.opts.confirm!;
    if (!(await confirm("cart", store)) || run.cancelled.has(store) || run.cancelledAll) {
      this.emit(run, { type: "log", store, message: "Cart skipped" });
      return;
    }
    // Read the picks after the answer: the person may have changed them (setPlan) meanwhile.
    const picks = run.picks.filter((p) => p.offer.store === store);
    if (!picks.length) {
      this.emit(run, { type: "log", store, message: "No pick here any more; cart not filled" });
      return;
    }
    const domain = picks[0].offer.storeDomain;
    this.emit(run, { type: "log", store, message: `Adding ${picks.length} item${picks.length > 1 ? "s" : ""} to the cart` });
    await this.wait(1500, run);
    const lines: CartLine[] = picks.map((p) => {
      const qty = request.items.find((i) => i.id === p.itemId)?.quantity ?? 1;
      const options = request.items.find((i) => i.id === p.itemId)?.options;
      return { title: p.offer.title, quantity: qty, price: usd(p.offer.price.cents * qty), options, url: p.offer.url, productId: p.offer.productId };
    });
    const subtotal = lines.reduce((s, l) => s + l.price.cents, 0);
    const cart: Cart = { store, storeDomain: domain, lines, subtotal: usd(subtotal), readAt: new Date().toISOString(), warnings: [] };
    run.carts.push(cart);
    this.emit(run, { type: "cart", cart });

    if (!(await confirm("checkout", store)) || run.cancelled.has(store) || run.cancelledAll) {
      this.emit(run, { type: "log", store, message: "Checkout review skipped; the cart stays filled" });
      return;
    }
    this.emit(run, { type: "log", store, message: "Going to checkout, declining membership offers" });
    await this.wait(2000, run);
    const shipping = picks.reduce((s, p) => s + (p.offer.shipping?.cents ?? 0), 0);
    const tax = Math.round(subtotal * 0.06);
    const base: CheckoutReview = {
      store, storeDomain: domain, lines, subtotal: usd(subtotal), shipping: usd(shipping), tax: usd(tax),
      total: usd(subtotal + shipping + tax), shipTo: request.zip ? `ZIP ${request.zip}` : undefined,
      paymentHint: "Demo card ending 0000", reviewedAt: new Date().toISOString(),
    };
    if (store === this.signInStore) {
      const needs = { reason: "sign_in" as const, message: "Demo: the store asks you to sign in before checkout", liveUrl: run.liveUrls.get(store) };
      const review = { ...base, needsUser: needs };
      run.reviews.push(review);
      this.emit(run, { type: "checkout_review", review });
      this.emit(run, { type: "needs_user", store, needs });
      return;
    }
    run.reviews.push(base);
    const dom = store === "shopify" ? { domain } : {};
    const state = (s: OrderState, extra: Partial<Extract<RunEvent, { type: "order_state" }>> = {}) =>
      this.emit(run, { type: "order_state", store, ...dom, state: s, at: new Date().toISOString(), ...extra });
    this.emit(run, { type: "checkout_review", review: base });
    state("proposed", { total: base.total });
    state("awaiting_approval", { total: base.total });
    // Up-front approval: the same gate as the real engine (core/limits.ts approvalProblem).
    const mandate = run.opts.mandate && !invalidMandate(run.opts.mandate) ? run.opts.mandate : undefined;
    let approval: Approval | null = null;
    let declined: string | undefined;
    if (mandate) {
      const candidate = mandateApprovalFor(base, mandate);
      const placedCents = [...run.committed.values()].reduce((s, m) => s + m.cents, 0);
      declined = approvalProblem({
        store, storeDomain: store === "shopify" ? domain : undefined, review: base, approval: candidate, limits: resolveLimits(run.opts.limits),
        budget: run.opts.limits?.budget ?? request.budget, placed: usd(placedCents), ordered: new Set(run.committed.keys()),
        mandate, mandateOrders: run.mandateOrders.size,
      });
      if (!declined) {
        approval = candidate;
        run.mandateOrders.add(store);
        this.emit(run, { type: "log", store, message: `Buying without asking: $${(base.total.cents / 100).toFixed(2)} is within your up-front approval (${mandateText(mandateLimits(mandate))})` });
      } else {
        this.emit(run, { type: "log", store, message: `Not bought without asking: ${declined}. It waits for your OK of the exact total.` });
      }
    }
    if (!approval) {
      this.emit(run, { type: "awaiting_approval", store, review: base, ...(declined ? { mandateDeclined: declined } : {}) });
      approval = await new Promise<Approval | null>((resolve) => run.approvals.set(store, resolve));
      run.approvals.delete(store);
    }
    if (!approval) {
      this.emit(run, { type: "log", store, message: "Not bought; the cart stays filled" });
      return;
    }
    const how = approval.source === "mandate" && mandate
      ? { approval_source: "mandate" as const, mandate: mandateLimits(mandate) } : { approval_source: "user" as const };
    const ordersUrl = orderPages(store).ordersUrl(domain);
    run.committed.set(store, base.total);
    state("placing", { total: base.total, ...how });
    if (approval.approvedTotal.cents !== base.total.cents) {
      const error = "Approved total does not match the review total, order not placed";
      const result: OrderResult = { store, placed: false, state: "failed", error, confirmationText: error, ordersUrl, ...how };
      run.committed.delete(store);
      run.mandateOrders.delete(store);
      run.orders.push(result);
      state("failed", { message: error, ...how });
      this.emit(run, { type: "order", result });
      return;
    }
    this.emit(run, { type: "log", store, message: "Total re-checked, placing the order" });
    await this.wait(1800, run);
    if (store === this.unknownStore) {
      const checkMessage = `Demo: ${unknownMessage(storeNameOf(store, domain), ordersUrl)}`;
      const result: OrderResult = { store, placed: false, state: "unknown", submitted: true, total: base.total, error: "Demo: the store showed no order number", checkMessage, ordersUrl, ...how };
      run.orders.push(result);
      state("unknown", { total: base.total, message: checkMessage, ...how });
      this.emit(run, { type: "log", store, message: `Order state unknown. ${checkMessage}` });
      this.emit(run, { type: "order", result });
      return;
    }
    const result: OrderResult = {
      store, placed: true, state: "placed", orderId: `DEMO-${Math.floor(100000 + Math.random() * 900000)}`, total: base.total,
      confirmationText: "Demo order: nothing was bought", placedAt: new Date().toISOString(), ordersUrl, ...how,
    };
    run.orders.push(result);
    if (how.approval_source === "mandate" && mandate) this.emit(run, { type: "log", store, message: `${boughtUnderMandateText(mandate)}: $${(base.total.cents / 100).toFixed(2)} (demo, nothing was bought)` });
    state("placed", { orderId: result.orderId, total: base.total, ...how });
    this.emit(run, { type: "order", result });
  }

  async listOrders(o: { limit?: number; all?: boolean } = {}): Promise<OrderEntry[]> {
    const out: OrderEntry[] = [];
    for (const r of this.runs.values()) {
      for (const x of ordersFromEvents(r.record.runId, r.record.prompt, r.record.events, { live: r.record.status === "running" })) {
        const t = this.tracking.get(`${x.runId}|${x.shop}`);
        if (t) x.tracking = t;
        out.push(x);
      }
    }
    return (o.all ? out : out.filter((x) => x.state !== "failed")).sort((a, b) => b.at.localeCompare(a.at)).slice(0, o.limit ?? 200);
  }

  /** Demo: made-up shipping status for placed demo orders. No store is contacted. */
  async refreshOrders(filter: { runId?: string; store?: StoreId; limit?: number } = {}): Promise<OrderEntry[]> {
    const placed = (await this.listOrders()).filter((x) => x.state === "placed" && (!filter.runId || x.runId === filter.runId) && (!filter.store || x.store === filter.store))
      .slice(0, filter.limit ?? 10);
    for (const x of placed) {
      x.tracking = { status: "Shipped", deliveryText: "Arriving Friday", carrier: "Demo carrier", trackingNumber: "DEMO000000", checkedAt: new Date().toISOString() };
      this.tracking.set(`${x.runId}|${x.shop}`, x.tracking);
    }
    return placed;
  }

  async approve(runId: string, approval: Approval): Promise<void> {
    const run = this.runs.get(runId);
    const resolve = run?.approvals.get(approval.store);
    if (!run || !resolve) throw new Error(`No checkout waiting for approval at ${approval.store} in run ${runId}`);
    if (approval.by !== "user") throw new Error("Approval must come from the user");
    if (approval.source === "mandate") throw new Error("An up-front approval is applied by the engine itself; approve the exact total instead");
    resolve(approval);
  }

  async cancel(runId: string, store?: StoreId): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    if (store) {
      run.cancelled.add(store);
      run.approvals.get(store)?.(null);
    } else {
      run.cancelledAll = true;
      for (const r of run.approvals.values()) r(null);
    }
  }

  async listRuns(limit = 50): Promise<RunListItem[]> {
    return [...this.runs.values()].reverse().slice(0, limit).map(({ record }) => {
      const { events: _e, summary: _s, ...item } = record;
      const picks = [...record.events].reverse().find((e) => e.type === "picks");
      const unknown = ordersFromEvents(record.runId, undefined, record.events, { live: record.status === "running" }).filter((o) => o.state === "unknown").length;
      return { ...item, picksTotal: picks && picks.type === "picks" ? picks.total : undefined, ...(unknown ? { unknownOrders: unknown } : {}) };
    });
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId)?.record;
  }
}
