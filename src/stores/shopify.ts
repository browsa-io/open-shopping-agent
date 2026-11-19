// Any Shopify store (id "shopify", domain from ctx.domain). Every Shopify online store answers the
// same public JSON endpoints, so this adapter needs no selectors for search, product or cart:
//
//   /search/suggest.json?q=...&resources[type]=product   search (fallback: /products.json)
//   /products/<handle>.js                                 product, options and variants
//   /cart/add.js, /cart.js, /cart/clear.js                cart
//
// All calls run as fetch() inside the store's own page, so the cart is the browser's cart. Stores
// that run a custom ("headless") front end on their main domain do not answer these endpoints; the
// adapter detects that and fails with a clear error.

import type {
  Approval, Cart, CartLine, CheckoutReview, ItemRequest, Money, Offer, OrderResult, ProductIds, Rating,
} from "../core/types.js";
import type { StoreAdapter, StoreContext } from "./adapter.js";
import { browsaSolves, clean, evalWithRenew, isDeadPageError, jsonLd, needsUser, nowIso, pageIsDead, parseMoney, replacePage } from "./util.js";
import { idsFromHtml, mergeIds, normalizeIds } from "../core/identity.js";

type J = Record<string, any>;

// ---------------------------------------------------------------------------------------------
// Pure parsers (unit tested on saved answers in test/fixtures/shopify/)
// ---------------------------------------------------------------------------------------------

/** "110.00" (dollars as text) or 11000 (cents as a number) -> Money. */
export function shopifyMoney(v: unknown, currency: string, unit: "dollars" | "cents"): Money | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return undefined;
  return { cents: unit === "cents" ? Math.round(n) : Math.round(n * 100), currency };
}

/** Strip Shopify's search tracking (?_pos=1&_psq=...) and make the URL absolute. */
export function productUrl(origin: string, url: string | undefined, handle: string): string {
  const path = url ? url.split("?")[0] : `/products/${handle}`;
  return path.startsWith("http") ? path : origin.replace(/\/$/, "") + path;
}

