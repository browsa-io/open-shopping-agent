// Walmart.com (US) adapter. Search and product pages are read from the JSON Walmart embeds in
// the page (__NEXT_DATA__); the cart is read from its data-* attributes and test ids. Clicks go
// through Playwright on the Phantom page. HTML helpers come from util.ts.

import type { Page } from "playwright-core";
import type { Cart, CartLine, CheckoutReview, Money, NeedsUser, Offer, OrderResult } from "../core/types.js";
import type { StoreAdapter, StoreContext } from "./adapter.js";
import {
  aiSearchFallback, approvalMatches, CaptchaHandoffError, clean, clickFirstVisible, declineOffer, formatMoney, gotoRetry, moneyFromNumber, needsUser, nowIso,
  optionWarnings, parseDeliveryDate, parseHtml, parseMoney, passBotCheck, pickVariant, qs, qsa, shortAddress, sumLines, textOf,
  typeZip, zipNotTaken, type HNode, type VariantChoice,
} from "./util.js";

const WM = "https://www.walmart.com";
const DOMAIN = "walmart.com";

export function walmartProductUrl(id: string): string { return `${WM}/ip/${id}`; }
export function walmartIdFromUrl(url: string | undefined): string | undefined {
  return url?.match(/\/ip\/(?:[^/?#]+\/)?(\d{5,})/)?.[1];
}

/** The JSON Walmart's Next.js pages embed. */
export function walmartNextData(html: string): any {
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch { return undefined; }
}

type PriceLine = { lineType?: string; values?: { key?: string; value?: unknown }[] };
function priceLineValue(lines: PriceLine[] | undefined, types: string[], key: string): unknown {
  for (const l of lines ?? []) {
    if (!types.includes(l.lineType ?? "")) continue;
    const v = l.values?.find((x) => x.key === key);
    if (v && v.value !== undefined && v.value !== null && v.value !== false) return v.value;
  }
  return undefined;
}

/** Texts of Walmart's tile badges, e.g. "Free shipping, arrives tomorrow". */
function badgeTexts(it: any): string[] {
  const out: string[] = [];
  for (const g of it?.badges?.groupsV2 ?? []) {
    for (const m of g?.members ?? []) {
      const t = clean((m?.content ?? []).filter((c: any) => c?.type === "TEXT" && c.value).map((c: any) => c.value).join(" "));
      if (t) out.push(t);
    }
  }
  return out;
}

export function parseWalmartSearch(html: string, itemId: string, now = new Date()): Offer[] {
  const d = walmartNextData(html);
  const stacks: any[] = d?.props?.pageProps?.initialData?.searchResult?.itemStacks ?? [];
  const byId = new Map<string, Offer>();
  for (const stack of stacks) {
    for (const it of stack?.items ?? []) {
      const id = it?.usItemId ? String(it.usItemId) : undefined;
      if (!id || (it.__typename && it.__typename !== "Product")) continue;
      const lines: PriceLine[] | undefined = it.priceInfo?.priceDetails?.priceLines;
      const sns = priceLineValue(lines, ["SUBSCRIPTION_DUAL_PRICE"], "DUAL_PRICE") !== undefined || !!it.subscription?.subscriptionEligible || !!it.showSubscribe;
      const known = byId.get(id);
      if (known) {
        // The same item as an ad and as a normal result: keep one, sponsored only if never organic.
        if (known.sponsored && !it.isSponsoredFlag) known.sponsored = false;
        if (sns) known.subscribeAndSaveAvailable = true;
        continue;
      }
      const price = moneyFromNumber(priceLineValue(lines, ["CURRENT_PRICE", "DISCOUNTED_PRICE"], "PRICE"))
        ?? moneyFromNumber(it.price) ?? parseMoney(it.priceInfo?.linePrice) ?? parseMoney(it.priceInfo?.itemPrice);
      if (!price || !it.name) continue;
      const was = priceLineValue(lines, ["COMPARISON"], "WAS_PRICE") ?? it.priceInfo?.wasPrice;
      const unitRaw = priceLineValue(lines, ["UNIT_PRICE"], "UNIT_PRICE") ?? it.priceInfo?.unitPrice;
      const unitAmount = typeof unitRaw === "string" ? parseMoney(unitRaw) : undefined;
      const unitPer = typeof unitRaw === "string" ? unitRaw.split("/")[1]?.trim() : undefined;
      const badges = badgeTexts(it);
      const delivery = badges.find((t) => /^(free )?shipping|arrives/i.test(t)) ?? badges.find((t) => /delivery/i.test(t) && !/pickup/i.test(t));
      const shipping: Money | undefined = badges.some((t) => /free shipping/i.test(t)) ? { cents: 0, currency: price.currency } : parseMoney(it.priceInfo?.shipPrice || undefined);
      const raw: Record<string, unknown> = {};
      if (it.offerId) raw.offerId = it.offerId;
      if (badges.some((t) => /walmart\+|w\+/i.test(t))) raw.walmartPlusBadge = true;
      const variants: Record<string, string[]> = {};
      for (const c of it.variantCriteria ?? []) {
        const vals = (c?.variantList ?? []).map((v: any) => v?.name).filter(Boolean);
        if (c?.name && vals.length) variants[c.name] = vals;
      }
      const stars = it.rating?.averageRating ?? it.averageRating;
      const status = it.availabilityStatusV2?.value;
      const canon = typeof it.canonicalUrl === "string" ? it.canonicalUrl.split("?")[0] : undefined;
      byId.set(id, {
        store: "walmart", storeDomain: DOMAIN, itemId, title: String(it.name), productId: id,
        url: canon ? `${WM}${canon}` : walmartProductUrl(id), image: it.image ?? it.imageInfo?.thumbnailUrl,
        price, listPrice: moneyFromNumber(was), unitPrice: unitAmount && unitPer ? { amount: unitAmount, per: unitPer } : undefined,
        shipping, deliveryText: delivery, deliveryDate: parseDeliveryDate(delivery, now),
        rating: typeof stars === "number" ? { stars, count: Number(it.rating?.numberOfReviews ?? it.numberOfReviews ?? 0) } : undefined,
        seller: it.sellerName ?? undefined,
        condition: /\b(restored|refurbished)\b/i.test(it.name) ? "refurbished" : it.isPreowned ? "used" : "new",
        inStock: status ? status === "IN_STOCK" : !it.isOutOfStock,
        sponsored: !!it.isSponsoredFlag, subscription: false, ...(sns ? { subscribeAndSaveAvailable: true } : {}),
        variants: Object.keys(variants).length ? variants : undefined, raw,
      });
    }
  }
  return [...byId.values()];
}

export interface WalmartProduct {
  usItemId?: string;
  title?: string;
  price?: Money;
  listPrice?: Money;
  seller?: string;
  deliveryText?: string;
  deliveryDate?: string;
  shipping?: Money;
  inStock: boolean;
  rating?: { stars: number; count: number };
  variants?: Record<string, string[]>;
  selected?: Record<string, string>;
  variantChoices?: VariantChoice[];
  subscribeAndSave: boolean;
  orderLimit?: number;
  image?: string;
}

export function parseWalmartProduct(html: string): WalmartProduct {
  const d = walmartNextData(html);
  const p = d?.props?.pageProps?.initialData?.data?.product;
  if (!p) return { inStock: false, subscribeAndSave: false };
  const criteria: any[] = p.variantCriteria ?? [];
  const nameOf = (variantId: string): [string, string] | undefined => {
    for (const c of criteria) {
      const v = (c?.variantList ?? []).find((x: any) => x?.id === variantId);
      if (v) return [c.name, v.name];
    }
    return undefined;
  };
  const toValues = (ids: string[] | undefined) => Object.fromEntries((ids ?? []).map(nameOf).filter((x): x is [string, string] => !!x));
  let variants: Record<string, string[]> | undefined;
  let variantChoices: VariantChoice[] | undefined;
  if (criteria.length) {
    variants = Object.fromEntries(criteria.map((c) => [c.name, (c.variantList ?? []).map((v: any) => v.name)]));
    variantChoices = Object.values<any>(p.variantsMap ?? {}).filter((v) => v?.usItemId).map((v) => ({
      id: String(v.usItemId), values: toValues(v.variants), available: v.availabilityStatus ? v.availabilityStatus === "IN_STOCK" : undefined,
    }));
  }
  // Prefer the shipping label; the first one can be store pickup.
  const labels: any[] = p.fulfillmentLabel ?? [];
  const label = labels.find((l) => /SHIPPING|DELIVERY/i.test(String(l?.fulfillmentMethod ?? ""))) ?? labels.find((l) => !/pickup/i.test(String(l?.message ?? ""))) ?? labels[0];
  const deliveryText = clean(String(label?.message ?? "").replace(/\s+to\s+[A-Za-z .'-]+,\s*\d{5}\s*$/, "")) ?? undefined;
  const ship = p.shippingOption;
  const maxDate = ship?.maxDeliveryDate ?? ship?.deliveryDate;
  return {
    usItemId: p.usItemId ? String(p.usItemId) : undefined,
    title: p.name,
    price: moneyFromNumber(p.priceInfo?.currentPrice?.price),
    listPrice: moneyFromNumber(p.priceInfo?.wasPrice?.price),
    seller: p.sellerDisplayName ?? p.sellerName ?? undefined,
    deliveryText,
    deliveryDate: typeof maxDate === "string" ? maxDate.slice(0, 10) : parseDeliveryDate(deliveryText),
    shipping: moneyFromNumber(ship?.shipPrice?.price) ?? (/free shipping/i.test(deliveryText ?? "") ? { cents: 0, currency: "USD" } : undefined),
    inStock: p.availabilityStatus === "IN_STOCK",
    rating: typeof p.averageRating === "number" ? { stars: p.averageRating, count: Number(p.numberOfReviews ?? 0) } : undefined,
    variants, variantChoices, selected: criteria.length ? toValues(p.selectedVariantIds) : undefined,
    subscribeAndSave: !!(p.subscription?.subscriptionEligible || p.subscription?.showSubscriptionModule || p.subscriptionEligible),
    orderLimit: typeof p.orderLimit === "number" ? p.orderLimit : undefined,
    image: p.imageInfo?.thumbnailUrl,
  };
}

function firstMoneyText(n: HNode): Money | undefined {
  const stack: (HNode | string)[] = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (typeof x === "string") {
      const t = x.trim();
      if (/^\$[\d,]+\.\d{2}$/.test(t)) return parseMoney(t);
      continue;
    }
    if (x.tag === "script" || x.tag === "style" || /^Was\b/i.test(x.attrs["aria-label"] ?? "") || x.tag === "s" || x.tag === "del") continue;
    for (let i = x.children.length - 1; i >= 0; i--) stack.push(x.children[i]);
  }
  return undefined;
}

export function parseWalmartCart(html: string): Cart {
  const doc = parseHtml(html);
  const lines: CartLine[] = [];
  const warnings: string[] = [];
  for (const tile of qsa(doc, "[data-cart-product-tile]")) {
    const id = qs(tile, "[data-usitemid]")?.attrs["data-usitemid"];
    const title = clean(textOf(qs(tile, "[data-testid=\"productName\"]"))) ?? clean(textOf(qs(tile, "h3")));
    if (!id || !title) continue;
    const options: Record<string, string> = {};
    const desc = qs(tile, "[data-testid=\"productDescription\"]");
    const parts = desc ? qsa(desc, "div") : [];
    if (desc && !parts.length) parts.push(desc);
    for (const part of parts) {
      if (part.children.some((c) => typeof c !== "string")) continue;
      const t = textOf(part);
      const i = t.indexOf(":");
      if (i > 0) options[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    let qty: number | undefined;
    for (const a of qsa(tile, "[aria-label]")) {
      const m = /,\s*(\d+) in cart\s*$/i.exec(a.attrs["aria-label"]) ?? /Current Quantity (\d+)/i.exec(a.attrs["aria-label"]);
      if (m) { qty = parseInt(m[1], 10); break; }
    }
    // "Current price $38.99, Was $150.00" when on sale; else the first plain price that is not a was-price.
    const current = /Current price (\$[\d,]+\.\d{2})/.exec(textOf(tile));
    const price = current ? parseMoney(current[1]) : firstMoneyText(tile);
    if (!price) continue;
    const text = textOf(tile);
    if (/every \d+ (weeks?|months?)|subscription/i.test(text) && !/protection plan/i.test(text)) warnings.push(`Walmart cart line "${title.slice(0, 60)}" looks like a subscription`);
    lines.push({
      title, quantity: qty ?? 1, price, options: Object.keys(options).length ? options : undefined,
      url: walmartProductUrl(id), productId: id,
    });
  }
  let subtotal: Money | undefined;
  for (const s of qsa(doc, "span")) {
    const t = textOf(s);
    if (/^Subtotal \(\d+ items?\)$/.test(t) && s.parent) { subtotal = parseMoney(textOf(s.parent).slice(t.length)); if (subtotal) break; }
  }
  if (!subtotal && lines.length) {
    // With savings the label is a bare "Subtotal" after "Item (1) $150.00" and "Savings".
    const summary = qs(doc, "#totalSummary") ?? qs(doc, "body") ?? doc;
    const m = /\bSubtotal(?:\s*\(\d+ items?\))?\s*:?\s*(\$[\d,]+\.\d{2})/.exec(textOf(summary));
    if (m) subtotal = parseMoney(m[1]);
  }
  return { store: "walmart", storeDomain: DOMAIN, lines, subtotal: lines.length ? subtotal : { cents: 0, currency: "USD" }, readAt: nowIso(), warnings };
}

export type WalmartCheckoutState = "signin" | "captcha" | "membership_offer" | "address" | "payment" | "review" | "confirmation" | "unknown";

export function walmartCheckoutState(url: string, html: string): WalmartCheckoutState {
  if (/\/blocked\b/.test(url)) return "captcha";
  if (/identity\.walmart\.com|\/account\/login|\/account\/signup/.test(url)) return "signin";
  const doc = parseHtml(html);
  if (qs(doc, "#px-captcha")) return "captcha";
  if (/\/orders\/|thankyou|order-confirmation/i.test(url)) return "confirmation";
  const text = textOf(qs(doc, "body") ?? doc).slice(0, 20_000);
  if (/Thanks for your order|Order confirmed/i.test(text)) return "confirmation";
  if (/Try Walmart\+|Walmart\+ free for|Start (your )?free trial/i.test(text) && /No thanks|Not now|Maybe later|Continue without/i.test(text)) return "membership_offer";
  if (qs(doc, "[data-automation-id=\"place-order-button\"], button[data-testid=\"place-order-button\"]") || /\bPlace order\b/.test(text)) return "review";
  if (qs(doc, "input[name=\"addressLineOne\"], input[name=\"address1\"]") || /Add (a new |an )?address/i.test(text)) return "address";
  if (qs(doc, "input[name=\"cardNumber\"], input[autocomplete=\"cc-number\"]") || /Add a payment method|Add (a )?(credit|debit) card/i.test(text)) return "payment";
  return "unknown";
}

export function parseWalmartReview(html: string): { subtotal?: Money; shipping?: Money; tax?: Money; total?: Money; shipTo?: string; paymentHint?: string } {
  const doc = parseHtml(html);
  const t = textOf(qs(doc, "body") ?? doc);
  const last = (re: RegExp): Money | undefined => { let m: RegExpExecArray | null; let v: string | undefined; const g = new RegExp(re.source, "gi"); while ((m = g.exec(t))) v = m[1]; return v ? parseMoney(v) : undefined; };

  const pm = /(Visa|Mastercard|Discover|American Express|Amex|Walmart [A-Za-z]+ ?Card|Capital One [A-Za-z]+)\D{0,24}(\d{4})\b/.exec(t);
  return {
    subtotal: last(/Subtotal\s*\(\d+ items?\)\s*(\$[\d,]+\.\d{2})/),
    shipping: last(/Shipping\s*(Free|\$[\d,]+\.\d{2})/),
    tax: last(/(?:Est(?:imated)?\.? taxes|Taxes)\s*(\$[\d,]+\.\d{2})/),
    total: last(/(?:Estimated total|Total)\s*(\$[\d,]+\.\d{2})/),
    shipTo: shortAddress(qs(doc, "[data-testid*=\"address\"], [data-automation-id*=\"address\"]") ?? doc),
    paymentHint: pm ? `${pm[1]} ending in ${pm[2]}` : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Browser steps
// ---------------------------------------------------------------------------------------------

async function walmartBlocked(page: Page): Promise<boolean> {
  if (/\/blocked\b/.test(page.url())) return true;
  if (await page.locator("#px-captcha").count().catch(() => 0)) return true;
  return /robot or human/i.test(await page.title().catch(() => ""));
}

async function gotoWalmart(ctx: StoreContext, url: string): Promise<void> {
  await gotoRetry(ctx, url);
  await passBotCheck(ctx, "Walmart", () => walmartBlocked(ctx.page), {
    retry: () => ctx.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }),
  });
}

/**
 * The ZIP Walmart prices and delivers for, from the JSON it embeds: the page's location
 * (pageMetadata.location.postalCode, adsContext.locationContext.zipCode, seen 2026-11-18), else a
 * fulfillment postalCode. A guest gets one from the exit address (95829, Sacramento, for a non-US one).
 */
export function walmartZip(html: string): string | undefined {
  for (const re of [/"pageMetadata":\{"location":\{"postalCode":"(\d{5})/, /"locationContext":\{"zipCode":"(\d{5})/, /"location":\{"postalCode":"(\d{5})/, /"postalCode":"(\d{5})/]) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return undefined;
}

// --zip: once per browser, compare Walmart's ZIP with the run's; when they differ, type the ZIP in
// Walmart's own "Pickup or delivery?" box (no sign-in, nothing but the ZIP), load the page again
// and check. When Walmart keeps its own ZIP, the run notes and the cart say so.
// Keyed by the store context's stop signal: one per store and run, so a later run checks again.
const zipChecked = new WeakMap<AbortSignal, "ok" | string>();
async function walmartUseZip(ctx: StoreContext, url: string): Promise<void> {
  const want = ctx.zip;
  const key = ctx.signal;
  if (!want || zipChecked.has(key)) return;
  let shown = walmartZip(await ctx.page.content().catch(() => ""));
  if (!shown || shown === want) { zipChecked.set(key, "ok"); return; }
  const typed = await typeZip(ctx.page, want, {
    opener: ["[data-testid=\"gic-wrapper\"]", "button:has-text(\"Pickup or delivery\")", "[data-automation-id=\"fulfillment-banner\"]"],
    submit: ["[role=\"dialog\"] button:has-text(\"Save\")", "[role=\"dialog\"] button:has-text(\"Update\")", "[role=\"dialog\"] button:has-text(\"Apply\")"],
  }).catch(() => false);
  if (typed) {
    await gotoWalmart(ctx, url);
    shown = walmartZip(await ctx.page.content().catch(() => "")) ?? shown;
    if (shown === want) { zipChecked.set(key, "ok"); ctx.log(`Walmart: delivery ZIP set to ${want}`); return; }
  }
  const note = zipNotTaken("Walmart", want, shown);
  zipChecked.set(key, note);
  ctx.log(note);
}

async function readWalmartCart(ctx: StoreContext): Promise<Cart> {
  await gotoWalmart(ctx, `${WM}/cart`);
  await walmartUseZip(ctx, `${WM}/cart`);
  await ctx.page.waitForSelector("[data-testid=\"productName\"], [data-automation-id=\"checkout\"]", { timeout: 15_000 }).catch(() => undefined);
  await ctx.page.waitForTimeout(800);
  let cart = parseWalmartCart(await ctx.page.content());
  if (cart.lines.length && !cart.subtotal) {
    // The order summary renders after the items.
    await ctx.page.waitForSelector("#totalSummary", { timeout: 8000 }).catch(() => undefined);
    await ctx.page.waitForTimeout(1000);
    cart = parseWalmartCart(await ctx.page.content());
  }
  const zipNote = ctx.zip ? zipChecked.get(ctx.signal) : undefined;
  if (zipNote && zipNote !== "ok") cart.warnings.push(zipNote);
  return cart;
}

async function loadWalmartProduct(ctx: StoreContext, id: string): Promise<WalmartProduct> {
  await gotoWalmart(ctx, walmartProductUrl(id));
  await ctx.page.waitForSelector("#__NEXT_DATA__", { state: "attached", timeout: 15_000 }).catch(() => undefined);
  return parseWalmartProduct(await ctx.page.content());
}

async function walmartCheckoutReview(ctx: StoreContext): Promise<CheckoutReview> {
  const cart = await readWalmartCart(ctx);
  if (!cart.lines.length) throw new Error("Walmart cart is empty");
  const page = ctx.page;
  const base = { lines: cart.lines, subtotal: cart.subtotal, total: cart.subtotal ?? sumLines(cart.lines) };
  const stop = async (reason: NeedsUser["reason"], message: string): Promise<CheckoutReview> => ({
    store: "walmart", storeDomain: DOMAIN, ...base, needsUser: await needsUser(ctx, reason, message), reviewedAt: nowIso(),
  });
  if (!(await clickFirstVisible(page, ["[data-automation-id=\"checkout\"]", "button:has-text(\"Continue to checkout\")"]))) {
    throw new Error("Walmart: Continue to checkout button not found");
  }
  let declined = 0;
  for (let step = 0; step < 8; step++) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const state = walmartCheckoutState(page.url(), await page.content());
    ctx.log(`Walmart checkout: ${state}`);
    switch (state) {
      case "signin": return stop("sign_in", "Walmart asks you to sign in or create an account. Open the live link, sign in, then run checkout again.");
      case "captcha":
        try { await passBotCheck(ctx, "Walmart", () => walmartBlocked(page)); } catch (e) {
          if (e instanceof CaptchaHandoffError) return { store: "walmart", storeDomain: DOMAIN, ...base, needsUser: e.handoff, reviewedAt: nowIso() };
          throw e;
        }
        continue;
      case "membership_offer":
        if (declined++ < 3 && await declineOffer(page, ["button:has-text(\"No thanks\")", "button:has-text(\"Not now\")", "button:has-text(\"Maybe later\")"])) continue;
        return stop("other", "Walmart shows a Walmart+ offer that could not be declined safely. Open the live link and decline it.");
      case "address": return stop("address", "Walmart needs a delivery address. Open the live link and add it.");
      case "payment": return stop("payment", "Walmart needs a payment method. Open the live link and add one.");
      case "review": {
        const r = parseWalmartReview(await page.content());
        if (!r.total) return stop("other", "Walmart's order review did not show a total. Open the live link to check it.");
        return { store: "walmart", storeDomain: DOMAIN, lines: cart.lines, ...r, total: r.total, reviewedAt: nowIso() };
      }
      default: continue;
    }
  }
  return stop("other", "Walmart checkout showed a page the agent does not know. Open the live link to continue.");
}

const adapter: StoreAdapter = {
  id: "walmart",
  name: "Walmart",
  domains: ["walmart.com", "www.walmart.com"],

  searchUrl(query: string): string {
    return `${WM}/search?q=${encodeURIComponent(query).replace(/%20/g, "+")}`;
  },

  async search(ctx, item, limit) {
    const url = this.searchUrl(item.query, DOMAIN);
    await gotoWalmart(ctx, url);
    await ctx.page.waitForSelector("#__NEXT_DATA__", { state: "attached", timeout: 15_000 }).catch(() => undefined);
    await walmartUseZip(ctx, url);
    let offers = parseWalmartSearch(await ctx.page.content(), item.id);
    if (!offers.length) {
      // Sometimes the page comes back without its data; load it once more before the AI fallback.
      ctx.log(`Walmart: no results parsed on "${await ctx.page.title().catch(() => "")}", loading the search again`);
      await gotoWalmart(ctx, url);
      await ctx.page.waitForSelector("#__NEXT_DATA__", { state: "attached", timeout: 15_000 }).catch(() => undefined);
      offers = parseWalmartSearch(await ctx.page.content(), item.id);
    }
    if (!offers.length) offers = await aiSearchFallback(ctx, { store: "walmart", domain: DOMAIN, url, item, limit, idHint: "the number after /ip/", productId: (u) => u?.match(/\/ip\/(?:[^/]+\/)?(\d+)/)?.[1], productUrl: walmartProductUrl });
    return offers.slice(0, limit);
  },

  async details(ctx, offer) {
    const id = offer.productId ?? walmartIdFromUrl(offer.url);
    if (!id) return offer;
    const p = await loadWalmartProduct(ctx, id);
    const raw = { ...(offer.raw ?? {}) };
    if (p.variantChoices) raw.variantChoices = p.variantChoices;
    if (p.selected) raw.selectedOptions = p.selected;
    if (p.orderLimit) raw.orderLimit = p.orderLimit;
    return {
      ...offer,
      title: p.title ?? offer.title,
      productId: p.usItemId ?? offer.productId,
      price: p.price ?? offer.price,
      listPrice: p.listPrice ?? offer.listPrice,
      seller: p.seller ?? offer.seller,
      deliveryText: p.deliveryText ?? offer.deliveryText,
      deliveryDate: p.deliveryDate ?? offer.deliveryDate,
      shipping: p.shipping ?? offer.shipping,
      rating: p.rating ?? offer.rating,
      inStock: p.inStock,
      variants: p.variants ?? offer.variants,
      subscription: false,
      ...(p.subscribeAndSave || offer.subscribeAndSaveAvailable ? { subscribeAndSaveAvailable: true } : {}),
      raw,
    };
  },

  async addToCart(ctx, offer, quantity, options) {
    const page = ctx.page;
    const id0 = offer.productId ?? walmartIdFromUrl(offer.url);
    if (!id0) throw new Error("Walmart offer has no item id");
    let prod = await loadWalmartProduct(ctx, id0);
    let target = prod.usItemId ?? id0;
    const wanted = options && Object.keys(options).length ? options : undefined;
    const warnings: string[] = [];
    if (wanted) {
      if (!prod.variantChoices?.length) {
        warnings.push(`Walmart shows no options for ${target}; asked for ${Object.entries(wanted).map(([k, v]) => `${k} "${v}"`).join(", ")}`);
      } else {
        const pick = pickVariant(prod.variantChoices, wanted);
        if (!pick.id) throw new Error(`Walmart: ${pick.reason}`);
        if (pick.id !== prod.usItemId) { target = pick.id; prod = await loadWalmartProduct(ctx, target); }
        if (prod.usItemId !== target) warnings.push(`Walmart opened ${prod.usItemId ?? "another item"} instead of ${target}`);
        warnings.push(...optionWarnings("Walmart product page", wanted, prod.selected).map((w) => w.replace("did not stick", "is not selected")));
      }
    }
    if (prod.orderLimit && quantity > prod.orderLimit) warnings.push(`Walmart allows at most ${prod.orderLimit} of this item`);
    // One-time purchase when the page offers a subscription.
    if (prod.subscribeAndSave) await clickFirstVisible(page, ["label:has-text(\"One-time purchase\")", "input[value=\"ONE_TIME\"]", "[data-testid*=\"one-time\"]"]);
    const atc = page.locator("[data-automation-id=\"atc\"]").first();
    let clicked = false;
    if (await atc.count() && await atc.isVisible().catch(() => false)) {
      await atc.click({ timeout: 10_000 });
      clicked = true;
      await page.waitForTimeout(3000);
      await clickFirstVisible(page, ["button:has-text(\"No thanks\")", "[aria-label=\"Close dialog\"]", "button[aria-label=\"Close\"]"]);
    }
    let cart = await readWalmartCart(ctx);
    let line = cart.lines.find((l) => l.productId === target);
    if (!line && !clicked) {
      const opt = wanted ? ` with ${Object.entries(wanted).map(([k, v]) => `${k} "${v}"`).join(", ")}` : "";
      await ctx.aiTask(
        `On ${walmartProductUrl(target)}, add ${quantity} of this exact item${opt} to the cart as a one-time purchase. ` +
        `Decline Walmart+, trials and protection plans. Do not check out.`,
        { startUrl: walmartProductUrl(target), maxSteps: 12, sameBrowser: true },
      ).catch((e: Error) => ctx.log(`Walmart AI add-to-cart failed: ${e.message}`));
      cart = await readWalmartCart(ctx);
      line = cart.lines.find((l) => l.productId === target);
    }
    if (line && line.quantity < quantity) {
      for (let q = line.quantity; q < quantity; q++) {
        const ok = await clickFirstVisible(page, [`button[data-testid="quantity-stepper-inc-button"][data-dca-extras*="${target}"]`]);
        if (!ok) break;
        await page.waitForTimeout(2000);
      }
      cart = await readWalmartCart(ctx);
      line = cart.lines.find((l) => l.productId === target);
    }
    cart.warnings.push(...warnings);
    if (!line) { cart.warnings.push(`Walmart cart does not show ${target} after adding it`); return cart; }
    if (line.quantity !== quantity) cart.warnings.push(`Walmart cart has quantity ${line.quantity}, wanted ${quantity}`);
    if (wanted && prod.variantChoices?.length) {
      // The item id is the variant, so a cart line with the target id has the wanted options even when
      // the cart does not list every one of them.
      cart.warnings.push(...optionWarnings("Walmart", wanted, line.options).filter((w) => !(line!.productId === target && /does not show option/.test(w))));
    }
    const unit = Math.round(line.price.cents / line.quantity);
    const expected = target !== (offer.productId ?? id0) ? prod.price : offer.price;
    if (expected && unit !== expected.cents) cart.warnings.push(`Walmart cart price ${formatMoney({ cents: unit, currency: line.price.currency })} differs from the product page price ${formatMoney(expected)}`);
    return cart;
  },

  readCart: readWalmartCart,

  async clearCart(ctx) {
    await readWalmartCart(ctx);
    for (let i = 0; i < 30; i++) {
      const loc = ctx.page.getByRole("button", { name: /^Remove\b/i });
      if (!(await loc.count().catch(() => 0))) break;
      await loc.first().click({ timeout: 8000 }).catch(() => undefined);
      await ctx.page.waitForTimeout(2000);
    }
  },

  reviewCheckout: walmartCheckoutReview,

  async placeOrder(ctx, approval) {
    if (approval.store !== "walmart") throw new Error("approval is for another store");
    const review = await walmartCheckoutReview(ctx);
    if (review.needsUser) return { store: "walmart", placed: false, needsUser: review.needsUser };
    if (!approvalMatches(review.total, approval)) {
      return { store: "walmart", placed: false, total: review.total, error: `Walmart total is now ${formatMoney(review.total)}, approved ${formatMoney(approval.approvedTotal)}; order not placed` };
    }
    const page = ctx.page;
    const clicked = await clickFirstVisible(page, ["[data-automation-id=\"place-order-button\"]", "button[data-testid=\"place-order-button\"]", "button:has-text(\"Place order\")"], 15_000);
    if (!clicked) throw new Error("Walmart: Place order button not found; order not placed");
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      const state = walmartCheckoutState(page.url(), await page.content());
      if (state === "confirmation") {
        const body = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
        return {
          store: "walmart", placed: true, orderId: /Order\s*#\s*([\d-]{6,})/i.exec(body)?.[1], total: review.total,
          confirmationText: clean(/(Thanks for your order!?|Order confirmed\.?)/i.exec(body)?.[1]), placedAt: nowIso(),
        } satisfies OrderResult;
      }
      if (/verify|3-D Secure|authentication/i.test(await page.title().catch(() => ""))) {
        return { store: "walmart", placed: false, needsUser: await needsUser(ctx, "3ds", "Your bank asks to verify the payment. Open the live link.") };
      }
    }
    return { store: "walmart", placed: false, needsUser: await needsUser(ctx, "other", "Walmart did not show an order confirmation. Open the live link to check before trying again.") };
  },
};

export default adapter;
