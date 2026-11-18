// Best Buy (bestbuy.com, US). Direct code first: search cards (data-product-id / data-testid),
// product pages (JSON-LD and the embedded __PDP_ANALYTICS_PAYLOAD__ with colour/size SKUs), the cart
// (data-test-sku sections and the order summary table). ctx.aiTask() is a fallback, once per stage.
//
// Rules this adapter keeps: protection plans, memberships and add-ons are always declined; options
// are separate SKUs on Best Buy, so choosing one means opening that SKU and checking it; checkout
// stops on the sign-in / guest page with `needsUser`; never signs in, never types personal details.
// Best Buy's bot wall ("Access Denied") or queue page: wait for Phantom, retry once, else a clear error.

import type { Approval, Cart, CartLine, CheckoutReview, Money, Offer, OrderResult } from "../core/types.js";
import type { StoreAdapter, StoreContext } from "./adapter.js";
import {
  attr, clean, elementAt, elementsWith, firstWith, jsonAfterMarker as jsonAfter, jsonLd, moneyFromNumeric as moneyFromNumber,
  isDeadPageError, needsUser, nowIso, pageIsDead, parseCount, parseMoney, parseStars, replacePage, sameOption, textLines, textOfHtml as textOf,
} from "./util.js";

const DOMAIN = "bestbuy.com";
const ORIGIN = "https://www.bestbuy.com";
const CART_URL = `${ORIGIN}/cart`;

// ---------------------------------------------------------------------------------------------
// Parsers (exported for unit tests)
// ---------------------------------------------------------------------------------------------

export type Wall = "denied" | "queue" | "captcha";

