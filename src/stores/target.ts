// Target (target.com, US). Target's pages are thin shells that load everything from its own
// JSON APIs (redsky.target.com for search and products, carts.target.com for the cart). The
// adapter calls the same APIs from inside the Target page, so the browser's cookies and bot
// check tokens go with every call, and only falls back to the page itself (and then the AI
// task) when the APIs fail.
//
// Bot checks: Target uses PerimeterX. A blocked API call answers 403/429/435 with a small JSON
// body naming "px-captcha". The adapter then opens the blocked URL as a page, where Target shows
// a "Press & hold" button, holds it with real mouse events, and retries once. Target also shows
// "Sorry for the wait" to addresses it refuses outright (non-US and some datacenter exits).

import type {
  Approval, Cart, CartLine, CheckoutReview, ItemRequest, Money, Offer, OrderResult,
} from "../core/types.js";
import type { StoreAdapter, StoreContext } from "./adapter.js";
import { CaptchaHandoffError, clean, evalWithRenew, gotoRetry, isDeadPageError, needsUser, nowIso, pageIsDead, passPressAndHold, replacePage } from "./util.js";

const ORIGIN = "https://www.target.com";
const REDSKY = "https://redsky.target.com/redsky_aggregations/v1/web/";
const CARTS = "https://carts.target.com/web_checkouts/v1/";
/** Target's public web key, the same one every target.com page sends. Read from the page when it changes. */
export const TARGET_WEB_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96";

// ---------------------------------------------------------------------------------------------
// Pure parsers (unit tested on saved responses in test/fixtures/target/)
// ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " ", trade: "™", reg: "®" };