export function handleFromUrl(url: string | undefined): string | undefined {
  const m = url?.match(/\/products\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

function hostOf(origin: string): string {
  try { return new URL(origin).hostname.replace(/^www\./, ""); } catch { return origin; }
}

/** /search/suggest.json answer -> offers. */
export function parseSuggest(json: J, origin: string, itemId: string, currency: string, limit = 10): Offer[] {
  const products: J[] = json?.resources?.results?.products ?? [];
  return products.slice(0, limit).flatMap((p): Offer[] => {
    const price = shopifyMoney(p.price ?? p.price_min, currency, "dollars");
    if (!p.title || !p.handle || !price) return [];
    const compare = shopifyMoney(p.compare_at_price_max ?? p.compare_at_price_min, currency, "dollars");
    const variants: J[] = Array.isArray(p.variants) ? p.variants : [];
    const firstVariant = variants.find((v) => v.available) ?? variants[0];
    return [{
      store: "shopify",
      storeDomain: hostOf(origin),
      itemId,
      title: String(p.title),
      url: productUrl(origin, p.url, p.handle),
      productId: firstVariant?.id ? String(firstVariant.id) : undefined,
      image: p.featured_image?.url ?? p.image ?? undefined,
      price,
      listPrice: compare && compare.cents > price.cents ? compare : undefined,
      seller: clean(p.vendor),
      condition: "new",
      inStock: p.available !== false,
      sponsored: false,
      subscription: false,
      raw: { handle: p.handle, shopifyProductId: p.id, type: p.type },
    }];
  });
}

/** Words of a query, for matching /products.json titles when search is unavailable. */
function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

/** /products.json answer filtered by the query (fallback search). Best matches first. */
export function parseProductsJson(json: J, query: string, origin: string, itemId: string, currency: string, limit = 10): Offer[] {
  const q = words(query);
  const scored: { o: Offer; score: number }[] = [];
  for (const p of json?.products ?? []) {
    const hay = words(`${p.title} ${p.product_type ?? ""} ${p.vendor ?? ""} ${(Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",")).join(" ")}`);
    const score = q.filter((w) => hay.some((h) => h === w || h.startsWith(w) || w.startsWith(h))).length;
    if (!q.length || score === 0) continue;
    const variants: J[] = p.variants ?? [];
    const v = variants.find((x) => x.available !== false) ?? variants[0];
    const price = shopifyMoney(v?.price, currency, "dollars");
    if (!price) continue;
    const compare = shopifyMoney(v?.compare_at_price, currency, "dollars");
    const opts: Record<string, string[]> = {};
    for (const o of p.options ?? []) if (o.name && Array.isArray(o.values) && !(o.values.length === 1 && o.values[0] === "Default Title")) opts[o.name] = o.values;
    scored.push({
      score,
      o: {
        store: "shopify", storeDomain: hostOf(origin), itemId,
        title: String(p.title), url: productUrl(origin, undefined, p.handle),
        productId: v?.id ? String(v.id) : undefined,
        image: p.images?.[0]?.src,
        price, listPrice: compare && compare.cents > price.cents ? compare : undefined,
        seller: clean(p.vendor), condition: "new",
        inStock: variants.some((x) => x.available !== false),
        sponsored: false, subscription: false,
        variants: Object.keys(opts).length ? opts : undefined,
        raw: { handle: p.handle, shopifyProductId: p.id },
      },
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.o);
}

export interface ShopifyVariant { id: string; title: string; options: Record<string, string>; available: boolean; price: Money; compareAt?: Money; requiresSellingPlan: boolean; sku?: string; barcode?: string }
export interface ShopifyProduct {
  id: string; handle: string; title: string; vendor?: string; available: boolean;
  options: Record<string, string[]>; variants: ShopifyVariant[];
  requiresSellingPlan: boolean; hasSellingPlans: boolean; image?: string;
}

/** /products/<handle>.js answer (prices in cents). */
export function parseProductJs(json: J, currency: string): ShopifyProduct {
  const names: string[] = (json.options ?? []).map((o: J | string) => (typeof o === "string" ? o : o.name));
  const options: Record<string, string[]> = {};
  for (const o of json.options ?? []) {
    if (typeof o === "object" && o.name && Array.isArray(o.values) && !(o.values.length === 1 && o.values[0] === "Default Title")) options[o.name] = o.values.map(String);
  }
  const variants: ShopifyVariant[] = (json.variants ?? []).map((v: J) => {
    const vals: string[] = Array.isArray(v.options) ? v.options : [v.option1, v.option2, v.option3].filter((x) => x != null);
    const opts: Record<string, string> = {};
    names.forEach((n, i) => { if (vals[i] != null && vals[i] !== "Default Title") opts[n] = String(vals[i]); });
    return {
      id: String(v.id),
      title: String(v.title ?? ""),
      options: opts,
      available: v.available !== false,
      price: shopifyMoney(v.price, currency, "cents") ?? { cents: 0, currency },
      compareAt: shopifyMoney(v.compare_at_price, currency, "cents"),
      requiresSellingPlan: v.requires_selling_plan === true,
      ...(v.sku ? { sku: String(v.sku) } : {}),
      ...(v.barcode ? { barcode: String(v.barcode) } : {}),
    };
  });
  return {
    id: String(json.id), handle: String(json.handle), title: String(json.title ?? ""), vendor: clean(json.vendor),
    available: json.available !== false, options, variants,
    requiresSellingPlan: json.requires_selling_plan === true,
    hasSellingPlans: Array.isArray(json.selling_plan_groups) && json.selling_plan_groups.length > 0,
    image: typeof json.featured_image === "string" ? (json.featured_image.startsWith("//") ? "https:" + json.featured_image : json.featured_image) : undefined,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();

/** Choose the variant for the wanted options; prefers in-stock, then the offer's current variant. */
export function pickShopifyVariant(prod: ShopifyProduct, wanted: Record<string, string> | undefined, currentId?: string):
  { variant?: ShopifyVariant; unmatched: string[] } {
  const want = Object.entries(wanted ?? {});
  let best: ShopifyVariant | undefined;
  let bestScore = -1;
  for (const v of prod.variants) {
    if (v.requiresSellingPlan) continue;
    let score = 0;
    for (const [k, val] of want) {
      const key = Object.keys(v.options).find((o) => norm(o) === norm(k));
      if (key && norm(v.options[key]) === norm(val)) score += 10;
      else if (!key && Object.values(v.options).some((x) => norm(x) === norm(val))) score += 8; // name differs ("Colour" vs "Color")
    }
    if (v.available) score += 3;
    if (v.id === currentId) score += 1;
    if (score > bestScore) { best = v; bestScore = score; }
  }
  const unmatched = want.filter(([k, val]) => {
    if (!best) return true;
    const key = Object.keys(best.options).find((o) => norm(o) === norm(k));
    return key ? norm(best.options[key]) !== norm(val) : !Object.values(best.options).some((x) => norm(x) === norm(val));
  }).map(([k, val]) => `${k}: ${val}`);
  return { variant: best, unmatched };
}

/** True when a /cart.js answer looks like Shopify's cart. */
export function isShopifyCart(json: unknown): json is J {
  return !!json && typeof json === "object" && Array.isArray((json as J).items) && "item_count" in (json as J) && "total_price" in (json as J);
}

/** /cart.js answer -> Cart (prices in cents, currency from the cart). */
export function parseShopifyCart(json: J, domain: string, origin?: string): Cart {
  const currency = String(json.currency ?? "USD");
  const lines: CartLine[] = (json.items ?? []).map((it: J) => {
    const options: Record<string, string> = {};
    for (const o of it.options_with_values ?? []) if (o.name && o.value && o.value !== "Default Title") options[o.name] = String(o.value);
    return {
      title: String(it.product_title ?? it.title ?? ""),
      quantity: Number(it.quantity ?? 1),
      price: shopifyMoney(it.final_line_price ?? it.line_price, currency, "cents") ?? { cents: 0, currency },
      options: Object.keys(options).length ? options : undefined,
      url: it.url ? (origin ? origin.replace(/\/$/, "") + String(it.url).split("?")[0] : String(it.url)) : undefined,
      productId: it.variant_id ? String(it.variant_id) : undefined,
    };
  });
  const warnings: string[] = [];
  for (const it of json.items ?? []) if (it.selling_plan_allocation) warnings.push(`'${it.product_title}' is a subscription line`);
  return {
    store: "shopify",
    storeDomain: domain,
    lines,
    subtotal: shopifyMoney(json.total_price, currency, "cents"),
    readAt: nowIso(),
    warnings,
  };
}

/**
 * Shopify checkout order summary rows ([label, value] from role="row" elements) -> totals.
 * "Shipping => Enter shipping address" gives no shipping amount. "Total => USD $19.99".
 */
export function parseCheckoutRows(rows: [string, string][], fallbackCurrency = "USD"):
  { subtotal?: Money; shipping?: Money; tax?: Money; total?: Money } {
  const out: { subtotal?: Money; shipping?: Money; tax?: Money; total?: Money } = {};
  for (const [label, value] of rows) {
    const l = label.toLowerCase();
    const code = value.match(/\b([A-Z]{3})\b/)?.[1];
    const m = /free/i.test(value) ? { cents: 0, currency: code ?? fallbackCurrency } : parseMoney(value, code ?? fallbackCurrency);
    if (!m) continue;
    if (code) m.currency = code;
    if (/^subtotal/.test(l)) out.subtotal = m;
    else if (/^(shipping|delivery)/.test(l)) out.shipping = m;
    else if (/tax/.test(l)) out.tax = m;
    else if (/^total/.test(l)) out.total = m;
  }
  return out;
}

/**
 * Identifiers of one variant: its barcode (a GTIN when it is a valid one; many shops put their own
 * SKU there, which normalizeGtin rejects), the vendor as brand, and the product page's JSON-LD for
 * the MPN and a GTIN when the barcode is not one.
 */
export function shopifyIds(prod: ShopifyProduct, variant: ShopifyVariant | undefined, html?: string): ProductIds | undefined {
  const own = normalizeIds({ gtin: variant?.barcode, brand: prod.vendor, sku: variant?.sku });
  const page = html ? idsFromHtml(html, jsonLd(html), variant?.sku) : undefined;
  return mergeIds(own, page);
}

/** aggregateRating from a product page's JSON-LD (review apps add it), or undefined. */
export function ratingFromHtml(html: string): Rating | undefined {
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    let data: unknown;
    try { data = JSON.parse(body); } catch { continue; }
    const stack: unknown[] = [data];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== "object") continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const o = x as J;
      const r = o.aggregateRating;
      if (r && (r.ratingValue !== undefined) && (r.reviewCount ?? r.ratingCount) !== undefined) {
        const stars = parseFloat(String(r.ratingValue));
        const count = parseInt(String(r.reviewCount ?? r.ratingCount), 10);
        if (Number.isFinite(stars) && Number.isFinite(count) && count > 0) return { stars: Math.min(5, stars), count };
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------------------------

/**
 * page.evaluate with a deadline. A wedged or crashed tab (seen live: Playwright never gets the
 * new document's context after some navigations) is replaced once with a fresh tab in the same
 * browser (ctx.newPage), which goes back to the shop page it was on.
 */
async function evalIn<R, A = undefined>(ctx: StoreContext, fn: (arg: A) => R | Promise<R>, arg?: A, ms = 30_000): Promise<R> {
  return evalWithRenew(ctx, fn, arg, {
    ms,
    reopen: async (last) => {
      const domain = ctx.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const back = /^https:\/\//.test(last) && hostOf(last).endsWith(domain.replace(/^www\./, "")) ? last : `https://${domain}/`;
      await ctx.page.goto(back, { waitUntil: "domcontentloaded", timeout: 60_000 });
    },
  });
}

interface ShopInfo { origin: string; domain: string; currency: string; country?: string; asked: string }
const shops = new WeakMap<object, ShopInfo>();

interface FetchResult { status: number; body: string; type: string; retryAfter?: string }

async function pageFetch(ctx: StoreContext, path: string, init?: { method?: string; json?: unknown; form?: Record<string, string> }): Promise<FetchResult> {
  return evalIn(ctx, async ([p, method, json, form]) => {
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      let body: string | undefined;
      if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
      else if (form) { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form as Record<string, string>).toString(); }
      const r = await fetch(p as string, { method: (method as string) || "GET", headers, body, credentials: "same-origin" });
      return { status: r.status, body: await r.text(), type: r.headers.get("content-type") || "", retryAfter: r.headers.get("retry-after") || undefined };
    } catch (e) {
      return { status: 0, body: String((e as Error)?.message ?? e), type: "" };
    }
  }, [path, init?.method ?? "GET", init?.json ?? null, init?.form ?? null] as const);
}

/** JSON from the store, retrying once on 429 (Shopify's rate limit). */
async function shopJson(ctx: StoreContext, path: string, init?: { method?: string; json?: unknown; form?: Record<string, string> }): Promise<{ status: number; json?: J; text: string }> {
  await shop(ctx);
  let r = await pageFetch(ctx, path, init);
  if (r.status === 429) {
    const wait = Math.min(10_000, Math.max(1500, (parseFloat(r.retryAfter ?? "2") || 2) * 1000));
    ctx.log(`Shopify rate limit on ${path.split("?")[0]}; waiting ${Math.round(wait / 1000)} s`);
    await ctx.page.waitForTimeout(wait);
    r = await pageFetch(ctx, path, init);
  }
  let json: J | undefined;
  try { json = JSON.parse(r.body) as J; } catch { json = undefined; }
  return { status: r.status, json, text: r.body };
}

const CHALLENGE = /just a moment|attention required|checking your browser|verify you are human|access denied/i;

/** Open the store once per page, wait out a bot check, confirm it is Shopify, and set the country to the US. */
async function shop(ctx: StoreContext): Promise<ShopInfo> {
  const domain = ctx.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const known = shops.get(ctx.page);
  if (known && known.asked === domain && sameShop(ctx.page.url(), known.origin)) return known;
  if (!domain || domain === "*") throw new Error("Shopify adapter needs the store's domain (ctx.domain), for example allbirds.com");
  const open = async () => {
    await ctx.page.goto(`https://${domain}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitOutChallenge(ctx);
    return evalIn(ctx, () => {
      const S = (window as unknown as { Shopify?: { shop?: string; country?: string; currency?: { active?: string } } }).Shopify;
      return { isShopify: !!S && typeof S === "object", shop: S?.shop, country: S?.country, currency: S?.currency?.active };
    }, undefined, 20_000);
  };
  let info: { isShopify: boolean; shop?: string; country?: string; currency?: string };
  try {
    info = await open();
  } catch (e) {
    // A page left on another store's checkout sometimes stops answering: a fresh tab when it is
    // dead, else start from a blank page, once.
    if (isDeadPageError(e) || ctx.page.isClosed() || await pageIsDead(ctx)) await replacePage(ctx, "crashed or stopped answering");
    else {
      ctx.log(`opening ${domain} failed (${(e as Error).message}); retrying from a blank page`);
      await ctx.page.goto("about:blank", { timeout: 15_000 }).catch(() => {});
    }
    info = await open();
  }
  const origin = new URL(ctx.page.url()).origin;
  {
    // The cart endpoint is the real test: some themes hide window.Shopify, and custom ("headless")
    // front ends load Shopify's scripts (window.Shopify exists) without the storefront endpoints.
    const r = await pageFetch(ctx, "/cart.js");
    let cart: unknown;
    try { cart = JSON.parse(r.body); } catch { cart = undefined; }
    if (!isShopifyCart(cart)) {
      throw new Error(`${domain} is not a Shopify online store (no Shopify cart at ${origin}/cart.js, HTTP ${r.status}). Stores with a custom front end are not supported by the Shopify adapter.`);
    }
    if (!info.isShopify || !info.currency) info = { ...info, currency: (cart as J).currency };
  }
  // v1 shops in US dollars: switch the store's market to the US when it picked another one, or
  // when it shows another currency (a visitor outside the US gets the local market's prices).
  if ((info.country && info.country !== "US") || (info.currency && info.currency !== "USD")) {
    const r = await pageFetch(ctx, "/localization", { method: "POST", form: { form_type: "localization", utf8: "✓", _method: "put", return_to: "/", country_code: "US" } });
    if (r.status < 400) {
      await ctx.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      const after = await evalIn(ctx, () => {
        const S = (window as unknown as { Shopify?: { country?: string; currency?: { active?: string } } }).Shopify;
        return { country: S?.country, currency: S?.currency?.active };
      });
      ctx.log(`Shopify market set to ${after.country ?? "?"} (${after.currency ?? "?"})`);
      info = { ...info, ...after };
      if (!after.currency) {
        // Themes that hide window.Shopify: the cart says which currency prices are in.
        const c = await pageFetch(ctx, "/cart.js");
        try { const j = JSON.parse(c.body) as J; if (typeof j?.currency === "string") info.currency = j.currency; } catch { /* keep */ }
      }
    }
    if (info.currency && info.currency !== "USD") ctx.log(`${domain} still shows prices in ${info.currency}; its offers are listed but not compared`);
  }
  const s: ShopInfo = { origin, domain: hostOf(origin), currency: info.currency || "USD", country: info.country, asked: domain };
  shops.set(ctx.page, s);
  return s;
}

function sameShop(url: string, origin: string): boolean {
  try { return new URL(url).origin === origin; } catch { return false; }
}

async function waitOutChallenge(ctx: StoreContext): Promise<void> {
  const title = async () => `${await ctx.page.title().catch(() => "")} ${await evalIn(ctx, () => document.body?.innerText?.slice(0, 300) ?? "").catch(() => "")}`;
  if (!CHALLENGE.test(await title())) return;
  if (await browsaSolves(ctx, ctx.domain, async () => CHALLENGE.test(await title()))) return;
  ctx.log("Store shows a bot check; waiting for Phantom to pass it");
  for (let i = 0; i < 2; i++) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await ctx.page.waitForTimeout(1000);
      if (!CHALLENGE.test(await title())) return;
    }
    if (i === 0) await ctx.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  }
  throw new Error(`${ctx.domain} kept showing a bot check. Open the store's live view to pass it, then retry.`);
}

async function getProduct(ctx: StoreContext, handle: string, currency: string): Promise<ShopifyProduct> {
  const r = await shopJson(ctx, `/products/${encodeURIComponent(handle)}.js`);
  if (r.status !== 200 || !r.json?.variants) throw new Error(`Shopify product '${handle}' not found (HTTP ${r.status})`);
  return parseProductJs(r.json, currency);
}

async function readShopifyCart(ctx: StoreContext): Promise<Cart> {
  const s = await shop(ctx);
  const r = await shopJson(ctx, "/cart.js");
  if (!isShopifyCart(r.json)) throw new Error(`Shopify cart unreadable (HTTP ${r.status})`);
  return parseShopifyCart(r.json, s.domain, s.origin);
}

/** Order summary rows of Shopify's checkout as [label, value]. */
async function checkoutRows(ctx: StoreContext): Promise<[string, string][]> {
  return evalIn(ctx, () => [...document.querySelectorAll('[role="row"]')].flatMap((r) => {
    const h = r.querySelector('[role="rowheader"]') as HTMLElement | null;
    const cells = [...r.querySelectorAll('[role="cell"]')] as HTMLElement[];
    if (!h || !cells.length) return [];
    return [[h.innerText.replace(/\s+/g, " ").trim(), cells.map((c) => c.innerText.replace(/\s+/g, " ").trim()).join(" ")] as [string, string]];
  }));
}

/** What the checkout still needs from the person, judged from empty visible fields. */
async function checkoutNeeds(ctx: StoreContext): Promise<{ reason: "sign_in" | "address" | "payment"; message: string } | undefined> {
  const page = ctx.page;
  if (/\/account\/login|\/login/.test(page.url())) return { reason: "sign_in", message: "This store asks you to sign in before checkout. Sign in in the live browser, then continue." };
  // No named helper functions inside evaluate() (tsx/esbuild would wrap them in __name()).
  const empty = await evalIn(ctx, () => {
    const groups = [
      'input[name="email"], input[autocomplete~="email"]',
      'input[name="address1"], input[autocomplete~="address-line1"], input[name="postalCode"], input[autocomplete~="postal-code"]',
    ].map((sel) => [...document.querySelectorAll(sel)].some((e) => !!(e as HTMLElement).offsetParent && !(e as HTMLInputElement).value));
    return {
      email: groups[0],
      address: groups[1],
      card: !!document.querySelector('iframe[src*="card-fields"], iframe[name*="card-fields"]'),
    };
  }).catch(() => ({ email: false, address: false, card: false }));
  if (empty.email || empty.address) return { reason: "address", message: "The store's checkout needs your contact, shipping address and payment. Fill them in the live browser; the agent never types them." };
  if (empty.card) return { reason: "payment", message: "The store's checkout needs your card details. Enter them in the live browser; the agent never types them." };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

export const shopify: StoreAdapter = {
  id: "shopify",
  name: "Shopify store",
  domains: ["*"],

  searchUrl(query: string, domain: string): string {
    return `https://${domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/search?type=product&q=${encodeURIComponent(query)}`;
  },

  async search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
    const s = await shop(ctx);
    const n = Math.min(10, Math.max(limit, 1));
    let offers: Offer[] = [];
    const r = await shopJson(ctx, `/search/suggest.json?q=${encodeURIComponent(item.query)}&resources[type]=product&resources[limit]=${n}&resources[options][unavailable_products]=last`);
    if (r.status === 200 && r.json?.resources) offers = parseSuggest(r.json, s.origin, item.id, s.currency, n);
    else ctx.log(`Shopify search answered HTTP ${r.status}; using the product list`);
    if (!offers.length) {
      for (let page = 1; page <= 4 && offers.length < limit; page++) {
        const p = await shopJson(ctx, `/products.json?limit=250&page=${page}`);
        if (p.status !== 200 || !p.json?.products?.length) break;
        offers = [...offers, ...parseProductsJson(p.json, item.query, s.origin, item.id, s.currency, limit)];
        if (p.json.products.length < 250) break;
      }
    }
    if (!offers.length) {
      try {
        const res = await ctx.aiTask<{ products?: { title: string; url: string; price: string }[] }>(
          `On ${s.domain}, search the store for "${item.query}" and return up to ${limit} products as JSON: title, url (product page link), price as shown. Do not sign in or check out.`,
          { startUrl: shopify.searchUrl(item.query, s.domain), maxSteps: 8, schema: { type: "object", properties: { products: { type: "array" } } } },
        );
        offers = (res?.products ?? []).flatMap((p): Offer[] => {
          const price = parseMoney(p.price, s.currency);
          const handle = handleFromUrl(p.url);
          if (!price || !handle) return [];
          return [{ store: "shopify", storeDomain: s.domain, itemId: item.id, title: p.title, url: productUrl(s.origin, p.url, handle), price, inStock: true, sponsored: false, subscription: false, raw: { handle } }];
        });
      } catch (e) { ctx.log(`Shopify AI search failed: ${(e as Error).message}`); }
    }
    return offers.slice(0, limit);
  },

  async details(ctx: StoreContext, offer: Offer): Promise<Offer> {
    const s = await shop(ctx);
    const handle = (offer.raw?.handle as string | undefined) ?? handleFromUrl(offer.url);
    if (!handle) throw new Error("Shopify offer has no product handle");
    const prod = await getProduct(ctx, handle, s.currency);
    const { variant } = pickShopifyVariant(prod, undefined, offer.productId);
    const out: Offer = {
      ...offer,
      title: prod.title || offer.title,
      productId: variant?.id ?? offer.productId,
      seller: prod.vendor ?? offer.seller,
      inStock: prod.variants.some((v) => v.available && !v.requiresSellingPlan),
      subscription: prod.requiresSellingPlan,
      variants: Object.keys(prod.options).length ? prod.options : undefined,
      raw: { ...offer.raw, handle, shopifyProductId: prod.id, hasSellingPlans: prod.hasSellingPlans },
    };
    if (variant) {
      out.price = variant.price;
      out.listPrice = variant.compareAt && variant.compareAt.cents > variant.price.cents ? variant.compareAt : undefined;
    }
    // Ratings live in review apps; most of them put aggregateRating JSON-LD on the product page.
    let html: string | undefined;
    try {
      html = await evalIn(ctx, async (p) => (await fetch(p, { credentials: "same-origin" })).text(), `/products/${encodeURIComponent(handle)}`);
      out.rating = ratingFromHtml(html) ?? out.rating;
    } catch (e) { ctx.log(`Shopify rating unavailable: ${(e as Error).message}`); }
    const ids = mergeIds(shopifyIds(prod, variant, html), offer.ids);
    if (ids) out.ids = ids;
    return out;
  },

  async addToCart(ctx: StoreContext, offer: Offer, quantity: number, options?: Record<string, string>): Promise<Cart> {
    const s = await shop(ctx);
    const handle = (offer.raw?.handle as string | undefined) ?? handleFromUrl(offer.url);
    if (!handle) throw new Error("Shopify offer has no product handle");
    const prod = await getProduct(ctx, handle, s.currency);
    if (prod.requiresSellingPlan) throw new Error(`'${prod.title}' is sold as a subscription only; v1 never buys subscriptions`);
    const { variant, unmatched } = pickShopifyVariant(prod, options, offer.productId);
    if (!variant) throw new Error(`'${prod.title}' has no variant that can be bought once`);
    const warnings: string[] = unmatched.map((u) => `Option '${u}' is not offered; chose ${variant.title}`);
    if (!variant.available) warnings.push(`'${prod.title} ${variant.title}' shows as sold out`);

    const before = await readShopifyCart(ctx);
    const beforeQty = before.lines.filter((l) => l.productId === variant.id).reduce((n, l) => n + l.quantity, 0);

    // No selling_plan in the request: Shopify adds the one-time purchase.
    const add = await shopJson(ctx, "/cart/add.js", { method: "POST", json: { items: [{ id: Number(variant.id), quantity }] } });
    const refusal = clean(add.json?.description ?? add.json?.message ?? add.text.slice(0, 160)) ?? "";
    // A real refusal (sold out, quantity limit) ends here; anything else (bundle apps answer
    // "Invalid cart") gets one try through the store's own Add to cart button.
    if (add.status === 422 && /sold out|out of stock|maximum|quantity|not available|unavailable|limit/i.test(refusal)) {
      throw new Error(`Shopify refused the add: ${refusal}`);
    }
    if (add.status !== 200) {
      ctx.log(`Shopify /cart/add.js answered HTTP ${add.status} (${refusal.slice(0, 80)}); trying the store's own button with the AI fallback`);
      await ctx.aiTask(`On ${s.domain}, open ${s.origin}/products/${handle}?variant=${variant.id}, keep the one-time purchase (not a subscription), set quantity ${quantity} and click "Add to cart". Do not check out.`,
        { startUrl: `${s.origin}/products/${handle}?variant=${variant.id}`, maxSteps: 10, sameBrowser: true });
    }

    const cart = await readShopifyCart(ctx);
    const line = cart.lines.find((l) => l.productId === variant.id);
    if (!line) cart.warnings.push(`The cart does not show '${prod.title} ${variant.title}' after adding it`);
    else {
      if (line.quantity !== beforeQty + quantity) cart.warnings.push(`The cart shows quantity ${line.quantity}, expected ${beforeQty + quantity}`);
      for (const [k, v] of Object.entries(options ?? {})) {
        const key = Object.keys(line.options ?? {}).find((o) => norm(o) === norm(k));
        const got = key ? line.options![key] : undefined;
        if (got && norm(got) !== norm(v)) cart.warnings.push(`Option '${k}: ${v}' did not stick, cart shows '${got}'`);
      }
    }
    cart.warnings.unshift(...warnings);
    return cart;
  },

  async readCart(ctx: StoreContext): Promise<Cart> {
    return readShopifyCart(ctx);
  },

  async clearCart(ctx: StoreContext): Promise<void> {
    const r = await shopJson(ctx, "/cart/clear.js", { method: "POST", json: {} });
    if (r.status !== 200) throw new Error(`Shopify /cart/clear.js answered HTTP ${r.status}`);
  },

  async reviewCheckout(ctx: StoreContext): Promise<CheckoutReview> {
    const s = await shop(ctx);
    const cart = await readShopifyCart(ctx);
    if (!cart.lines.length) throw new Error(`The ${s.domain} cart is empty`);
    await ctx.page.goto(`${s.origin}/checkout`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitOutChallenge(ctx);
    // The order summary renders after the checkout app loads.
    await ctx.page.locator('[role="rowheader"]').filter({ hasText: /total/i }).first().waitFor({ timeout: 25_000 }).catch(() => {});
    const rows = await checkoutRows(ctx).catch(() => [] as [string, string][]);
    const t = parseCheckoutRows(rows, s.currency);
    const review: CheckoutReview = {
      store: "shopify",
      storeDomain: s.domain,
      lines: cart.lines,
      subtotal: t.subtotal ?? cart.subtotal,
      shipping: t.shipping,
      tax: t.tax,
      total: t.total ?? t.subtotal ?? cart.subtotal ?? { cents: 0, currency: s.currency },
      reviewedAt: nowIso(),
    };
    if (!rows.length) ctx.log("Shopify checkout summary not found; totals come from the cart");
    const need = await checkoutNeeds(ctx);
    if (need) review.needsUser = await needsUser(ctx, need.reason, need.message);
    return review;
  },

  async placeOrder(ctx: StoreContext, approval: Approval): Promise<OrderResult> {
    const s = await shop(ctx).catch(() => undefined);
    if (!/\/checkouts?\//.test(ctx.page.url()) && s) {
      await ctx.page.goto(`${s.origin}/checkout`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await ctx.page.locator('[role="rowheader"]').filter({ hasText: /total/i }).first().waitFor({ timeout: 25_000 }).catch(() => {});
    const total = parseCheckoutRows(await checkoutRows(ctx), approval.approvedTotal.currency).total;
    if (!total || total.cents !== approval.approvedTotal.cents || total.currency !== approval.approvedTotal.currency) {
      const error = `the checkout total is now ${total ? (total.cents / 100).toFixed(2) : "unknown"}, approved ${(approval.approvedTotal.cents / 100).toFixed(2)}`;
      return { store: "shopify", placed: false, total, error, confirmationText: `Not placed: ${error}.` };
    }
    const need = await checkoutNeeds(ctx);
    if (need) return { store: "shopify", placed: false, total, needsUser: await needsUser(ctx, need.reason, need.message) };
    const pay = ctx.page.locator('#checkout-pay-button, button[type="submit"]:has-text("Pay now"), button[type="submit"]:has-text("Complete order")').first();
    if (!(await pay.isVisible().catch(() => false))) {
      return { store: "shopify", placed: false, total, needsUser: await needsUser(ctx, "other", "The store's 'Pay now' button was not found. Check the live browser.") };
    }
    await pay.click();
    // From here the click was sent: every result says submitted, so the engine never clicks again.
    const ok = await ctx.page.waitForURL(/thank[-_]?you|\/orders\//i, { timeout: 90_000 }).then(() => true).catch(() => false);
    const text = await evalIn(ctx, () => document.body?.innerText?.slice(0, 3000) ?? "").catch(() => "");
    if (!ok) {
      const again = await checkoutNeeds(ctx);
      return { store: "shopify", placed: false, submitted: true, total, needsUser: await needsUser(ctx, again?.reason ?? "3ds", again?.message ?? "The store did not confirm the order (a bank check may be open). Finish it in the live browser.") };
    }
    // An order number has a digit ("Order #1001", "Confirmation #A1B2C3"), so "Order summary" is not one.
    const orderId = (text.match(/(?:order|confirmation)\s*(?:#|number:?|no\.)\s*([A-Z0-9-]*\d[A-Z0-9-]*)/i) || [])[1];
    return { store: "shopify", placed: true, submitted: true, orderId, total, confirmationText: clean(text.match(/thank you[^.\n]*[.!]?/i)?.[0]) ?? "Order placed", placedAt: nowIso() };
  },
};

export default shopify;