/** Best Buy's bot wall, waiting room or challenge page; undefined for a normal page. */
export function detectWall(html: string, title: string): Wall | undefined {
  const head = html.slice(0, 60_000);
  if (/^access denied$/i.test(title.trim()) || (/Access Denied/.test(head) && /errors\.edgesuite\.net|Reference #/.test(head))) return "denied";
  if (/you('|’)re in line|you are in line|waiting room|queue-it|high demand.*please wait/i.test(title + " " + head)) return "queue";
  if (/are you a human|verify you are human|press (&amp;|and) hold/i.test(head) && !/product-list-item|data-test-sku|application\/ld\+json/.test(html)) return "captcha";
  return undefined;
}

export function conditionOf(text: string | undefined): Offer["condition"] | undefined {
  if (!text) return undefined;
  if (/refurbished/i.test(text)) return "refurbished";
  if (/open-?box|pre-?owned|used/i.test(text)) return "used";
  if (/\bnew\b/i.test(text)) return "new";
  return undefined;
}

function abs(href: string | undefined): string | undefined {
  if (!href || href === "#") return undefined;
  return href.startsWith("http") ? href.split("#")[0] : `${ORIGIN}${href.startsWith("/") ? "" : "/"}${href.split("#")[0]}`;
}

/** Product URL for a SKU (Best Buy redirects it to the canonical page). */
export function skuUrl(sku: string): string {
  return `${ORIGIN}/site/${sku}.p?skuId=${sku}`;
}

export interface BbPrice { price: Money; listPrice?: Money }

/** SKUs of the result cards in page order (also the ones whose price has not rendered yet). */
export function searchSkus(html: string): { sku: string; priced: boolean }[] {
  const out = new Map<string, boolean>();
  const re = /<(li|div)\b[^>]*\bdata-testid="(\d{5,})"[^>]*\bdata-product-id="\2"[^>]*>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const card = elementAt(html, m.index);
    if (!firstWith(card, `class="product-title`)) continue;
    const priced = !!parseMoney(textOf(firstWith(card, `data-testid="price-block-customer-price"`)));
    out.set(m[2], (out.get(m[2]) ?? false) || priced);
  }
  return [...out].map(([sku, priced]) => ({ sku, priced }));
}

/**
 * Search results -> offers. Sponsored cards flagged; a SKU listed twice keeps its organic copy.
 * Cards render prices lazily; `prices` (from Best Buy's pricing API) fills the ones still empty.
 */
export function parseSearch(html: string, itemId: string, prices: Record<string, BbPrice> = {}): Offer[] {
  const bySku = new Map<string, Offer>();
  const order: string[] = [];
  const organic = new Set<string>();
  const re = /<(li|div)\b[^>]*\bdata-testid="(\d{5,})"[^>]*\bdata-product-id="\2"[^>]*>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const sku = m[2];
    const card = elementAt(html, m.index);
    const before = html.slice(Math.max(0, m.index - 600), m.index);
    const sponsored = /data-testid="sponsored-listing"|class="sponsored-content/.test(before) || /<div class="sponsored">\s*Sponsored/.test(card);
    const titleEl = firstWith(card, `class="product-title`);
    const title = clean(attr(titleEl, "title")) ?? textOf(titleEl);
    if (!title) continue;
    if (!sponsored) organic.add(sku);
    const priceText = textOf(firstWith(card, `data-testid="price-block-customer-price"`));
    const price = parseMoney(priceText) ?? prices[sku]?.price;
    if (!price) continue;
    const lines = textLines(card);
    const text = lines.join(" | ");
    const savings = textLines(firstWith(card, `data-testid="price-block-savings"`) ?? "").join(" ");
    const was = /(?:was|comp\.? value)\s*(\$[\d,]+(?:\.\d{2})?)/i.exec(savings + " " + text)?.[1];
    const ratingText = lines.find((l) => /^Rating [\d.]+ out of 5 stars/i.test(l));
    const reviews = ratingText ? /with ([\d,]+) reviews?/i.exec(ratingText)?.[1] : undefined;
    // Fulfillment text sits between the price block and the add-to-cart button.
    const pb = firstWith(card, `data-testid="price-block"`) ?? "";
    const afterPrice = pb ? textLines(card.slice(card.indexOf(pb) + pb.length)) : [];
    const endIdx = afterPrice.findIndex((l) => /^(add to cart|sold out|unavailable|coming soon|check stores|compare|see details)$/i.test(l));
    const ful = afterPrice.slice(0, endIdx >= 0 ? endIdx : 6);
    // Keep only the fulfillment part ("Pick up today Get it tomorrow · FREE"), not offer banners.
    const fulRaw = ful.join(" ").replace(/\s*•\s*/g, " · ");
    const fulStart = fulRaw.search(/pick ?up|get it|shipping|delivery|arrives/i);
    const fulText = fulStart >= 0 ? clean(fulRaw.slice(fulStart)) : undefined;
    const pickup = fulText ? /pick ?up[^·]*?(?=get it|shipping|$)/i.exec(fulText)?.[0]?.trim() : undefined;
    const ship = fulText ? /(get it|shipping)[^·]*(?:·\s*(free|\$[\d.,]+))?/i.exec(fulText) : null;
    const button = firstWith(card, `data-testid="plp-add-to-cart-${sku}"`);
    const unavailable = /data-testid="plp-(unavailable|sold-out|soldout)-/.test(card) || /\b(sold out|unavailable|coming soon)\b/i.test(lines.slice(-6).join(" "));
    const openBox = /open-?box/i.exec(text) ? parseMoney(/open-?box[^$]{0,40}(\$[\d,]+(?:\.\d{2})?)/i.exec(text)?.[1]) : undefined;
    const href = abs(attr(firstWith(card, `class="product-list-item-link"`), "href")) ?? skuUrl(sku);
    const titleCond = conditionOf(/refurbished|open-?box/i.test(title) ? title : undefined);
    const offer: Offer = {
      store: "bestbuy",
      storeDomain: DOMAIN,
      itemId,
      title,
      url: href,
      productId: sku,
      image: /<img[^>]*src="(https:\/\/pisces\.bbystatic\.com\/[^"]+)"/.exec(card)?.[1],
      price,
      listPrice: was ? parseMoney(was) : prices[sku]?.listPrice,
      shipping: ship ? (ship[2] ? parseMoney(ship[2]) : /free/i.test(ship[0]) ? { cents: 0, currency: "USD" } : undefined) : undefined,
      deliveryText: fulText,
      rating: ratingText ? { stars: parseStars(ratingText) ?? 0, count: parseCount(reviews) ?? 0 } : undefined,
      seller: "Best Buy",
      condition: titleCond ?? "new",
      inStock: !!button && !unavailable,
      sponsored,
      raw: { pickupText: pickup, shippingText: ship?.[0]?.trim(), openBoxFrom: openBox },
    };
    const prev = bySku.get(sku);
    if (!prev) { bySku.set(sku, offer); order.push(sku); }
    else if (prev.sponsored && !sponsored && (offer.deliveryText || !prev.deliveryText)) bySku.set(sku, offer);
  }
  return order.map((s) => bySku.get(s)!).map((o) => (organic.has(o.productId!) ? { ...o, sponsored: false } : o));
}

export interface BbVariation { name: string; options: { sku: string; name: string; state: string }[] }

export interface BbProduct {
  sku?: string;
  title?: string;
  price?: Money;
  condition?: Offer["condition"];
  rating?: { stars: number; count: number };
  inStock: boolean;
  buttonState?: string;
  seller?: string;
  shippingDaysOut?: number;
  pickupDaysOut?: number;
  variations: BbVariation[];
  otherOffers: { sku: string; price?: Money; seller?: string; condition?: Offer["condition"] }[];
}