/** Target titles come HTML-escaped: "Men&#39;s Socks - Goodfellow &#38; Co&#8482;" -> "Men's Socks - Goodfellow & Co™". */
export function decodeEntities(s: string | undefined | null): string {
  if (!s) return "";
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Dollars as a number (25.99) -> Money. */
export function usd(n: unknown): Money | undefined {
  if (typeof n === "string") n = parseFloat(n.replace(/[^0-9.]/g, ""));
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return { cents: Math.round(n * 100), currency: "USD" };
}

/** "$12.99" or "$12.99 - $15.99" -> the low price. */
function priceFromFormatted(s: unknown): Money | undefined {
  if (typeof s !== "string") return undefined;
  const m = s.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  return m ? usd(parseFloat(m[1].replace(/,/g, ""))) : undefined;
}

type J = Record<string, any>;

function priceOf(p: J | undefined): { price?: Money; listPrice?: Money; unitPrice?: Offer["unitPrice"] } {
  if (!p) return {};
  const price = usd(p.current_retail) ?? usd(p.current_retail_min) ?? priceFromFormatted(p.formatted_current_price);
  const reg = usd(p.reg_retail) ?? usd(p.reg_retail_min) ?? priceFromFormatted(p.formatted_comparison_price);
  const out: { price?: Money; listPrice?: Money; unitPrice?: Offer["unitPrice"] } = { price };
  if (price && reg && reg.cents > price.cents) out.listPrice = reg;
  const unit = priceFromFormatted(p.formatted_unit_price);
  if (unit && typeof p.formatted_unit_price_suffix === "string") out.unitPrice = { amount: unit, per: p.formatted_unit_price_suffix.replace(/^\//, "").trim() };
  return out;
}

function ratingOf(x: J | undefined): Offer["rating"] {
  const r = x?.ratings_and_reviews?.statistics?.rating;
  if (!r || typeof r.average !== "number" || !r.count) return undefined;
  return { stars: Math.round(r.average * 100) / 100, count: r.count };
}

/** One offer per TCIN from a plp_search_v2 answer. Sponsored copies are flagged; an organic copy wins. */
export function parseTargetSearch(json: J, itemId: string, limit = 24): Offer[] {
  const products: J[] = json?.data?.search?.products ?? [];
  const byTcin = new Map<string, Offer>();
  for (const p of products) {
    const tcin = String(p.tcin ?? "");
    if (!tcin) continue;
    const item = p.item ?? {};
    const parent = p.parent;
    const title = decodeEntities(item.product_description?.title ?? parent?.item?.product_description?.title);
    const url = item.enrichment?.buy_url ?? parent?.item?.enrichment?.buy_url ?? `${ORIGIN}/p/-/A-${tcin}`;
    const { price, listPrice, unitPrice } = priceOf(p.price ?? parent?.price);
    if (!title || !price) continue;
    const sponsored = p.is_sponsored_sku === true || !!p.sponsored_ad;
    const variants: Record<string, string[]> = {};
    for (const t of parent?.variation_summary?.themes ?? []) {
      const vals = (t.swatches ?? []).map((s: J) => s.value).filter(Boolean);
      if (t.name && vals.length) variants[t.name] = vals;
    }
    const offer: Offer = {
      store: "target",
      storeDomain: "target.com",
      itemId,
      title,
      url,
      productId: tcin,
      image: item.enrichment?.image_info?.primary_image?.url ?? item.enrichment?.images?.primary_image_url,
      price,
      listPrice,
      unitPrice,
      rating: ratingOf(p) ?? ratingOf(parent),
      seller: item.fulfillment?.is_marketplace ? (clean(item.product_vendors?.[0]?.vendor_name) ?? "Target Plus partner") : "Target",
      condition: /\brefurbished\b/i.test(title) ? "refurbished" : "new",
      inStock: true, // plp_search_v2 lists purchasable items only (default_purchasability_filter=true)
      sponsored,
      subscription: false,
      variants: Object.keys(variants).length ? variants : undefined,
      raw: { tcin, parentTcin: parent?.tcin, brand: item.primary_brand?.name, relation: item.relationship_type_code },
    };
    const seen = byTcin.get(tcin);
    if (!seen) byTcin.set(tcin, offer);
    else if (seen.sponsored && !sponsored) byTcin.set(tcin, { ...offer }); // organic listing of the same item wins
  }
  return [...byTcin.values()].slice(0, limit);
}

export interface TargetFulfillment {
  inStock: boolean;
  deliveryText?: string;
  deliveryDate?: string;
  shippingAvailable: boolean;
}

/** product_summary_with_fulfillment_v1 -> per-TCIN shipping facts. */
export function parseTargetFulfillment(json: J): Map<string, TargetFulfillment> {
  const out = new Map<string, TargetFulfillment>();
  for (const s of json?.data?.product_summaries ?? []) {
    const tcin = String(s.tcin ?? s.fulfillment?.product_id ?? "");
    const f = s.fulfillment ?? {};
    const ship = f.shipping_options ?? {};
    const status: string = ship.availability_status ?? "";
    const svc = (ship.services ?? []).find((x: J) => x.is_base_shipping_method) ?? (ship.services ?? [])[0];
    const shippingAvailable = /^IN_STOCK|LIMITED_STOCK|PRE_ORDER_SELLABLE/.test(status);
    const date: string | undefined = svc?.min_delivery_date;
    const max: string | undefined = svc?.max_delivery_date;
    let deliveryText: string | undefined;
    if (date) deliveryText = `Shipping: arrives ${fmtDay(date)}${max && max !== date ? ` to ${fmtDay(max)}` : ""}`;
    else if (status) deliveryText = `Shipping: ${status.toLowerCase().replace(/_/g, " ")}`;
    out.set(tcin, { inStock: shippingAvailable && !f.sold_out, deliveryText, deliveryDate: date, shippingAvailable });
  }
  return out;
}

function fmtDay(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export interface TargetVariant { tcin: string; options: Record<string, string>; available: boolean; url?: string }
export interface TargetProduct {
  tcin: string;
  title: string;
  url?: string;
  price?: Money;
  listPrice?: Money;
  unitPrice?: Offer["unitPrice"];
  rating?: Offer["rating"];
  variants: TargetVariant[];
  /** option name -> values offered */
  options: Record<string, string[]>;
  childPrices: Map<string, Money>;
  childTitles: Map<string, string>;
}

/** pdp_client_v1 -> title, price, rating and the variant tree flattened to one entry per child TCIN. */
export function parseTargetPdp(json: J): TargetProduct {
  const p = json?.data?.product ?? {};
  const variants: TargetVariant[] = [];
  const walk = (nodes: J[], path: Record<string, string>) => {
    for (const n of nodes ?? []) {
      const here = n.name ? { ...path, [n.name]: String(n.value) } : path;
      if (Array.isArray(n.variation_hierarchy) && n.variation_hierarchy.length) walk(n.variation_hierarchy, here);
      else if (n.tcin) {
        const a = n.availability ?? n.fulfillment ?? {};
        variants.push({ tcin: String(n.tcin), options: here, available: a.is_sold_out !== true && a.is_shipping_available !== false, url: n.buy_url });
      }
    }
  };
  walk(p.variation_hierarchy ?? [], {});
  const options: Record<string, string[]> = {};
  for (const v of variants) for (const [k, val] of Object.entries(v.options)) {
    (options[k] ??= []);
    if (!options[k].includes(val)) options[k].push(val);
  }
  const childPrices = new Map<string, Money>();
  const childTitles = new Map<string, string>();
  for (const c of p.children ?? []) {
    const m = priceOf(c.price).price;
    if (m) childPrices.set(String(c.tcin), m);
    const t = c.item?.product_description?.title;
    if (t) childTitles.set(String(c.tcin), decodeEntities(t));
  }
  const pr = priceOf(p.price);
  return {
    tcin: String(p.tcin ?? ""),
    title: decodeEntities(p.item?.product_description?.title),
    url: p.item?.enrichment?.buy_url,
    price: pr.price,
    listPrice: pr.listPrice,
    unitPrice: pr.unitPrice,
    rating: ratingOf(p),
    variants,
    options,
    childPrices,
    childTitles,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();

/**
 * Choose the child TCIN for the wanted options. Option names and values match without case or
 * punctuation ("color: black" matches "Color: Black"). Returns the best match and what did not match.
 */
export function pickTargetVariant(prod: TargetProduct, wanted: Record<string, string> | undefined, currentTcin?: string):
  { tcin?: string; options: Record<string, string>; unmatched: string[] } {
  if (!prod.variants.length) return { tcin: currentTcin ?? prod.tcin, options: {}, unmatched: Object.keys(wanted ?? {}) };
  const want = Object.entries(wanted ?? {});
  let best: TargetVariant | undefined;
  let bestScore = -1;
  for (const v of prod.variants) {
    let score = 0;
    for (const [k, val] of want) {
      const key = Object.keys(v.options).find((o) => norm(o) === norm(k));
      if (key && norm(v.options[key]) === norm(val)) score += 10;
    }
    if (v.available) score += 1;
    if (v.tcin === currentTcin) score += 2;
    if (score > bestScore) { best = v; bestScore = score; }
  }
  const unmatched = want.filter(([k, val]) => {
    const key = best && Object.keys(best.options).find((o) => norm(o) === norm(k));
    return !key || norm(best!.options[key]) !== norm(val);
  }).map(([k, val]) => `${k}: ${val}`);
  return { tcin: best?.tcin, options: best?.options ?? {}, unmatched };
}

/** cart_views / cart answer -> Cart, with a warning for every line that is not set to shipping. */
export function parseTargetCart(json: J): Cart & { itemIds: string[] } {
  const lines: CartLine[] = [];
  const warnings: string[] = [];
  const itemIds: string[] = [];
  for (const it of json?.cart_items ?? []) {
    const qty = Number(it.quantity ?? 1);
    const title = decodeEntities(it.item_attributes?.description) || `TCIN ${it.tcin}`;
    const lineTotal = usd(it.item_summary?.total_product) ?? usd((Number(it.unit_price) || 0) * qty) ?? { cents: 0, currency: "USD" };
    const ftype: string | undefined = it.fulfillment?.type;
    lines.push({
      title,
      quantity: qty,
      price: lineTotal,
      productId: it.tcin ? String(it.tcin) : undefined,
      url: it.tcin ? `${ORIGIN}/p/-/A-${it.tcin}` : undefined,
      options: ftype ? { fulfillment: ftype === "SHIP" ? "Shipping" : ftype } : undefined,
    });
    if (ftype && ftype !== "SHIP") warnings.push(`'${title}' is set to ${ftype.toLowerCase()}, not shipping`);
    if (it.cart_item_id) itemIds.push(String(it.cart_item_id));
  }
  const s = json?.summary ?? {};
  return {
    store: "target",
    storeDomain: "target.com",
    lines,
    subtotal: usd(s.total_product_amount),
    readAt: nowIso(),
    warnings,
    itemIds,
  };
}

/** Totals of a cart or checkout answer. */
export function targetTotals(json: J): { subtotal?: Money; shipping?: Money; tax?: Money; total?: Money } {
  const s = json?.summary ?? {};
  return { subtotal: usd(s.total_product_amount), shipping: usd(s.total_shipping_amount), tax: usd(s.total_tax), total: usd(s.grand_total) };
}

/**
 * Target's "Minimum not met" sheet ("Only ships with $35 orders", "Add $11.02 to your subtotal"):
 * the message for the person, or undefined when the page does not show it.
 */
export function targetShippingMinimum(text: string): string | undefined {
  if (!/Minimum not met|Only ships with \$\d+/i.test(text)) return undefined;
  const min = /Only ships with (\$[\d,.]+) orders/i.exec(text)?.[1];
  const add = /Add (\$[\d,.]+) to your subtotal/i.exec(text)?.[1];
  return `Target ships this cart only on orders of ${min ?? "its minimum"} or more${add ? ` (add ${add})` : ""}. Add items or choose Order Pickup in the live browser; the agent does not change the order on its own.`;
}

/** True when a response body is a PerimeterX block (JSON with blockScript, or the captcha page). */
export function isTargetBlock(status: number, body: string): boolean {
  if (status === 403 || status === 429 || status === 435) return /px-captcha|blockScript|perimeterx|Access to this page has been denied/i.test(body) || status === 435;
  return /"blockScript"\s*:/.test(body) && /px-cdn|perimeterx/i.test(body);
}

/** Short, non-street address: "Christiana, DE 19701". */
export function shortAddress(a: J | undefined): string | undefined {
  if (!a) return undefined;
  const city = a.city ?? a.locality;
  const st = a.state ?? a.region;
  const zip = typeof a.zip_code === "string" ? a.zip_code.slice(0, 5) : typeof a.postal_code === "string" ? a.postal_code.slice(0, 5) : undefined;
  return clean([city, [st, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "));
}

// ---------------------------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------------------------

/**
 * page.evaluate with a deadline. A wedged or crashed tab (seen live: Playwright never gets the
 * new document's context after some navigations) is replaced once with a fresh tab in the same
 * browser (ctx.newPage), which goes back to the Target page it was on.
 */
async function evalIn<R, A = undefined>(ctx: StoreContext, fn: (arg: A) => R | Promise<R>, arg?: A, ms = 30_000): Promise<R> {
  return evalWithRenew(ctx, fn, arg, {
    ms,
    reopen: async (last) => {
      await goto(ctx, onTarget(last) ? last : ORIGIN + "/");
      await ctx.page.waitForTimeout(2000);
    },
  });
}

interface FetchResult { status: number; body: string }

/** fetch() inside the Target page, so cookies and bot check tokens go with it. */
async function pageFetch(ctx: StoreContext, url: string, init?: { method?: string; body?: unknown }): Promise<FetchResult> {
  return evalIn(ctx, async ([u, method, body]) => {
    try {
      const res = await fetch(u as string, {
        method: (method as string) || "GET",
        credentials: "include",
        headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      return { status: 0, body: String((e as Error)?.message ?? e) };
    }
  }, [url, init?.method ?? "GET", init?.body ?? null] as const);
}

/**
 * page.goto that survives a navigation the page starts itself (PerimeterX reloads the page when
 * its check clears, which interrupts ours): wait for that one to settle, then go once more.
 */
async function goto(ctx: StoreContext, url: string): Promise<void> {
  try {
    await gotoRetry(ctx, url, { timeout: 60_000 });
  } catch (e) {
    if (!/interrupted by another navigation|ERR_ABORTED|frame was detached/i.test((e as Error).message)) throw e;
    await ctx.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await ctx.page.waitForTimeout(1500);
    await ctx.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
}

function onTarget(url: string): boolean {
  try { return new URL(url).hostname.endsWith("target.com") && !new URL(url).hostname.startsWith("redsky"); } catch { return false; }
}

async function pageText(ctx: StoreContext): Promise<string> {
  return evalIn(ctx, () => document.body?.innerText?.slice(0, 3000) ?? "").catch(() => "");
}

/** Target's refusal page for addresses it does not serve at all. */
const REFUSED = /Sorry for the wait|busier than we expected/i;

/** Make sure the page is a working target.com page (cookies, location, bot tokens). */
async function ensureOnTarget(ctx: StoreContext, path = "/"): Promise<void> {
  if (onTarget(ctx.page.url()) && !REFUSED.test(await pageText(ctx))) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await goto(ctx, ORIGIN + path);
    } catch (e) {
      if (attempt === 2) throw e;
      if (isDeadPageError(e) || ctx.page.isClosed() || await pageIsDead(ctx)) await replacePage(ctx, "crashed or stopped answering");
      else {
        ctx.log(`opening target.com failed (${(e as Error).message}); retrying from a blank page`);
        await ctx.page.goto("about:blank", { timeout: 15_000 }).catch(() => {});
      }
      continue;
    }
    await ctx.page.waitForTimeout(2500);
    const text = await pageText(ctx);
    if (await solvePressAndHold(ctx)) continue;
    if (!REFUSED.test(text)) return;
    ctx.log("Target shows 'Sorry for the wait'; waiting and trying once more");
    await ctx.page.waitForTimeout(8000);
  }
  throw new Error("Target refused this browser ('Sorry for the wait'). Target serves US visitors only: give the Target browser a US exit.");
}

/**
 * Target's PerimeterX "Press & hold" check: Browsa solves it in the session; elsewhere, or when
 * Browsa does not handle it, OSA holds it (see passPressAndHold in util.ts).
 */
function solvePressAndHold(ctx: StoreContext, waitMs = 0): Promise<boolean> {
  return passPressAndHold(ctx, { name: "Target", waitMs });
}

/**
 * Call a Target JSON API from the page. On a bot check block: open the blocked URL as a page,
 * hold "Press & hold", come back and retry once.
 */
async function targetApi(ctx: StoreContext, url: string, init?: { method?: string; body?: unknown }): Promise<J> {
  await ensureOnTarget(ctx);
  let r = await pageFetch(ctx, url, init);
  if (isTargetBlock(r.status, r.body)) {
    const back = ctx.page.url();
    const probe = url.includes("redsky") ? url : `${REDSKY}store_location_v1?key=${TARGET_WEB_KEY}&channel=WEB`;
    // Two tries: on a slow exit the challenge sometimes had not drawn yet (seen live 2026-11-18).
    for (let attempt = 1; attempt <= 2 && isTargetBlock(r.status, r.body); attempt++) {
      ctx.log(`Target API blocked by its bot check (HTTP ${r.status}); trying to pass it${attempt > 1 ? " again" : ""}`);
      await goto(ctx, probe).catch(() => {});
      await ctx.page.waitForTimeout(2500);
      const held = await solvePressAndHold(ctx, 12_000);
      if (!held) ctx.log("Target showed no press-and-hold button on the blocked page");
      await goto(ctx, onTarget(back) ? back : ORIGIN + "/");
      await ctx.page.waitForTimeout(2000);
      r = await pageFetch(ctx, url, init);
    }
    if (isTargetBlock(r.status, r.body)) {
      throw new Error("Target's bot check (PerimeterX press and hold) did not clear after two tries. Open the store's live view and press and hold, then retry.");
    }
  }
  if (r.status < 200 || r.status >= 300) throw new Error(`Target API ${new URL(url).pathname.split("/").pop()} answered HTTP ${r.status}: ${r.body.slice(0, 160)}`);
  if (!r.body.trim()) return {}; // e.g. cart_views before the guest has a cart: an empty cart
  try { return JSON.parse(r.body) as J; } catch { throw new Error(`Target API answered non-JSON: ${r.body.slice(0, 120)}`); }
}

interface TargetLocation { key: string; storeId: string; zip?: string; state?: string; lat?: string; lng?: string; visitorId?: string }

/** Key, visitor id, store and ZIP as the page has them (cookies set by target.com). */
async function location(ctx: StoreContext): Promise<TargetLocation> {
  await ensureOnTarget(ctx);
  // No named helper functions inside evaluate(): tsx/esbuild would wrap them in __name(), which
  // does not exist in the page.
  const loc = await evalIn(ctx, () => {
    const cookies: Record<string, string> = {};
    for (const part of document.cookie.split("; ")) {
      const i = part.indexOf("=");
      if (i > 0) cookies[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
    }
    const html = document.documentElement.innerHTML;
    const key = (html.match(/apiKey\\?"\s*:\s*\\?"([0-9a-f]{40})/) || [])[1];
    const fiats = cookies["fiatsCookie"] || ""; // DSI_2764|DSN_Christiana|DSZ_19701
    const guest = cookies["GuestLocation"] || ""; // 19701|39.66|-75.6|DE|US
    const g = guest.split("|");
    return { key, storeId: (fiats.match(/DSI_(\d+)/) || [])[1], zip: g[0] || (fiats.match(/DSZ_(\d+)/) || [])[1], lat: g[1], lng: g[2], state: g[3], visitorId: cookies["visitorId"] };
  });
  return { key: loc.key || TARGET_WEB_KEY, storeId: loc.storeId || "3991", zip: ctx.zip || loc.zip, state: loc.state, lat: loc.lat, lng: loc.lng, visitorId: loc.visitorId };
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

async function fetchPdp(ctx: StoreContext, tcin: string, loc?: TargetLocation): Promise<TargetProduct> {
  const l = loc ?? await location(ctx);
  const json = await targetApi(ctx, `${REDSKY}pdp_client_v1?${qs({
    key: l.key, channel: "WEB", tcin, store_id: l.storeId, pricing_store_id: l.storeId, zip: l.zip, state: l.state,
    latitude: l.lat, longitude: l.lng, visitor_id: l.visitorId, has_pricing_store_id: true, skip_personalized: true,
  })}`);
  if (!json?.data?.product) throw new Error(`Target has no product ${tcin}`);
  return parseTargetPdp(json);
}

async function fetchFulfillment(ctx: StoreContext, tcins: string[], loc: TargetLocation): Promise<Map<string, TargetFulfillment>> {
  if (!tcins.length) return new Map();
  const json = await targetApi(ctx, `${REDSKY}product_summary_with_fulfillment_v1?${qs({
    key: loc.key, channel: "WEB", tcins: tcins.slice(0, 28).join(","), store_id: loc.storeId, zip: loc.zip, state: loc.state,
    latitude: loc.lat, longitude: loc.lng, scheduled_delivery_store_id: loc.storeId, required_store_id: loc.storeId,
    visitor_id: loc.visitorId, paid_membership: false, base_membership: false, card_membership: false,
  })}`);
  return parseTargetFulfillment(json);
}

async function cartJson(ctx: StoreContext, key = TARGET_WEB_KEY): Promise<J> {
  return targetApi(ctx, `${CARTS}cart_views?${qs({ cart_type: "REGULAR", field_groups: "ADDRESSES,CART,CART_ITEMS,SUMMARY", key })}`);
}

/** Click at the centre of an element with real mouse events (Target's bot check watches synthetic clicks). */
async function mouseClick(ctx: StoreContext, selector: string, timeoutMs = 10_000): Promise<boolean> {
  const loc = ctx.page.locator(selector).first();
  try { await loc.waitFor({ state: "visible", timeout: timeoutMs }); } catch { return false; }
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox();
  if (!b) return false;
  await ctx.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await ctx.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  return true;
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

export const target: StoreAdapter = {
  id: "target",
  name: "Target",
  domains: ["target.com", "www.target.com"],

  searchUrl(query: string): string {
    return `${ORIGIN}/s?searchTerm=${encodeURIComponent(query)}`;
  },

  async search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
    let offers: Offer[] = [];
    let loc: TargetLocation | undefined;
    try {
      loc = await location(ctx);
      const json = await targetApi(ctx, `${REDSKY}plp_search_v2?${qs({
        key: loc.key, channel: "WEB", count: 24, default_purchasability_filter: true, include_sponsored: true,
        keyword: item.query, offset: 0, page: `/s/${item.query}`, platform: "desktop", pricing_store_id: loc.storeId,
        store_ids: loc.storeId, visitor_id: loc.visitorId, zip: loc.zip,
      })}`);
      offers = parseTargetSearch(json, item.id, Math.max(limit, 1) * 2);
    } catch (e) {
      ctx.log(`Target search API failed: ${(e as Error).message}`);
      if (/did not clear|refused this browser/.test((e as Error).message)) throw e;
    }
    if (!offers.length) offers = await searchFromPage(ctx, item, limit);
    if (!offers.length) offers = await searchWithAi(ctx, item, limit);
    offers = offers.slice(0, limit);
    // Shipping dates and stock for what we return (one call), best effort.
    if (loc && offers.length) {
      try {
        const ful = await fetchFulfillment(ctx, offers.map((o) => o.productId!).filter(Boolean), loc);
        for (const o of offers) {
          const f = ful.get(o.productId!);
          if (!f) continue;
          o.inStock = f.inStock;
          o.deliveryText = f.deliveryText;
          o.deliveryDate = f.deliveryDate;
        }
      } catch (e) { ctx.log(`Target delivery dates unavailable: ${(e as Error).message}`); }
    }
    return offers;
  },

  async details(ctx: StoreContext, offer: Offer): Promise<Offer> {
    const tcin = offer.productId ?? (offer.url.match(/A-(\d+)/) || [])[1];
    if (!tcin) throw new Error("Target offer has no TCIN");
    const loc = await location(ctx);
    const parentTcin = (offer.raw?.parentTcin as string | undefined) ?? tcin;
    const prod = await fetchPdp(ctx, parentTcin, loc);
    const out: Offer = { ...offer, raw: { ...offer.raw, parentTcin: prod.variants.length ? prod.tcin : offer.raw?.parentTcin } };
    const childPrice = prod.childPrices.get(tcin);
    if (childPrice) out.price = childPrice;
    else if (prod.price && !prod.variants.length) { out.price = prod.price; out.listPrice = prod.listPrice; out.unitPrice = prod.unitPrice ?? out.unitPrice; }
    if (prod.rating) out.rating = prod.rating;
    if (Object.keys(prod.options).length) out.variants = prod.options;
    if (!out.title && prod.title) out.title = prod.title;
    try {
      const f = (await fetchFulfillment(ctx, [tcin], loc)).get(tcin);
      if (f) { out.inStock = f.inStock; out.deliveryText = f.deliveryText; out.deliveryDate = f.deliveryDate; }
    } catch (e) { ctx.log(`Target delivery date unavailable: ${(e as Error).message}`); }
    out.seller = out.seller ?? "Target";
    return out;
  },

  async addToCart(ctx: StoreContext, offer: Offer, quantity: number, options?: Record<string, string>): Promise<Cart> {
    let tcin = offer.productId ?? (offer.url.match(/A-(\d+)/) || [])[1];
    if (!tcin) throw new Error("Target offer has no TCIN");
    const warnings: string[] = [];
    let chosen: Record<string, string> = {};
    // Options: resolve the child TCIN from the product's variant tree.
    const parentTcin = offer.raw?.parentTcin as string | undefined;
    if ((options && Object.keys(options).length) || parentTcin) {
      try {
        const prod = await fetchPdp(ctx, parentTcin ?? tcin);
        ctx.log(`product ${prod.tcin} has ${prod.variants.length} variants (${Object.keys(prod.options).join(", ") || "no options"})`);
        if (prod.variants.length) {
          const pick = pickTargetVariant(prod, options, tcin);
          if (pick.tcin) tcin = pick.tcin;
          chosen = pick.options;
          ctx.log(`options ${JSON.stringify(options ?? {})} -> TCIN ${pick.tcin} ${JSON.stringify(pick.options)}`);
          for (const u of pick.unmatched) warnings.push(`Option '${u}' is not offered; chose ${Object.entries(pick.options).map(([k, v]) => `${k}: ${v}`).join(", ") || "the listed item"}`);
        } else if (options && Object.keys(options).length) {
          warnings.push(`Target lists no options for this item; ignored ${Object.entries(options).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
        }
      } catch (e) { ctx.log(`Target options lookup failed: ${(e as Error).message}`); }
    }

    const before = parseTargetCart(await cartJson(ctx));
    const beforeQty = before.lines.filter((l) => l.productId === tcin).reduce((n, l) => n + l.quantity, 0);

    // 1) The page: choose Shipping, then Add to cart (what a person does).
    let added = false;
    if (quantity === 1) {
      try { added = await addViaPage(ctx, tcin); } catch (e) { ctx.log(`Target add from the page failed: ${(e as Error).message}`); }
      if (!added) {
        // The click may have worked even though we missed Target's answer: never add twice.
        const now = parseTargetCart(await cartJson(ctx).catch(() => ({})));
        const qty = now.lines.filter((l) => l.productId === tcin).reduce((n, l) => n + l.quantity, 0);
        if (qty >= beforeQty + quantity) { added = true; ctx.log("the page did add the item; skipping the API add"); }
      }
    }
    // 2) The cart API with the same request the page sends (shipping is the default fulfillment).
    if (!added) {
      try {
        await targetApi(ctx, `${CARTS}cart_items?${qs({ field_groups: "CART,CART_ITEMS,SUMMARY", key: TARGET_WEB_KEY })}`, {
          method: "POST",
          body: { cart_item: { item_channel_id: "10", tcin, quantity }, cart_type: "REGULAR", channel_id: "10", shopping_context: "DIGITAL" },
        });
        added = true;
      } catch (e) { ctx.log(`Target cart API add failed: ${(e as Error).message}`); }
    }
    // 3) AI fallback, once.
    if (!added) {
      await ctx.aiTask(`On target.com, open ${ORIGIN}/p/-/A-${tcin}, choose the "Shipping" fulfillment option, set quantity ${quantity} and click "Add to cart". Do not sign in and do not check out.`, { startUrl: `${ORIGIN}/p/-/A-${tcin}`, maxSteps: 12, sameBrowser: true });
    }

    const cart = await readTargetCart(ctx);
    const line = cart.lines.find((l) => l.productId === tcin);
    if (!line) cart.warnings.push(`Target cart does not show the item (TCIN ${tcin}) after adding it`);
    else {
      if (Object.keys(chosen).length) line.options = { ...chosen, ...line.options };
      if (line.quantity !== beforeQty + quantity) cart.warnings.push(`Target cart shows quantity ${line.quantity}, expected ${beforeQty + quantity}`);
    }
    cart.warnings.unshift(...warnings);
    return cart;
  },

  async readCart(ctx: StoreContext): Promise<Cart> {
    return readTargetCart(ctx);
  },

  async clearCart(ctx: StoreContext): Promise<void> {
    const cart = parseTargetCart(await cartJson(ctx));
    for (const id of cart.itemIds) {
      await targetApi(ctx, `${CARTS}cart_items/${encodeURIComponent(id)}?${qs({ cart_type: "REGULAR", field_groups: "CART,CART_ITEMS,SUMMARY", key: TARGET_WEB_KEY })}`, { method: "DELETE" });
    }
    const after = parseTargetCart(await cartJson(ctx));
    if (after.lines.length) throw new Error(`Target cart still has ${after.lines.length} line(s) after clearing`);
  },

  async reviewCheckout(ctx: StoreContext): Promise<CheckoutReview> {
    const json = await cartJson(ctx);
    const cart = parseTargetCart(json);
    if (!cart.lines.length) throw new Error("Target cart is empty");
    const totals = targetTotals(json);
    const base: CheckoutReview = {
      store: "target",
      storeDomain: "target.com",
      lines: cart.lines,
      subtotal: totals.subtotal,
      shipping: totals.shipping,
      tax: totals.tax,
      total: totals.total ?? totals.subtotal ?? { cents: 0, currency: "USD" },
      reviewedAt: nowIso(),
    };
    // Open the cart and press "Check out". Guests get Target's sign-in sheet; signed-in profiles go to /checkout.
    await goto(ctx, `${ORIGIN}/cart`);
    await ctx.page.waitForTimeout(3000);
    try {
      await solvePressAndHold(ctx);
    } catch (e) {
      if (!(e instanceof CaptchaHandoffError)) throw e;
      base.needsUser = e.handoff;
      return base;
    }
    if (!(await mouseClick(ctx, '[data-test="checkout-button"]', 15_000))) {
      await goto(ctx, `${ORIGIN}/checkout`);
    }
    const state = await waitForCheckoutState(ctx);
    if (state === "sign_in") {
      base.needsUser = await needsUser(ctx, "sign_in", "Target asks you to sign in before checkout. Sign in in the live browser, then continue.");
      return base;
    }
    if (state !== "checkout") {
      // Seen live: carts under Target's shipping minimum get a "Minimum not met" sheet, no checkout.
      const minimum = targetShippingMinimum(await pageText(ctx));
      base.needsUser = await needsUser(ctx, "other", minimum
        ?? "Target did not open its checkout page. Check the live browser.");
      return base;
    }
    // Signed in: the checkout totals come from the same cart with addresses and payment.
    const co = await checkoutJson(ctx).catch(() => json);
    const t = targetTotals(co);
    base.subtotal = t.subtotal ?? base.subtotal;
    base.shipping = t.shipping ?? base.shipping;
    base.tax = t.tax ?? base.tax;
    base.total = t.total ?? base.total;
    const addr = (co.addresses ?? []).find((a: J) => /SHIPPING/i.test(a.address_type ?? "")) ?? (co.addresses ?? [])[0];
    base.shipTo = shortAddress(addr);
    const pay = (co.payment_instructions ?? [])[0];
    if (pay?.card_details?.card_name || pay?.card_details?.card_number_last_four) {
      base.paymentHint = clean(`${pay.card_details.card_name ?? "Card"} ending ${pay.card_details.card_number_last_four ?? ""}`);
    }
    const need = await checkoutNeeds(ctx);
    if (need) base.needsUser = await needsUser(ctx, need.reason, need.message);
    return base;
  },

  async placeOrder(ctx: StoreContext, approval: Approval): Promise<OrderResult> {
    if (!/\/checkout/.test(ctx.page.url())) {
      await goto(ctx, `${ORIGIN}/checkout`);
      if ((await waitForCheckoutState(ctx)) !== "checkout") {
        return { store: "target", placed: false, needsUser: await needsUser(ctx, "sign_in", "Target needs you to sign in before the order can be placed.") };
      }
    }
    const co = await checkoutJson(ctx);
    const total = targetTotals(co).total;
    if (!total || total.cents !== approval.approvedTotal.cents || total.currency !== approval.approvedTotal.currency) {
      return {
        store: "target", placed: false, total,
        error: `Target's total is now ${total ? (total.cents / 100).toFixed(2) : "unknown"}, approved ${(approval.approvedTotal.cents / 100).toFixed(2)}`,
        confirmationText: `Not placed: Target's total is now ${total ? (total.cents / 100).toFixed(2) : "unknown"}, approved ${(approval.approvedTotal.cents / 100).toFixed(2)}.`,
      };
    }
    const need = await checkoutNeeds(ctx);
    if (need) return { store: "target", placed: false, total, needsUser: await needsUser(ctx, need.reason, need.message) };
    if (!(await mouseClick(ctx, '[data-test="placeOrderButton"], button:has-text("Place your order")', 10_000))) {
      return { store: "target", placed: false, total, needsUser: await needsUser(ctx, "other", "Target's 'Place your order' button was not found. Check the live browser.") };
    }
    const ok = await ctx.page.waitForURL(/order-confirmation|\/co-thankyou|thank/i, { timeout: 60_000 }).then(() => true).catch(() => false);
    const text = await pageText(ctx);
    const orderId = (text.match(/order\s*(?:#|number)?\s*:?\s*(\d{9,})/i) || [])[1];
    if (!ok && !orderId) {
      return { store: "target", placed: false, total, needsUser: await needsUser(ctx, "other", "Target did not confirm the order. Check the live browser before trying again.") };
    }
    return { store: "target", placed: true, orderId, total, confirmationText: clean(text.match(/thanks[^.\n]*[.!]?/i)?.[0]) ?? "Order placed", placedAt: nowIso() };
  },
};

async function readTargetCart(ctx: StoreContext): Promise<Cart> {
  const { itemIds: _ids, ...cart } = parseTargetCart(await cartJson(ctx));
  return cart;
}

async function checkoutJson(ctx: StoreContext): Promise<J> {
  return targetApi(ctx, `${CARTS}cart?${qs({ cart_type: "REGULAR", field_groups: "ADDRESSES,CART,CART_ITEMS,PAYMENT_INSTRUCTIONS,SUMMARY", key: TARGET_WEB_KEY })}`);
}

/** Wait for the sign-in sheet or the checkout page. */
async function waitForCheckoutState(ctx: StoreContext): Promise<"sign_in" | "checkout" | "unknown"> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await ctx.page.locator('#username, input[name="username"]').first().isVisible().catch(() => false)) return "sign_in";
    if (/\/login|signin/i.test(ctx.page.url())) return "sign_in";
    if (/\/checkout/.test(ctx.page.url()) && await ctx.page.locator('[data-test="placeOrderButton"], [data-test*="checkout" i]').first().isVisible().catch(() => false)) return "checkout";
    await ctx.page.waitForTimeout(500);
  }
  return /\/checkout/.test(ctx.page.url()) ? "checkout" : "unknown";
}

/** What the signed-in checkout still needs from the person (CVV, address, payment). */
async function checkoutNeeds(ctx: StoreContext): Promise<{ reason: "payment" | "address" | "verification_code"; message: string } | undefined> {
  const text = await pageText(ctx);
  if (/enter (?:the )?cvv|security code/i.test(text) && await ctx.page.locator('input[name*="cvv" i], input[id*="cvv" i]').first().isVisible().catch(() => false)) {
    return { reason: "payment", message: "Target asks for the card's security code. Enter it in the live browser." };
  }
  if (/add (?:a )?(?:shipping )?address/i.test(text)) return { reason: "address", message: "Target needs a shipping address. Add it in the live browser." };
  if (/add (?:a )?payment|add a card/i.test(text)) return { reason: "payment", message: "Target needs a payment method. Add it in the live browser." };
  return undefined;
}

/** Open the product page, choose Shipping, press Add to cart, wait for Target's cart answer. */
async function addViaPage(ctx: StoreContext, tcin: string): Promise<boolean> {
  const page = ctx.page;
  const t0 = Date.now();
  const mark = (what: string) => ctx.log(`add from page: ${what} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await goto(ctx, `${ORIGIN}/p/-/A-${tcin}`);
  await page.waitForTimeout(1500);
  if (await solvePressAndHold(ctx)) await goto(ctx, `${ORIGIN}/p/-/A-${tcin}`);
  if (REFUSED.test(await pageText(ctx))) throw new Error("Target refused the product page");
  mark("product page open");
  // Fulfillment cells are buttons with ids PICKUP, DELIVERY, SHIPPING.
  if (!(await mouseClick(ctx, "button#SHIPPING", 15_000))) throw new Error("no Shipping option on the product page");
  await page.waitForTimeout(800);
  const btn = `#addToCartButtonOrTextIdFor${tcin}`;
  const label = (await page.locator(btn).first().innerText({ timeout: 8000 }).catch(() => "")).trim();
  if (!/add to cart/i.test(label)) throw new Error(`Add button says '${label || "nothing"}' after choosing Shipping`);
  mark("shipping chosen");
  const answer = page.waitForResponse((r) => /web_checkouts\/v1\/cart_items/.test(r.url()) && r.request().method() === "POST", { timeout: 20_000 });
  if (!(await mouseClick(ctx, btn, 5000))) throw new Error("Add to cart button not clickable");
  const res = await answer.catch(() => null);
  mark(res ? `cart answered ${res.status()}` : "no cart answer");
  await page.keyboard.press("Escape").catch(() => {});
  if (!res) throw new Error("Target did not answer the add to cart");
  if (res.status() >= 300) throw new Error(`Target add to cart answered HTTP ${res.status()}`);
  return true;
}

/** Fallback: read the search page's product cards (no API). */
async function searchFromPage(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
  try {
    await goto(ctx, target.searchUrl(item.query, "target.com"));
    await ctx.page.waitForTimeout(2500);
    await solvePressAndHold(ctx);
    await ctx.page.locator('a[href*="/A-"]').first().waitFor({ timeout: 15_000 }).catch(() => {});
    const cards = await evalIn(ctx, () => {
      const out: { href: string; title: string; price: string; sponsored: boolean; rating: string }[] = [];
      const seen = new Set<string>();
      document.querySelectorAll('[data-test*="ProductCard"], [data-test="product-details"]').forEach((card) => {
        const a = card.querySelector('a[href*="/A-"]') as HTMLAnchorElement | null;
        if (!a) return;
        const tcin = (a.href.match(/A-(\d+)/) || [])[1];
        if (!tcin || seen.has(tcin)) return;
        seen.add(tcin);
        const price = (card.querySelector('[data-test="current-price"]') as HTMLElement | null)?.innerText ?? "";
        const rating = (card.querySelector('[data-test="ratings"], [data-test*="rating" i]') as HTMLElement | null)?.innerText ?? "";
        out.push({ href: a.href, title: (a.getAttribute("aria-label") || a.textContent || "").trim(), price, sponsored: /sponsored/i.test((card as HTMLElement).innerText), rating });
      });
      return out;
    });
    const offers: Offer[] = [];
    for (const c of cards) {
      const price = priceFromFormatted(c.price);
      const tcin = (c.href.match(/A-(\d+)/) || [])[1];
      if (!price || !tcin || !c.title) continue;
      offers.push({ store: "target", storeDomain: "target.com", itemId: item.id, title: decodeEntities(c.title), url: c.href.split("#")[0], productId: tcin, price, inStock: true, sponsored: c.sponsored, subscription: false, seller: "Target" });
    }
    return offers.slice(0, limit);
  } catch (e) {
    ctx.log(`Target search page fallback failed: ${(e as Error).message}`);
    return [];
  }
}

async function searchWithAi(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
  try {
    const res = await ctx.aiTask<{ products?: { title: string; url: string; price: string; rating?: number; reviews?: number; sponsored?: boolean }[] }>(
      `Search target.com for "${item.query}". Return the first ${limit} products as JSON: title, url (the product page link), price as shown, rating (stars), reviews (count), sponsored (true if marked sponsored). Do not sign in.`,
      { startUrl: target.searchUrl(item.query, "target.com"), maxSteps: 10, schema: { type: "object", properties: { products: { type: "array" } } } },
    );
    return (res?.products ?? []).flatMap((p): Offer[] => {
      const price = priceFromFormatted(p.price);
      const tcin = (p.url?.match(/A-(\d+)/) || [])[1];
      if (!price || !p.title || !p.url) return [];
      return [{ store: "target", storeDomain: "target.com", itemId: item.id, title: p.title, url: p.url, productId: tcin, price, inStock: true, sponsored: !!p.sponsored, subscription: false,
        rating: p.rating && p.reviews ? { stars: p.rating, count: p.reviews } : undefined }];
    }).slice(0, limit);
  } catch (e) {
    ctx.log(`Target AI search failed: ${(e as Error).message}`);
    return [];
  }
}

export default target;