export function parseProduct(html: string): BbProduct {
  const p = jsonLd(html).find((x) => x["@type"] === "Product");
  const offers: any[] = Array.isArray(p?.offers) ? p!.offers : p?.offers ? [p.offers] : [];
  const main = offers.find((o) => String(o.sku) === String(p?.sku)) ?? offers[0];
  const payload = jsonAfter(html, "window.__PDP_ANALYTICS_PAYLOAD__=") as any;
  const a = payload?.analyticsData ?? {};
  const info = a.skuInfo ?? {};
  const condText = String(main?.itemCondition ?? "") + " " + String(main?.description ?? "") + " " + String(info.condition ?? "");
  const condition = /Refurbished/i.test(condText) ? "refurbished" : /UsedCondition|open-?box|pre-?owned/i.test(condText) ? "used" : "new";
  const state = String(info.primaryButtonState ?? a.globalState?.primaryButtonState ?? "");
  const avail = String(main?.availability ?? "");
  const btn = /data-testid="pdp-add-to-cart-\d+"/.test(html);
  return {
    sku: p?.sku ? String(p.sku) : info.id ? String(info.id) : undefined,
    title: clean(p?.name),
    price: moneyFromNumber(main?.price, main?.priceCurrency ?? "USD") ?? moneyFromNumber(info.unitPrice),
    condition,
    rating: p?.aggregateRating ? { stars: +p.aggregateRating.ratingValue || 0, count: +p.aggregateRating.reviewCount || 0 } : undefined,
    inStock: state ? /ADD_TO_CART/i.test(state) : avail ? /InStock|LimitedAvailability/i.test(avail) : btn,
    buttonState: state || undefined,
    seller: clean(main?.seller?.name),
    shippingDaysOut: a.skuFulfillmentShipping?.shippingData?.[0]?.daysOut,
    pickupDaysOut: a.skuFulfillmentPickup?.pickupData?.[0]?.daysOut,
    variations: (info.productVariation ?? []).map((v: any) => ({
      name: String(v.variationType ?? v.rawName ?? "Option"),
      options: (v.options ?? []).map((o: any) => ({ sku: String(o.sku), name: String(o.displayName ?? o.colorSwatch ?? o.sku), state: String(o.state ?? "") })),
    })),
    otherOffers: offers.filter((o) => o !== main).map((o) => ({ sku: String(o.sku), price: moneyFromNumber(o.price, o.priceCurrency ?? "USD"), seller: clean(o.seller?.name), condition: conditionOf(String(o.itemCondition ?? "") + " " + String(o.description ?? "")) })),
  };
}

/** The SKU for wanted options, or the problems; undefined sku means "stay on this SKU". */
export function chooseVariation(prod: BbProduct, options: Record<string, string> = {}): { sku?: string; expected: Record<string, string>; problems: string[] } {
  const expected: Record<string, string> = {};
  const problems: string[] = [];
  let sku: string | undefined;
  const entries = Object.entries(options).filter(([k]) => k.toLowerCase() !== "condition");
  for (const v of prod.variations) {
    const label = v.name.toLowerCase();
    const wanted = entries.find(([k]) => label.includes(k.toLowerCase()) || k.toLowerCase().includes(label))?.[1]
      ?? entries.map(([, x]) => x).find((x) => v.options.some((o) => sameOption(o.name, x)));
    if (wanted === undefined) continue;
    const opt = v.options.find((o) => sameOption(o.name, wanted)) ?? v.options.find((o) => o.name.toLowerCase().includes(wanted.toLowerCase()));
    if (!opt) { problems.push(`${v.name} "${wanted}" is not offered (${v.options.map((o) => o.name).join(", ")})`); continue; }
    if (/unavailable|sold/i.test(opt.state)) { problems.push(`${v.name} "${opt.name}" is not available`); continue; }
    expected[v.name] = opt.name;
    if (opt.state !== "selected") sku = opt.sku;
  }
  return { sku, expected, problems };
}

export type BbCartLine = CartLine & { lineId?: string; fulfillment?: string };

export function parseCart(html: string): { store: "bestbuy"; storeDomain: string; lines: BbCartLine[]; subtotal?: Money; shipping?: Money; tax?: Money; total?: Money } {
  const lines: BbCartLine[] = [];
  const seen = new Set<string>();
  for (const el of elementsWith(html, `data-test-sku="`)) {
    if (!/^<section\b/.test(el)) continue;
    const sku = attr(el, "data-test-sku");
    const lineId = attr(el, "data-test-lineitemid");
    if (!sku || seen.has(lineId ?? sku)) continue;
    seen.add(lineId ?? sku);
    const link = firstWith(el, `id="cart-`) ?? firstWith(el, `href="/product/`);
    const title = clean(textLines(link ?? "").join(" ")) ?? "";
    const options: Record<string, string> = {};
    for (const l of textLines(el)) {
      // Variant lines such as "Color: Graphite" or "Cable Length: 4'" (not "Model: 910-007521").
      const kv = /^([A-Z][A-Za-z ]{1,30}):\s*(.+)$/.exec(l);
      if (kv && !/^(model|sku|sold by|price|item availability|quantity)$/i.test(kv[1].trim())) options[kv[1].trim()] = kv[2].trim();
    }
    const price = parseMoney(textOf(firstWith(el, `data-testid="cart-item__price"`)));
    const qtyEl = firstWith(el, `data-testid="cart-item-quantity__display"`);
    const sel = firstWith(el, `data-testid="cart-item-quantity__native-select"`);
    const qtySel = sel ? /<option[^>]*selected[^>]*>\s*(\d+)/.exec(sel)?.[1] ?? attr(sel, "value") : undefined;
    const qty = parseInt(textOf(qtyEl) ?? qtySel ?? "1", 10);
    const tiles = elementsWith(el, `data-testid="fulfillment-tile__`);
    const chosen = tiles.find((t) => /aria-(checked|pressed|selected)="true"|is-selected|selected"/.test(/^<[^>]*>/.exec(t)?.[0] ?? ""));
    if (!price) continue;
    lines.push({
      title,
      quantity: Number.isFinite(qty) ? qty : 1,
      price,
      options: Object.keys(options).length ? options : undefined,
      url: abs(attr(link, "href")),
      productId: sku,
      lineId,
      fulfillment: chosen ? (/__shipping/.test(chosen) ? "shipping" : /__pickup/.test(chosen) ? "pickup" : undefined) : undefined,
    });
  }
  const table = firstWith(html, `data-testid="order-summary__price-summary-table"`) ?? "";
  const rows = elementsWith(table, "<tr").length ? table.split(/<tr\b/).slice(1).map((r) => textLines("<tr" + r)) : [];
  const row = (re: RegExp) => {
    const r = rows.find((x) => re.test(x[0] ?? ""));
    if (!r) return undefined;
    const rest = r.slice(1).join(" ");
    return parseMoney(rest) ?? (/free/i.test(rest) ? { cents: 0, currency: "USD" } : undefined);
  };
  return {
    store: "bestbuy",
    storeDomain: DOMAIN,
    lines,
    // Best Buy's "Subtotal" is before sale savings, which it lists as their own row.
    subtotal: (() => {
      const sub = row(/^subtotal/i);
      const save = row(/savings|discount/i);
      return sub && save && save.cents < sub.cents ? { cents: sub.cents - save.cents, currency: sub.currency } : sub;
    })(),
    shipping: row(/^(shipping|store pickup|delivery)/i),
    tax: row(/tax/i),
    total: row(/^total/i),
  };
}

/** Best Buy's sign-in page that checkout opens for signed-out visitors. */
export function isSignInPage(html: string, url: string): boolean {
  return /\/identity\/(signin|global\/signin)/.test(url) || /cia-guest-content__continue|Continue as Guest/.test(html) && /Sign In to Best Buy|Returning Customers/i.test(html);
}

export interface BbReview { total?: Money; subtotal?: Money; shipping?: Money; tax?: Money; placeEnabled: boolean; needs?: "address" | "payment" | "sign_in"; shipTo?: string; paymentHint?: string }

/** The signed-in checkout review page (fast-track). Best effort: read the summary and the button. */
export function parseReview(html: string): BbReview {
  const lines = textLines(firstWith(html, `class="order-summary`) ?? html);
  const after = (re: RegExp) => { const i = lines.findIndex((l) => re.test(l)); if (i < 0) return undefined; const v = lines.slice(i + 1, i + 3).join(" "); return parseMoney(v) ?? (/free/i.test(v) ? { cents: 0, currency: "USD" } : undefined); };
  const btn = /<button[^>]*>(?:\s*<[^>]+>)*\s*Place Your Order/i.exec(html)?.[0];
  const placeEnabled = !!btn && !/disabled/.test(btn);
  let needs: BbReview["needs"];
  if (/name="(firstName|street|addressLine1)"|id="(street|addressLine1)"/.test(html)) needs = "address";
  else if (/name="(cardNumber|number)"|id="(cc-number|number|optimized-cc-card-number)"/.test(html)) needs = "payment";
  return { subtotal: after(/^(subtotal|item subtotal)/i), shipping: after(/^(shipping|delivery)/i), tax: after(/tax/i), total: after(/^(total|estimated total|order total)$/i), placeEnabled, needs };
}

// ---------------------------------------------------------------------------------------------
// Browser steps
// ---------------------------------------------------------------------------------------------

async function snapshot(ctx: StoreContext): Promise<{ html: string; title: string }> {
  return { html: await ctx.page.content(), title: await ctx.page.title().catch(() => "") };
}

async function goto(ctx: StoreContext, url: string, waitMs: number): Promise<{ html: string; title: string; error?: string }> {
  // A crashed, closed or frozen tab (heavy Best Buy pages) is replaced once with a fresh one in the same browser.
  for (let attempt = 0; ; attempt++) {
    let error: string | undefined;
    try {
      if (ctx.page.isClosed()) await replacePage(ctx, "was closed");
      await ctx.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e: Error) => {
        if (isDeadPageError(e)) throw e;
        error = e.message.split("\n")[0];
      });
      if (error && /Timeout/i.test(error) && await pageIsDead(ctx)) throw new Error("page stopped answering");
      await ctx.page.waitForTimeout(waitMs);
      return { ...(await snapshot(ctx)), error };
    } catch (e) {
      if (attempt > 0 || !isDeadPageError(e)) throw e;
      await replacePage(ctx, /stopped answering/.test(String((e as Error).message)) ? "stopped answering" : "crashed");
    }
  }
}

/**
 * Open a Best Buy page. On the bot wall or a queue: wait for Phantom (a queue for up to 90 s),
 * retry once, else a clear error. HTTP/2 protocol errors are Best Buy's edge refusing the browser.
 */
async function load(ctx: StoreContext, url: string, waitMs = 2500): Promise<string> {
  let p = await goto(ctx, url, waitMs);
  let wall = p.error && /ERR_HTTP2|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/.test(p.error) ? "denied" : detectWall(p.html, p.title);
  if (!wall && !p.error) return p.html;
  if (p.error && !wall) throw new Error(`Best Buy did not load ${url}: ${p.error}`);
  ctx.log(`Best Buy showed ${wall === "queue" ? "a queue" : "its bot wall"}; waiting and retrying once`);
  if (wall === "queue") {
    const until = Date.now() + 90_000;
    while (Date.now() < until && !ctx.signal.aborted) {
      await ctx.page.waitForTimeout(5000);
      const s = await snapshot(ctx);
      if (!detectWall(s.html, s.title)) return s.html;
    }
  } else {
    await ctx.page.waitForTimeout(8000);
  }
  p = await goto(ctx, url, waitMs + 1500);
  wall = p.error && /ERR_HTTP2|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET/.test(p.error) ? "denied" : detectWall(p.html, p.title);
  if (wall || p.error) {
    throw new Error(wall === "queue"
      ? "Best Buy kept the browser in its queue; try again later"
      : `Best Buy refused the browser twice (${wall === "captcha" ? "challenge page" : "Access Denied"}). Its bot wall blocks this exit address; use a US exit or try later`);
  }
  return p.html;
}

/** Scroll the results so lazy cards render prices, until `want` priced cards or 6 scrolls. */
async function hydrateResults(ctx: StoreContext, want: number): Promise<string> {
  let html = await ctx.page.content();
  for (let i = 0; i < 6 && parseSearch(html, "x").filter((o) => o.price).length < want; i++) {
    await ctx.page.mouse.wheel(0, 1400).catch(() => {});
    await ctx.page.waitForTimeout(900);
    html = await ctx.page.content();
  }
  return html;
}

/** Prices for SKUs from Best Buy's own pricing endpoint (same origin, run inside the page). */
async function fetchPrices(ctx: StoreContext, skus: string[]): Promise<Record<string, BbPrice>> {
  const raw = await ctx.page.evaluate(async (list: string[]) => {
    const out: Record<string, { c?: number; r?: number }> = {};
    await Promise.all(list.map(async (sku) => {
      try {
        const r = await fetch(`/pricing/v1/price/item?catalog=bby&context=%40pricing%2Fbasic&salesChannel=LargeView&skuId=${sku}`, { credentials: "include", headers: { accept: "application/json" } });
        if (!r.ok) return;
        const j = await r.json();
        out[sku] = { c: j.customerPrice ?? j.currentPrice, r: j.regularPrice };
      } catch { /* leave it out */ }
    }));
    return out;
  }, skus).catch((e: Error) => { ctx.log(`Best Buy pricing fetch failed: ${e.message.split("\n")[0]}`); return {} as Record<string, { c?: number; r?: number }>; });
  const out: Record<string, BbPrice> = {};
  for (const [sku, v] of Object.entries(raw)) {
    const price = moneyFromNumber(v.c);
    if (!price) continue;
    const reg = moneyFromNumber(v.r);
    out[sku] = { price, listPrice: reg && reg.cents > price.cents ? reg : undefined };
  }
  return out;
}

/** Decline protection plans / accessories drawers after Add to cart. */
async function declineAddOns(ctx: StoreContext): Promise<string[]> {
  const declined: string[] = [];
  const page = ctx.page;
  for (let i = 0; i < 3; i++) {
    const noThanks = page.locator(`[data-testid="no-thanks-button"], button:has-text("No thanks"), button:has-text("No, thanks")`).first();
    if (await noThanks.isVisible().catch(() => false)) { await noThanks.click({ timeout: 5000 }).catch(() => {}); declined.push("protection plan"); await page.waitForTimeout(1200); continue; }
    break;
  }
  const close = page.locator(`[data-testid$="overlay-backdrop-lv-closeButton"], [role="dialog"] button[aria-label="Close"]`).first();
  if (await close.isVisible().catch(() => false)) await close.click({ timeout: 5000 }).catch(() => {});
  return declined;
}

function readCartFrom(html: string, warnings: string[]): Cart & { lines: BbCartLine[] } {
  const c = parseCart(html);
  for (const l of c.lines) if (/protection|geek squad|applecare|membership|my best buy plus|my best buy total/i.test(l.title)) warnings.push(`Cart has an add-on we did not choose: ${l.title}`);
  return { store: "bestbuy", storeDomain: DOMAIN, lines: c.lines, subtotal: c.subtotal, readAt: nowIso(), warnings };
}

async function readCartNow(ctx: StoreContext, warnings: string[] = []) {
  const html = await load(ctx, CART_URL, 3500);
  return readCartFrom(html, warnings);
}

function skuOf(offer: Offer): string {
  const sku = offer.productId ?? /\/sku\/(\d+)|skuId=(\d+)/.exec(offer.url)?.slice(1).find(Boolean);
  if (!sku) throw new Error(`no Best Buy SKU in ${offer.url}`);
  return sku;
}

/** Open a product page for a SKU: the offer URL when it is that SKU, else the SKU URL. */
async function openProduct(ctx: StoreContext, sku: string, url?: string): Promise<{ html: string; prod: BbProduct }> {
  const target = url && new RegExp(`/sku/${sku}|skuId=${sku}`).test(url) ? url : url && !/\/sku\/\d+|skuId=/.test(url) ? url : skuUrl(sku);
  const html = await load(ctx, target, 3000);
  return { html, prod: parseProduct(html) };
}

// ---------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------

export const adapter: StoreAdapter = {
  id: "bestbuy",
  name: "Best Buy",
  domains: [DOMAIN, "www.bestbuy.com"],

  searchUrl(query: string): string {
    return `${ORIGIN}/site/searchpage.jsp?st=${encodeURIComponent(query)}&intl=nosplash`;
  },

  async search(ctx, item, limit) {
    let offers: Offer[] = [];
    try {
      await load(ctx, adapter.searchUrl(item.query, DOMAIN), 3500);
      const html = await hydrateResults(ctx, limit);
      const missing = searchSkus(html).filter((s) => !s.priced).map((s) => s.sku).slice(0, limit + 4);
      offers = parseSearch(html, item.id, missing.length ? await fetchPrices(ctx, missing) : {});
    } catch (e) {
      if (/refused the browser|queue/.test((e as Error).message)) throw e;
      ctx.log(`Best Buy search direct path failed: ${(e as Error).message}`);
    }
    if (!offers.length) {
      ctx.log("Best Buy search found no priced results in the page; asking the AI fallback once");
      const res = await ctx.aiTask<{ offers?: { title: string; url: string; sku?: string; price: string; rating?: number; reviews?: number }[] }>(
        `On bestbuy.com, search for "${item.query}". Return the first ${limit} products as JSON {offers:[{title,url,sku,price,rating,reviews}]}. Do not sign in, do not add anything to the cart.`,
        { startUrl: adapter.searchUrl(item.query, DOMAIN), maxSteps: 10 },
      ).catch((e: Error) => { ctx.log(`AI fallback failed: ${e.message}`); return { offers: [] }; });
      offers = (res.offers ?? []).flatMap((o) => {
        const price = parseMoney(o.price);
        const sku = o.sku ?? /\/sku\/(\d+)|skuId=(\d+)/.exec(o.url ?? "")?.slice(1).find(Boolean);
        return price && sku ? [{ store: "bestbuy" as const, storeDomain: DOMAIN, itemId: item.id, title: o.title, url: abs(o.url) ?? skuUrl(sku), productId: sku, price, rating: o.rating ? { stars: o.rating, count: o.reviews ?? 0 } : undefined, seller: "Best Buy", condition: conditionOf(o.title) ?? "new", inStock: true, raw: { viaAi: true } }] : [];
      });
    }
    const max = item.maxPrice?.cents;
    return offers.filter((o) => max === undefined || o.price.cents <= max).slice(0, limit);
  },

  async details(ctx, offer) {
    const sku = skuOf(offer);
    const { prod } = await openProduct(ctx, sku, offer.url);
    const delivery = [
      prod.shippingDaysOut !== undefined ? `Shipping: ${prod.shippingDaysOut === 0 ? "today" : prod.shippingDaysOut === 1 ? "tomorrow" : `in ${prod.shippingDaysOut} days`}` : "",
      prod.pickupDaysOut !== undefined ? `Pickup: ${prod.pickupDaysOut === 0 ? "today" : prod.pickupDaysOut === 1 ? "tomorrow" : `in ${prod.pickupDaysOut} days`}` : "",
    ].filter(Boolean).join(" · ");
    const date = prod.shippingDaysOut !== undefined ? new Date(Date.now() + prod.shippingDaysOut * 86_400_000).toISOString().slice(0, 10) : undefined;
    return {
      ...offer,
      productId: prod.sku ?? sku,
      title: prod.title ?? offer.title,
      price: prod.price ?? offer.price,
      rating: prod.rating ?? offer.rating,
      condition: prod.condition ?? offer.condition,
      seller: prod.seller ?? offer.seller,
      inStock: prod.inStock,
      deliveryText: delivery || offer.deliveryText,
      deliveryDate: date ?? offer.deliveryDate,
      variants: prod.variations.length ? Object.fromEntries(prod.variations.map((v) => [v.name, v.options.map((o) => o.name)])) : offer.variants,
      raw: { ...offer.raw, buttonState: prod.buttonState, otherOffers: prod.otherOffers.slice(0, 6), variationSkus: Object.fromEntries(prod.variations.flatMap((v) => v.options.map((o) => [`${v.name}:${o.name}`, o.sku]))) },
    };
  },

  async addToCart(ctx, offer, quantity, options) {
    const warnings: string[] = [];
    let sku = skuOf(offer);
    let { prod } = await openProduct(ctx, sku, offer.url);
    if (prod.sku) sku = prod.sku;

    const pick = chooseVariation(prod, options);
    if (pick.problems.length) throw new Error(`Best Buy ${sku}: ${pick.problems.join("; ")}`);
    if (pick.sku && pick.sku !== sku) {
      // Options are separate SKUs: try the swatch link first, then open the SKU directly.
      const link = ctx.page.locator(`a[href*="/sku/${pick.sku}"], a[href*="skuId=${pick.sku}"], [data-sku-id="${pick.sku}"]`).first();
      if (await link.isVisible().catch(() => false)) {
        await link.click({ timeout: 10_000 });
        await ctx.page.waitForTimeout(3500);
        prod = parseProduct(await ctx.page.content());
      }
      if (prod.sku !== pick.sku) prod = (await openProduct(ctx, pick.sku)).prod;
      if (prod.sku !== pick.sku) throw new Error(`Best Buy did not open option SKU ${pick.sku} (${Object.values(pick.expected).join(", ")})`);
      sku = pick.sku;
    }
    for (const [k, v] of Object.entries(pick.expected)) {
      const sel = prod.variations.find((x) => x.name === k)?.options.find((o) => o.state === "selected");
      if (sel && !sameOption(sel.name, v)) warnings.push(`Option ${k} '${v}' did not stick, page shows '${sel.name}'`);
    }
    if (!prod.inStock) throw new Error(`Best Buy SKU ${sku} cannot be added (${prod.buttonState ?? "not available"})`);

    const btn = ctx.page.locator(`[data-testid="pdp-add-to-cart-${sku}"]`).first();
    let clicked = false;
    if (await btn.count()) {
      await btn.click({ timeout: 15_000 }).then(() => { clicked = true; }).catch((e: Error) => ctx.log(`Add to cart click: ${e.message.split("\n")[0]}`));
    }
    if (!clicked) {
      ctx.log("Best Buy Add to cart button not usable; asking the AI fallback once");
      await ctx.aiTask(`On this Best Buy product page (SKU ${sku}), click "Add to cart" once. Decline any protection plan ("No thanks") and do not add accessories. Do not sign in. Return {"done":true}.`, { maxSteps: 8, sameBrowser: true })
        .catch((e: Error) => { throw new Error(`Best Buy add to cart failed: ${e.message}`); });
    }
    await ctx.page.waitForTimeout(3000);
    const declined = await declineAddOns(ctx);
    if (declined.length) ctx.log(`declined: ${declined.join(", ")}`);

    let cart = await readCartNow(ctx, warnings);
    let line = cart.lines.find((l) => l.productId === sku);
    if (!line) { warnings.push(`Best Buy cart does not show SKU ${sku} after Add to cart`); return cart; }
    if (line.quantity !== quantity) {
      const sel = ctx.page.locator(`section[data-test-sku="${sku}"] [data-testid="cart-item-quantity__native-select"]`).first();
      if (await sel.count()) {
        await sel.selectOption(String(quantity)).catch(() => {});
        await ctx.page.waitForTimeout(3000);
        cart = readCartFrom(await ctx.page.content(), warnings);
        line = cart.lines.find((l) => l.productId === sku);
      }
      if (line && line.quantity !== quantity) warnings.push(`Quantity ${quantity} did not stick, cart shows ${line.quantity}`);
    }
    for (const [k, v] of Object.entries(pick.expected)) {
      const shown = line?.options?.[k] ?? Object.values(line?.options ?? {}).join(", ");
      if (shown && !sameOption(shown, v) && !shown.toLowerCase().includes(v.toLowerCase())) warnings.push(`Option ${k} '${v}' did not stick, cart shows '${shown}'`);
    }
    return cart;
  },

  async readCart(ctx) {
    return readCartNow(ctx);
  },

  async clearCart(ctx) {
    await load(ctx, CART_URL, 3500);
    for (let i = 0; i < 25; i++) {
      const rm = ctx.page.locator(`section[data-test-sku] button:has-text("Remove"), section[data-test-sku] a:has-text("Remove")`).first();
      if (!(await rm.count())) return;
      await rm.click({ timeout: 10_000 });
      await ctx.page.waitForTimeout(2500);
    }
  },

  async reviewCheckout(ctx) {
    const warnings: string[] = [];
    const html = await load(ctx, CART_URL, 3500);
    let cart = parseCart(html);
    if (!cart.lines.length) throw new Error("Best Buy cart is empty");
    // Prefer shipping over store pickup (pickup is Best Buy's default for the nearest store).
    let switched = false;
    for (const l of cart.lines) {
      if (l.fulfillment === "shipping") continue;
      const tile = ctx.page.locator(`section[data-test-sku="${l.productId}"] [data-testid="fulfillment-tile__shipping"]`).first();
      if (await tile.isVisible().catch(() => false)) { await tile.click({ timeout: 8000 }).catch(() => {}); switched = true; await ctx.page.waitForTimeout(2500); }
    }
    if (switched) cart = parseCart(await ctx.page.content());
    const base = { store: "bestbuy" as const, storeDomain: DOMAIN, lines: cart.lines, subtotal: cart.subtotal, shipping: cart.shipping, tax: cart.tax, total: cart.total ?? cart.subtotal ?? { cents: 0, currency: "USD" } };

    await ctx.page.locator(`[data-testid="checkout__btn"], button:has-text("Checkout")`).first().click({ timeout: 15_000 });
    await ctx.page.waitForLoadState("domcontentloaded").catch(() => {});
    await ctx.page.waitForTimeout(5000);
    const s = await snapshot(ctx);
    const wall = detectWall(s.html, s.title);
    if (wall) throw new Error(`Best Buy showed ${wall === "queue" ? "a queue" : "its bot wall"} at checkout`);
    if (isSignInPage(s.html, ctx.page.url())) {
      const nu = await needsUser(ctx, "sign_in", "Best Buy asks you to sign in or continue as guest. Open the live browser to choose; the agent does not sign in or type your details.");
      return { ...base, needsUser: nu, reviewedAt: nowIso() } satisfies CheckoutReview;
    }
    const r = parseReview(s.html);
    const review: CheckoutReview = { ...base, subtotal: r.subtotal ?? base.subtotal, shipping: r.shipping ?? base.shipping, tax: r.tax ?? base.tax, total: r.total ?? base.total, reviewedAt: nowIso() };
    if (r.needs) review.needsUser = await needsUser(ctx, r.needs, r.needs === "address" ? "Best Buy needs a shipping address. Open the live browser to enter it." : "Best Buy needs a payment method. Open the live browser to enter it.");
    else if (!r.total) review.needsUser = await needsUser(ctx, "other", "Best Buy opened a checkout step the agent cannot read. Open the live browser to look.");
    if (warnings.length) ctx.log(warnings.join("; "));
    return review;
  },

  async placeOrder(ctx, approval: Approval): Promise<OrderResult> {
    const page = ctx.page;
    if (!/\/checkout\//.test(page.url())) {
      const r = await adapter.reviewCheckout(ctx);
      if (r.needsUser) return { store: "bestbuy", placed: false, needsUser: r.needsUser };
    }
    const r = parseReview(await page.content());
    if (!r.total) return { store: "bestbuy", placed: false, error: "Best Buy checkout total could not be read; not placing the order" };
    if (r.total.cents !== approval.approvedTotal.cents || r.total.currency !== approval.approvedTotal.currency) {
      return { store: "bestbuy", placed: false, total: r.total, error: `Best Buy total is now ${r.total.cents / 100} ${r.total.currency}, approved ${approval.approvedTotal.cents / 100} ${approval.approvedTotal.currency}; not placing the order` };
    }
    if (r.needs || !r.placeEnabled) return { store: "bestbuy", placed: false, needsUser: await needsUser(ctx, r.needs ?? "other", "Best Buy needs your input before the order can be placed. Open the live browser.") };
    await page.locator(`button:has-text("Place Your Order")`).first().click({ timeout: 15_000 });
    await page.waitForURL(/thank-you|confirmation|order-confirmation/i, { timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const text = textLines(await page.content()).join(" ");
    if (/verification code|3-?D Secure|verify your card/i.test(text) && !/thank you for your order/i.test(text)) {
      return { store: "bestbuy", placed: false, needsUser: await needsUser(ctx, "3ds", "Your bank asks for a verification step. Open the live browser to finish it.") };
    }
    const placed = /thank you for your order|order (is )?confirmed|we('|’)ve received your order/i.test(text);
    return {
      store: "bestbuy",
      placed,
      orderId: /\b(BBY01-\d{9,})\b/.exec(text)?.[1],
      total: r.total,
      confirmationText: clean(/(thank you for your order[^.]*\.?)/i.exec(text)?.[0]),
      placedAt: placed ? nowIso() : undefined,
    };
  },
};

export default adapter;
