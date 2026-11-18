// eBay (ebay.com, US). Direct code first: search results, item pages, the cart and guest checkout are
// read from the page HTML (stable data-test-id / data-listingid attributes, JSON-LD and the item
// page's embedded MSKU variation model). ctx.aiTask() is a fallback, at most once per stage.
//
// Rules this adapter keeps: Buy It Now only (auction-only listings are skipped and never added),
// new condition by default, variations chosen and verified in the cart, never signs in, never types
// contact, address or card details. Guest checkout stops with `needsUser` and a Phantom Live link.

import type { Approval, Cart, CartLine, CheckoutReview, ItemRequest, Money, Offer, OrderResult } from "../core/types.js";
import type { StoreAdapter, StoreContext } from "./adapter.js";
import {
  attr, browsaSolves, clean, elementAt, elementsWith, firstWith, jsonAfterMarker as jsonAfter, jsonLd, moneyFromNumeric as moneyFromNumber,
  isDeadPageError, needsUser, nowIso, pageIsDead, parseCount, parseMoney, replacePage, sameOption, textLines, textOfHtml as textOf,
} from "./util.js";

const DOMAIN = "ebay.com";
const HOME = "https://www.ebay.com/";
const CART_URL = "https://cart.ebay.com/";

// ---------------------------------------------------------------------------------------------
// Small eBay helpers (the string HTML helpers live in util.ts)
// ---------------------------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The last "Nov 20" style date in a delivery text, as an ISO date (year inferred from `now`). */
export function lastDate(text: string | undefined, now = new Date()): string | undefined {
  if (!text) return undefined;
  const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return undefined;
  const month = MONTHS.indexOf(last[1].slice(0, 3).toLowerCase());
  let year = now.getUTCFullYear();
  if (month < now.getUTCMonth() - 6) year++;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(+last[2]).padStart(2, "0")}`;
}

export function sleep(ctx: StoreContext, ms: number) { return ctx.page.waitForTimeout(ms); }

// ---------------------------------------------------------------------------------------------
// Parsers (exported for unit tests)
// ---------------------------------------------------------------------------------------------

export type EbayCondition = "new" | "used" | "refurbished";

export function conditionOf(text: string | undefined): EbayCondition | undefined {
  if (!text) return undefined;
  if (/refurb|renewed|remanufactured/i.test(text)) return "refurbished";
  if (/pre-?owned|used|open box|for parts/i.test(text)) return "used";
  if (/\bnew\b/i.test(text)) return "new";
  return undefined;
}

/** What eBay's search filters on: one condition, used or refurbished ("not_new"), or any. */
export type EbaySearchCondition = EbayCondition | "not_new" | "any";

/** Filter id of eBay's condition facet. */
const CONDITION_IDS: Record<Exclude<EbaySearchCondition, "any">, string> = {
  new: "1000", refurbished: "2000|2010|2020|2030|2500", used: "3000", not_new: "3000|2000|2010|2020|2030|2500",
};

export function searchUrlFor(query: string, opts: { zip?: string; condition?: EbaySearchCondition } = {}): string {
  const p = new URLSearchParams({ _nkw: query, _sacat: "0", _from: "R40", LH_BIN: "1" });
  const c = opts.condition ?? "new";
  if (c !== "any") p.set("LH_ItemCondition", CONDITION_IDS[c]);
  if (opts.zip) { p.set("_stpos", opts.zip); p.set("_fcid", "1"); }
  return `https://www.ebay.com/sch/i.html?${p.toString()}`;
}

export interface SellerInfo { name?: string; positivePercent?: number; feedbackCount?: number }

/** "wishmedeals 99.7% positive (9.7K)" or ["acemagic-direct", "99.9% positive (1.4K)"]. */
export function parseSeller(lines: string[]): SellerInfo | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(.*?)\s*(\d{1,3}(?:\.\d)?)% positive(?: feedback)?(?:\s*\(([\d.,]+[KkMm]?)\))?/.exec(lines[i]);
    if (!m) continue;
    let name = clean(m[1]);
    let feedbackCount = m[3] ? parseCount(m[3]) : undefined;
    for (let j = i - 1; !name && j >= 0 && j >= i - 3; j--) {
      const l = lines[j];
      if (/^\(?[\d.,]+[KkMm]?\)?$/.test(l)) { feedbackCount ??= parseCount(l); continue; }
      if (!/[$%]/.test(l)) name = l;
    }
    return { name, positivePercent: parseFloat(m[2]), feedbackCount };
  }
  return undefined;
}

function sellerText(s: SellerInfo | undefined): string | undefined {
  if (!s?.name) return undefined;
  const fb = [s.positivePercent !== undefined ? `${s.positivePercent}% positive` : "", s.feedbackCount !== undefined ? `${s.feedbackCount} ratings` : ""].filter(Boolean).join(", ");
  return fb ? `${s.name} (${fb})` : s.name;
}

/** Shipping cost from "Free delivery", "+$5.99 delivery", "+$4.25 shipping"; undefined when unknown. */
export function parseShipping(text: string | undefined): Money | undefined {
  if (!text) return undefined;
  if (/free (delivery|shipping)|^free\b/i.test(text)) return { cents: 0, currency: "USD" };
  const m = /\+?\s*(\$[\d,]+(?:\.\d{2})?)\s*(delivery|shipping)/i.exec(text);
  return m ? parseMoney(m[1]) : undefined;
}

/** Search results page -> offers (Buy It Now only; auctions and placeholder cards skipped). */
export function parseSearch(html: string, itemId: string, now = new Date()): Offer[] {
  const offers: Offer[] = [];
  const seen = new Set<string>();
  const re = /<li\b[^>]*\bdata-listingid="(\d+)"[^>]*>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const id = m[1];
    if (seen.has(id)) continue;
    const card = elementAt(html, m.index);
    const lines = textLines(card);
    const heading = firstWith(card, `role="heading"`);
    const title = clean(textLines(heading ?? "").filter((l) => !/^new listing$|opens in a new window/i.test(l)).join(" "));
    if (!title || /^shop on ebay$/i.test(title)) continue;
    const text = lines.join(" | ");
    // Auctions: any bid count or "Time left" means the price shown is a bid, not a Buy It Now price.
    if (/\b\d+ bids?\b|\btime left\b|\bplace bid\b/i.test(text)) continue;
    const priceEl = firstWith(card, `s-card__price`);
    const priceText = textOf(priceEl) ?? lines.find((l) => /^\$[\d,.]+/.test(l));
    const price = parseMoney(priceText);
    if (!price) continue;
    const range = /\bto\b/.test(text.slice(text.indexOf(priceText ?? "$"), text.indexOf(priceText ?? "$") + 40));
    const condLine = textOf(firstWith(card, `s-card__subtitle`)) ?? lines.find((l) => /brand new|pre-owned|refurbished|open box|used/i.test(l));
    const condition = conditionOf(condLine);
    const strike = textOf(firstWith(card, `strikethrough`));
    const shipLine = lines.find((l) => /delivery|shipping/i.test(l) && !/located in/i.test(l));
    const seller = parseSeller(lines);
    const ratingLine = lines.find((l) => /out of 5 stars/i.test(l));
    const ratingCount = lines.find((l) => /product ratings?/i.test(l));
    const href = attr(firstWith(card, `href="https://www.ebay.com/itm/`), "href");
    const img = /<img[^>]*src="(https:\/\/i\.ebayimg\.com\/[^"]+)"/.exec(card)?.[1];
    seen.add(id);
    offers.push({
      store: "ebay",
      storeDomain: DOMAIN,
      itemId,
      title,
      url: href ? href.split("?")[0] : `https://www.ebay.com/itm/${id}`,
      productId: id,
      image: img,
      price,
      listPrice: strike ? parseMoney(strike) : undefined,
      shipping: parseShipping(shipLine),
      deliveryText: clean(shipLine && !/not specified/i.test(shipLine) ? shipLine : undefined),
      deliveryDate: lastDate(shipLine, now),
      rating: ratingLine ? { stars: parseFloat(ratingLine), count: parseCount(ratingCount) ?? 0 } : undefined,
      seller: sellerText(seller),
      condition,
      inStock: true,
      raw: {
        buyItNow: true,
        bestOffer: /or best offer/i.test(text),
        priceRange: range || undefined,
        sellerName: seller?.name,
        sellerPositivePercent: seller?.positivePercent,
        sellerFeedbackCount: seller?.feedbackCount,
        located: lines.find((l) => /^located in/i.test(l)),
      },
    });
  }
  return offers;
}

/** eBay's multi-variation (MSKU) model, as embedded in the item page. */
export interface Msku {
  menus: { id: number; label: string; values: { id: number; name: string; outOfStock: boolean }[] }[];
  combinations: Record<string, number>;          // "0" or "3_7" -> variation id
  prices: Record<string, Money | undefined>;      // variation id -> price
  inStock: Record<string, boolean>;               // variation id -> can be bought
}

export function parseMsku(html: string): Msku | undefined {
  const raw = jsonAfter(html, `"MSKU":`) as any;
  if (!raw || !Array.isArray(raw.selectMenus) || !raw.selectMenus.length) return undefined;
  const items = raw.menuItemMap ?? {};
  const menus = raw.selectMenus.map((m: any) => ({
    id: m.id,
    label: String(m.displayLabel ?? ""),
    values: (m.menuItemValueIds ?? []).map((v: number) => ({ id: v, name: String(items[v]?.valueName ?? items[v]?.displayName ?? v), outOfStock: !!items[v]?.outOfStock })),
  }));
  const prices: Record<string, Money | undefined> = {};
  const inStock: Record<string, boolean> = {};
  for (const [vid, v] of Object.entries<any>(raw.variationsMap ?? {})) {
    const p = v?.binModel?.price?.value;
    prices[vid] = p ? moneyFromNumber(p.value, p.currency ?? "USD") : undefined;
    inStock[vid] = v?.quantity?.outOfStock !== true;
  }
  return { menus, combinations: raw.variationCombinations ?? {}, prices, inStock };
}

/** The variation id for chosen value ids (eBay keys combinations by value ids joined with "_"). */
export function variationFor(msku: Msku, valueIds: number[]): number | undefined {
  const keys = [valueIds.join("_"), [...valueIds].sort((a, b) => a - b).join("_")];
  for (const k of keys) if (msku.combinations[k] !== undefined) return msku.combinations[k];
  return undefined;
}

/** Match the user's options to the listing's menus. Returns chosen values and problems. */
export function matchOptions(msku: Msku, options: Record<string, string> = {}): { chosen: { menu: Msku["menus"][number]; value: Msku["menus"][number]["values"][number] }[]; problems: string[] } {
  const chosen: { menu: Msku["menus"][number]; value: Msku["menus"][number]["values"][number] }[] = [];
  const problems: string[] = [];
  const entries = Object.entries(options).filter(([k]) => k.toLowerCase() !== "condition");
  for (const menu of msku.menus) {
    const label = menu.label.toLowerCase();
    let wanted = entries.find(([k]) => label.includes(k.toLowerCase()) || k.toLowerCase().includes(label))?.[1];
    if (wanted === undefined) wanted = entries.map(([, v]) => v).find((v) => menu.values.some((x) => sameOption(x.name, v)));
    const inStock = menu.values.filter((v) => !v.outOfStock);
    if (wanted === undefined) {
      if (inStock.length === 1) { chosen.push({ menu, value: inStock[0] }); continue; }
      problems.push(`choose ${menu.label}: ${menu.values.map((v) => v.name).join(", ")}`);
      continue;
    }
    const value = menu.values.find((v) => sameOption(v.name, wanted!)) ?? menu.values.find((v) => v.name.toLowerCase().includes(wanted!.toLowerCase()));
    if (!value) { problems.push(`${menu.label} "${wanted}" is not offered (${menu.values.map((v) => v.name).join(", ")})`); continue; }
    if (value.outOfStock) { problems.push(`${menu.label} "${value.name}" is out of stock`); continue; }
    chosen.push({ menu, value });
  }
  // Some value pairs do not exist together (e.g. "AAA" only comes in 12 and 24 packs).
  if (!problems.length && chosen.length === msku.menus.length && chosen.length) {
    const vid = variationFor(msku, chosen.map((c) => c.value.id));
    const names = chosen.map((c) => `${c.menu.label} "${c.value.name}"`).join(" + ");
    if (vid === undefined) problems.push(`${names} is not offered together`);
    else if (msku.inStock[String(vid)] === false) problems.push(`${names} is out of stock`);
  }
  return { chosen, problems };
}

/** The buyable option combinations, by menu label (for the engine and the UI). */
export function buyableCombos(msku: Msku, max = 40): Record<string, string>[] {
  const byId = new Map<number, { label: string; name: string }>();
  for (const m of msku.menus) for (const v of m.values) byId.set(v.id, { label: m.label, name: v.name });
  const out: Record<string, string>[] = [];
  for (const [key, vid] of Object.entries(msku.combinations)) {
    if (msku.inStock[String(vid)] === false) continue;
    const combo: Record<string, string> = {};
    for (const id of key.split("_").map(Number)) { const x = byId.get(id); if (x) combo[x.label] = x.name; }
    if (Object.keys(combo).length === msku.menus.length) out.push(combo);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Choose the options to buy from the combinations eBay sells (offer.raw.variationCombos): the
 * first combination that agrees with every wanted option (by menu label, else by value). Wanted
 * options that are not menus of the listing ("condition") are ignored. Among the combinations that
 * fit, `price` (cents of a combination, from the listing) prefers the one at `offerCents` (the price
 * the user compared), else the cheapest. Returns the full combination, or a problem naming what is sold.
 */
export function chooseCombo(
  combos: Record<string, string>[], wanted: Record<string, string> = {},
  price?: { of: (combo: Record<string, string>) => number | undefined; offerCents?: number },
): { combo?: Record<string, string>; problem?: string } {
  if (!combos.length) return { problem: "eBay sells no combination of this listing's options right now" };
  const labels = Object.keys(combos[0]);
  const want = Object.entries(wanted).filter(([k]) => k.toLowerCase() !== "condition");
  // Whole words only: "5 ft" must not match "15 ft".
  const same = (a: string, b: string) => sameOption(a, b) || new RegExp(`(^|[^a-z0-9])${b.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(a.toLowerCase());
  const relevant = want.filter(([k, v]) => labels.some((l) => l.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(l.toLowerCase()))
    || combos.some((c) => Object.values(c).some((x) => same(x, v))));
  const fits = (c: Record<string, string>) => relevant.every(([k, v]) => {
    const label = labels.find((l) => l.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(l.toLowerCase()));
    return label ? same(c[label], v) : Object.values(c).some((x) => same(x, v));
  });
  const fitting = combos.filter(fits);
  let hit = fitting[0];
  if (price && fitting.length > 1) {
    const priced = fitting.map((c) => ({ c, cents: price.of(c) }));
    hit = priced.find((p) => price.offerCents !== undefined && p.cents === price.offerCents)?.c
      ?? priced.filter((p) => p.cents !== undefined).sort((a, b) => a.cents! - b.cents!)[0]?.c ?? hit;
  }
  if (hit) return { combo: { ...hit } };
  const sold = combos.slice(0, 8).map((c) => Object.values(c).join(" / ")).join("; ");
  return { problem: `${relevant.map(([k, v]) => `${k} "${v}"`).join(" + ")} is not sold; eBay sells: ${sold}${combos.length > 8 ? "; ..." : ""}` };
}

export interface EbayItem {
  title?: string;
  price?: Money;
  condition?: EbayCondition;
  conditionText?: string;
  inStock: boolean;
  shipping?: Money;
  deliveryText?: string;
  seller?: SellerInfo;
  buyItNow: boolean;
  auctionOnly: boolean;
  msku?: Msku;
}

export function parseItem(html: string): EbayItem {
  const product = jsonLd(html).find((x) => x["@type"] === "Product");
  const offer = Array.isArray(product?.offers) ? product!.offers[0] : product?.offers;
  const title = clean(textOf(firstWith(html, `x-item-title__mainTitle`))) ?? clean(product?.name);
  const binEl = firstWith(html, `x-bin-price__content`) ?? firstWith(html, `x-price-primary`);
  const price = moneyFromNumber(offer?.price, offer?.priceCurrency ?? "USD") ?? parseMoney(textOf(binEl));
  const condEl = textLines(firstWith(html, `x-item-condition-text`) ?? "")[0];
  const ld = String(offer?.itemCondition ?? "");
  const condition = /NewCondition/.test(ld) ? "new" : /Refurbished/.test(ld) ? "refurbished" : /UsedCondition|Damaged/.test(ld) ? "used" : conditionOf(condEl);
  const shipLines = textLines(firstWith(html, `ux-labels-values--shipping`) ?? "");
  const shipText = clean(shipLines.filter((l) => !/^shipping:?$/i.test(l) && !/see details|^for shipping$|^\.$/i.test(l)).slice(0, 4).join(" "))?.replace(/\s+\./g, ".");
  const ldShip = offer?.shippingDetails?.[0]?.shippingRate?.value;
  const sellerCard = firstWith(html, `data-testid="x-sellercard-atf"`) ?? "";
  const sLines = textLines(sellerCard);
  let seller = parseSeller(sLines);
  if (!seller && sLines.length) seller = { name: sLines[0] };
  const buyItNow = /id="binBtn_btn(_\d+)?"/.test(html) || /\/atc\/binctr\?/.test(html);
  const hasBid = /id="bidBtn_btn(_\d+)?"/.test(html) || /Place bid/i.test(textOf(firstWith(html, `x-buybox-cta`) ?? "") ?? "");
  const availability = String(offer?.availability ?? "");
  return {
    title,
    price,
    condition,
    conditionText: condEl,
    inStock: availability ? /InStock|LimitedAvailability/i.test(availability) : buyItNow,
    shipping: moneyFromNumber(ldShip) ?? parseShipping(shipText),
    deliveryText: shipText,
    seller,
    buyItNow,
    auctionOnly: hasBid && !buyItNow,
    msku: parseMsku(html),
  };
}

/** Cart page -> lines and subtotal. */
export type EbayCartLine = CartLine & { variationId?: string };

export function parseCart(html: string): { store: "ebay"; storeDomain: string; lines: EbayCartLine[]; subtotal?: Money } {
  const lines: EbayCartLine[] = [];
  for (const el of elementsWith(html, `data-test-id="list-summary"`)) {
    let info: any = {};
    try { info = JSON.parse(attr(el, "data-test-info") ?? "{}"); } catch { /* keep empty */ }
    const link = firstWith(el, `data-test-id="cart-item-link"`);
    const title = textOf(link) ?? textOf(firstWith(el, `item-title`)) ?? "";
    const varText = textLines(firstWith(el, `class="item-variations"`) ?? "");
    const options: Record<string, string> = {};
    for (const v of varText.join(", ").split(/,\s*/).filter(Boolean)) {
      const kv = /^([^:]+):\s*(.+)$/.exec(v);
      if (kv) options[kv[1].trim()] = kv[2].trim(); else options[`option${Object.keys(options).length ? Object.keys(options).length + 1 : ""}`] = v.trim();
    }
    const qtyTag = /<input[^>]*aria-label="Quantity"[^>]*>/.exec(el)?.[0] ?? /<select[^>]*aria-label="Quantity"[^>]*>[\s\S]*?selected[^>]*>(\d+)/.exec(el)?.[0];
    const qty = parseInt(attr(qtyTag, "value") ?? /selected[^>]*>(\d+)/.exec(qtyTag ?? "")?.[1] ?? "1", 10);
    const price = parseMoney(textOf(firstWith(el, `class="item-price`)));
    if (!price) continue;
    lines.push({
      title,
      quantity: Number.isFinite(qty) ? qty : 1,
      price,
      options: Object.keys(options).length ? options : undefined,
      url: attr(link, "href")?.split("?")[0],
      productId: info.itemId ? String(info.itemId) : undefined,
      variationId: info.varId ? String(info.varId) : undefined,
    });
  }
  const sub = parseMoney(textOf(firstWith(html, `data-test-id="SUBTOTAL"`))) ?? parseMoney(textOf(firstWith(html, `data-test-id="ITEM_TOTAL"`)));
  return { store: "ebay", storeDomain: DOMAIN, lines, subtotal: lines.length ? sub : undefined };
}

export interface EbayCheckout {
  lines: CartLine[];
  subtotal?: Money;
  shipping?: Money;
  tax?: Money;
  total?: Money;
  needs?: "address" | "payment" | "sign_in";
  confirmEnabled: boolean;
  shipTo?: string;
  paymentHint?: string;
}

/** pay.ebay.com review page. */
export function parseCheckout(html: string): EbayCheckout {
  const lines: CartLine[] = [];
  for (const el of elementsWith(html, `data-test-id="CART_DETAILS_ITEM"`)) {
    const t = textLines(el);
    const id = attr(el, "data-item-id");
    const opts: Record<string, string> = {};
    for (const l of t) { const kv = /^([A-Z][\w /&-]{1,30}):\s*(.+)$/.exec(l); if (kv && !/^(est\. delivery|quantity|qty)$/i.test(kv[1])) opts[kv[1]] = kv[2]; }
    const qty = /(?:Quantity|Qty)\s*:?\s*(\d+)/i.exec(t.join(" "))?.[1];
    const price = parseMoney(t.find((l) => /^\$[\d,.]+$/.test(l)));
    if (!price) continue;
    lines.push({
      title: t.find((l) => l.length > 15 && !/sold$|^\d+$|returns|delivery/i.test(l)) ?? "",
      quantity: qty ? +qty : 1,
      price,
      options: Object.keys(opts).length ? opts : undefined,
      productId: id,
    });
  }
  const rows = elementsWith(html, `class="summary-item-row`).map((r) => textLines(r));
  const row = (re: RegExp) => { const r = rows.find((x) => re.test(x[0] ?? "")); return r ? parseMoney(r.slice(1).join(" ")) ?? (/free/i.test(r.join(" ")) ? { cents: 0, currency: "USD" } : undefined) : undefined; };
  const total = parseMoney(textOf(firstWith(html, `data-test-id="TOTAL"`))?.replace(/^[^$]*/, ""));
  const confirm = /<button[^>]*data-test-id="CONFIRM_AND_PAY_BUTTON"[^>]*>/.exec(html)?.[0];
  const confirmEnabled = !!confirm && !/aria-disabled="true"|\sdisabled[\s>=]/.test(confirm);
  let needs: EbayCheckout["needs"];
  if (html.includes(`data-test-id="SHIPPING_ADDRESS_FORM"`) || /<input[^>]*name="addressLine1"/.test(html)) needs = "address";
  else if (!confirmEnabled) needs = "payment";
  const shipToEl = firstWith(html, `data-test-id="SHIPPING_ADDRESS"`) ?? firstWith(html, `class="shipping-address`);
  const cityLine = shipToEl ? textLines(shipToEl).find((l) => /,\s*[A-Z]{2}\s+\d{5}/.test(l)) : undefined;
  const pay = textLines(firstWith(html, `data-test-id="PAYMENT_METHODS"`) ?? "").find((l) => /ending in|\*{2,}\d{4}|x{2,}\d{4}/i.test(l));
  return {
    lines,
    subtotal: row(/^items?\b|^item \(/i) ?? parseMoney(textOf(firstWith(html, `data-test-id="SUB_TOTAL"`))?.replace(/^[^$]*/, "")),
    shipping: row(/^shipping/i),
    tax: row(/tax/i),
    total,
    needs,
    confirmEnabled,
    shipTo: cityLine ? clean(/([A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5})/.exec(cityLine)?.[1]) : undefined,
    paymentHint: pay,
  };
}

export function isErrorPage(html: string, title: string): boolean {
  return /error page \| ebay/i.test(title) || /Something went wrong on our end/i.test(html.slice(0, 20000)) || /Access Denied/i.test(title);
}

export function isSecurityCheck(html: string, title: string): boolean {
  return /security measure|verify yourself|pardon our interruption/i.test(title + " " + html.slice(0, 30000)) && !/s-card|x-item-title/.test(html);
}

// ---------------------------------------------------------------------------------------------
// Browser steps
// ---------------------------------------------------------------------------------------------

async function goto(ctx: StoreContext, url: string, waitMs = 1500): Promise<{ html: string; title: string; status?: number }> {
  // A crashed, closed or frozen tab is replaced once with a fresh one in the same browser.
  for (let attempt = 0; ; attempt++) {
    try {
      if (ctx.page.isClosed()) await replacePage(ctx, "was closed");
      let dead = false;
      const r = await ctx.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(async (e: Error) => {
        if (isDeadPageError(e)) throw e;
        ctx.log(`goto ${url}: ${e.message.split("\n")[0]}`);
        if (/Timeout/i.test(e.message) && await pageIsDead(ctx)) dead = true;
        return null;
      });
      if (dead) throw new Error("page stopped answering");
      await sleep(ctx, waitMs);
      const html = await ctx.page.content();
      return { html, title: await ctx.page.title().catch(() => ""), status: r?.status() };
    } catch (e) {
      if (attempt > 0 || !isDeadPageError(e)) throw e;
      await replacePage(ctx, /stopped answering/.test(String((e as Error).message)) ? "stopped answering" : "crashed");
    }
  }
}

/** Load a page; on eBay's error or security page, wait for Phantom, warm up through the home page and retry once. */
async function load(ctx: StoreContext, url: string, waitMs = 1500, warmQuery?: string): Promise<string> {
  let p = await goto(ctx, url, waitMs);
  if (!isErrorPage(p.html, p.title) && !isSecurityCheck(p.html, p.title)) return p.html;
  if (isSecurityCheck(p.html, p.title) && await browsaSolves(ctx, "eBay", async () => {
    const s = { html: await ctx.page.content(), title: await ctx.page.title().catch(() => "") };
    return isSecurityCheck(s.html, s.title);
  }, { check: "a security check" })) {
    // Solved: eBay sends the browser on to the page it asked for.
    const html = await ctx.page.content();
    if (!isErrorPage(html, await ctx.page.title().catch(() => "")) && samePath(ctx.page.url(), url)) return html;
  }
  ctx.log(`eBay showed ${p.title || "an error page"} (status ${p.status ?? "?"}), warming up and retrying once`);
  if (isSecurityCheck(p.html, p.title)) await sleep(ctx, 8000);
  await goto(ctx, HOME, 1500);
  if (warmQuery) {
    // A typed search from the home page; best effort, the retry below runs either way.
    try {
      const box = ctx.page.locator(`input[name="_nkw"]`).first();
      if (await box.isVisible().catch(() => false)) {
        await box.focus({ timeout: 8000 });
        await box.pressSequentially(warmQuery, { delay: 40, timeout: 15_000 });
        await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null), box.press("Enter", { timeout: 8000, noWaitAfter: true })]);
        await sleep(ctx, 1500);
      }
    } catch (e) { ctx.log(`eBay warm-up search: ${(e as Error).message.split("\n")[0]}`); }
  }
  p = await goto(ctx, url, waitMs);
  if (isErrorPage(p.html, p.title) || isSecurityCheck(p.html, p.title)) throw new Error(`eBay refused the page twice (${p.title || "error page"}, status ${p.status ?? "?"}) at ${url}`);
  return p.html;
}

function samePath(a: string, b: string): boolean {
  try { return new URL(a).pathname === new URL(b).pathname; } catch { return false; }
}

/** True when the tab already shows eBay (a page of www.ebay.com that is not an error page). */
async function onEbay(ctx: StoreContext): Promise<boolean> {
  if (!/^https:\/\/www\.ebay\.com\//.test(ctx.page.url())) return false;
  const title = await ctx.page.title().catch(() => "");
  return !isErrorPage("", title) && !isSecurityCheck("", title);
}

/**
 * Type a search into eBay's search box and submit it, like a person: the results page then has a
 * real referrer and same-site fetch headers. Opens the home page first when the tab is not on
 * eBay yet. Returns false when there was no search box.
 */
async function typeSearch(ctx: StoreContext, query: string): Promise<boolean> {
  try {
    // A fresh session often gets 403 on its first home page loads while eBay's sensor runs;
    // in the sessions measured on 2026-11-18 the third load passed, so try up to three times.
    for (let i = 0; i < 3 && !(await onEbay(ctx)); i++) {
      if (i > 0) { ctx.log("eBay showed its error page; waiting for its check and loading the home page again"); await sleep(ctx, 6000); }
      await goto(ctx, HOME, 2000);
    }
    const box = ctx.page.locator(`input[name="_nkw"]`).first();
    if (!(await box.isVisible().catch(() => false))) return false;
    await box.click({ timeout: 8000 });
    await box.fill("", { timeout: 5000 }).catch(() => {});
    await box.pressSequentially(query, { delay: 35, timeout: 20_000 });
    await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null), box.press("Enter", { timeout: 8000, noWaitAfter: true })]);
    await sleep(ctx, 1500);
    return true;
  } catch (e) {
    ctx.log(`eBay typed search: ${(e as Error).message.split("\n")[0]}`);
    return false;
  }
}

/** Navigate from inside the page (same tab, same-origin referrer), like a link on the page; falls back to goto. */
async function navigateInPage(ctx: StoreContext, url: string, waitMs = 1500): Promise<{ html: string; title: string }> {
  if (await onEbay(ctx)) {
    try {
      await Promise.all([
        ctx.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 }),
        ctx.page.evaluate((u: string) => { location.assign(u); }, url),
      ]);
      await sleep(ctx, waitMs);
      return { html: await ctx.page.content(), title: await ctx.page.title().catch(() => "") };
    } catch (e) {
      if (isDeadPageError(e)) throw e;
      ctx.log(`eBay in-page navigation: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const p = await goto(ctx, url, waitMs);
  return { html: p.html, title: p.title };
}

/** Poll the tab's URL until `ok` (navigation events can be missed on a slow connection). */
async function urlBecomes(ctx: StoreContext, ok: (u: string) => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ok(ctx.page.url())) return true;
    await ctx.page.waitForTimeout(500).catch(() => {});
  }
  return ok(ctx.page.url());
}

/** Item id of an eBay item page URL ("/itm/<id>" or "/itm/<slug>/<id>"). */
export function itemIdOfUrl(url: string): string | undefined {
  return /ebay\.com\/itm\/(?:[^/?#]+\/)?(\d{9,})/.exec(url)?.[1];
}

/**
 * Click the result card of item `id` on the search page in this tab (its link's target is
 * removed so it opens in the same tab). Returns the item page HTML, or undefined when the card is
 * not on the page or eBay refused the page.
 */
async function clickResult(ctx: StoreContext, id: string): Promise<string | undefined> {
  const page = ctx.page;
  // The visible title link: the image link has no size when images are not loaded.
  const link = page.locator(`li[data-listingid="${id}"] a[href*="/itm/"]:visible`).first();
  if (!(await link.count().catch(() => 0))) return undefined;
  const onItem = (u: URL | string) => itemIdOfUrl(u.toString()) === id;
  const href = await link.getAttribute("href").catch(() => null);
  try {
    await link.evaluate((a: any) => a.removeAttribute("target"));
    await link.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    // eBay's results script opens the item in a new tab even without target (seen live
    // 2026-11-18): notice that tab at once instead of waiting for this one to move.
    let popped = false;
    const onPopup = () => { popped = true; };
    page.context().on("page", onPopup);
    // Do not let the click wait for the navigation: on a slow exit that outlasts the click timeout.
    // A click that "times out" may still have started the navigation, so the URL decides.
    await link.click({ timeout: 15_000, noWaitAfter: true }).catch((e: Error) => {
      if (isDeadPageError(e)) throw e;
      ctx.log(`eBay result click: ${e.message.split("\n")[0].slice(0, 120)}`);
    });
    const until = Date.now() + 12_000;
    while (Date.now() < until && !popped && !onItem(page.url())) await page.waitForTimeout(400).catch(() => {});
    page.context().off("page", onPopup);
    if (!onItem(page.url()) && href && /^https:\/\/www\.ebay\.com\/itm\//.test(href)) {
      // The click did not open it here (a script or a new tab took it): follow the same link from
      // this page, which keeps the tab and the results page as the referrer.
      const others = page.context().pages().filter((p) => p !== page);
      ctx.log(`eBay result click did not open the item in this tab${others.length ? ` (${others.length} other tab${others.length > 1 ? "s" : ""} open)` : ""}; following its link from the results page`);
      for (const p of others) if (onItem(p.url()) || p.url() === "about:blank") await p.close().catch(() => {});
      await page.evaluate((h: string) => { location.assign(h); }, href).catch(() => {});
      await urlBecomes(ctx, onItem, 40_000);
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 45_000 }).catch(() => {});
  } catch (e) {
    if (isDeadPageError(e)) throw e;
    ctx.log(`eBay result click: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!onItem(page.url())) return undefined;
  await sleep(ctx, 1500);
  const html = await page.content();
  const title = await page.title().catch(() => "");
  if (isErrorPage(html, title) || isSecurityCheck(html, title)) {
    ctx.log(`eBay refused the item page after a click (${title || "error page"})`);
    return undefined;
  }
  return html;
}

/**
 * Open an item page the way a person does: by clicking its card on the search results, never by
 * typing its URL into a fresh session (eBay's Akamai answers 403 to that, seen live 2026-11-18).
 * Order: the item page already open; the card on this page; the card after going back to the
 * results; the card after searching again (the offer's search, then its item number); last, the
 * item URL with the home-page warm-up.
 */
async function openItem(ctx: StoreContext, offer: Offer): Promise<string> {
  const id = itemIdOf(offer);
  const page = ctx.page;
  if (itemIdOfUrl(page.url()) === id) {
    const html = await page.content();
    if (!isErrorPage(html, await page.title().catch(() => "")) && /x-item-title|itemprop="name"|data-testid="x-/.test(html)) return html;
  }
  let html = await clickResult(ctx, id);
  if (html) return html;
  if (itemIdOfUrl(page.url())) {
    // On another item page (details() opened it): back to the results.
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    await sleep(ctx, 1200);
    html = await clickResult(ctx, id);
    if (html) return html;
  }
  const searchUrl = typeof offer.raw?.searchUrl === "string" ? offer.raw.searchUrl : undefined;
  if (searchUrl) {
    // A fresh browser (the cart step can open a new one) first gets past eBay's check like a person.
    if (!(await onEbay(ctx))) await typeSearch(ctx, warmQueryFor(offer) ?? id);
    await navigateInPage(ctx, searchUrl);
    html = await clickResult(ctx, id);
    if (html) return html;
  }
  // eBay opens the item itself when the search text is its item number.
  if (await typeSearch(ctx, id)) {
    if (itemIdOfUrl(page.url()) === id) {
      html = await page.content();
      if (!isErrorPage(html, await page.title().catch(() => ""))) return html;
    }
    html = await clickResult(ctx, id);
    if (html) return html;
  }
  ctx.log(`eBay: item ${id} could not be opened from the results; opening its page directly`);
  return load(ctx, `https://www.ebay.com/itm/${id}`, 1500, warmQueryFor(offer));
}

/**
 * The search condition for an item: ItemRequest.condition ("used" = used or refurbished, "any" =
 * no filter; "refurbished" in the request narrows "used" to refurbished), else an option named
 * condition, else new.
 */
export function wantedCondition(item: ItemRequest): EbaySearchCondition {
  const c = (item.options?.condition ?? "").toLowerCase();
  if (/refurb/.test(c)) return "refurbished";
  if (/used|pre-?owned/.test(c)) return "used";
  if (item.condition === "any") return "any";
  if (item.condition === "used") return /\b(refurbished|refurb|renewed)\b/i.test(`${item.query} ${item.description}`) ? "refurbished" : "not_new";
  return "new";
}

const CONDITION_WORDS: Record<EbaySearchCondition, string> = {
  new: "the New condition filter", used: "the Used condition filter", refurbished: "the Refurbished condition filters",
  not_new: "the Used and Refurbished condition filters", any: "no condition filter",
};

async function readCartNow(ctx: StoreContext, warnings: string[] = []): Promise<Omit<Cart, "lines"> & { lines: EbayCartLine[] }> {
  const html = await load(ctx, CART_URL, 2000);
  const parsed = parseCart(html);
  return { ...parsed, readAt: nowIso(), warnings };
}

/** Search text for the warm-up when eBay refuses an item page: the first words of the title (a fresh browser that opens /itm/ directly gets 403, seen live). */
export function warmQueryFor(offer: Offer): string | undefined {
  return offer.title ? offer.title.replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ") || undefined : undefined;
}

function itemIdOf(offer: Offer): string {
  const id = offer.productId ?? /\/itm\/(?:[^/]+\/)?(\d{9,})/.exec(offer.url)?.[1];
  if (!id) throw new Error(`no eBay item id in ${offer.url}`);
  return id;
}

/** Choose one menu value in the item page UI and check the page shows it. */
async function chooseValue(ctx: StoreContext, menuIndex: number, label: string, value: string): Promise<boolean> {
  const page = ctx.page;
  const root = page.locator(`[data-testid="x-msku-evo"], .x-msku-evo`).first();
  // Current UI: listbox buttons with options carrying data-sku-value-name.
  const btn = root.locator(`.listbox-button__control`).nth(menuIndex);
  if (await btn.count()) {
    await btn.click({ timeout: 10_000 });
    const lb = root.locator(`.listbox-button`).nth(menuIndex);
    const opt = lb.locator(`[data-sku-value-name="${value.replace(/"/g, "\\\"")}"]`).first();
    if ((await opt.count()) && (await opt.getAttribute("aria-disabled")) === "true") {
      await page.keyboard.press("Escape").catch(() => {});
      ctx.log(`eBay shows ${label} "${value}" as unavailable with the other choices`);
      return false;
    }
    if (await opt.count()) await opt.click({ timeout: 10_000 });
    else await lb.locator(`[role="option"]`, { hasText: value }).first().click({ timeout: 10_000 });
    await sleep(ctx, 800);
    const shown = clean(await btn.innerText().catch(() => "")) ?? "";
    return sameOption(shown.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:?`, "i"), "").trim(), value) || shown.toLowerCase().includes(value.toLowerCase());
  }
  // Older UI: native selects.
  const sel = root.locator("select").nth(menuIndex);
  if (await sel.count()) {
    await sel.selectOption({ label: value });
    await sleep(ctx, 800);
    const shown = await sel.evaluate((s: any) => s.options[s.selectedIndex]?.text ?? "").catch(() => "");
    return sameOption(String(shown), value);
  }
  return false;
}

async function setQuantity(ctx: StoreContext, quantity: number): Promise<boolean> {
  if (quantity <= 1) return true;
  const q = ctx.page.locator(`.x-quantity input[name="quantity"], input#qtyTextBox, .x-quantity input[type="text"], .x-quantity input[type="number"]`).first();
  if (!(await q.count()) || !(await q.isEditable().catch(() => false))) return false;
  await q.fill(String(quantity));
  await sleep(ctx, 500);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------

export const adapter: StoreAdapter = {
  id: "ebay",
  name: "eBay",
  domains: [DOMAIN, "www.ebay.com"],

  searchUrl(query: string): string {
    return searchUrlFor(query);
  },

  async search(ctx, item, limit) {
    const url = searchUrlFor(item.query, { zip: ctx.zip, condition: wantedCondition(item) });
    let offers: Offer[] = [];
    try {
      // Like a person: the home page, the typed search, then the filtered results from inside the
      // page. A fresh session that opens a deep URL first gets 403 from eBay's Akamai.
      let html: string | undefined;
      if (await typeSearch(ctx, item.query)) {
        const p = await navigateInPage(ctx, url);
        if (!isErrorPage(p.html, p.title) && !isSecurityCheck(p.html, p.title)) html = p.html;
      }
      html ??= await load(ctx, url, 1500, item.query);
      offers = parseSearch(html, item.id).map((o) => ({ ...o, raw: { ...o.raw, searchUrl: url } }));
    } catch (e) {
      ctx.log(`eBay search direct path failed: ${(e as Error).message}`);
    }
    if (!offers.length) {
      ctx.log("eBay search found no Buy It Now results in the page; asking the AI fallback once");
      const res = await ctx.aiTask<{ offers?: { title: string; url: string; price: string; shipping?: string; condition?: string; seller?: string }[] }>(
        `On eBay, search for "${item.query}" with the Buy It Now filter and ${CONDITION_WORDS[wantedCondition(item)]}. Return the first ${limit} Buy It Now listings (skip auctions) as JSON {offers:[{title,url,price,shipping,condition,seller}]}. Do not sign in, do not buy anything.`,
        { startUrl: url, maxSteps: 12 },
      ).catch((e: Error) => { ctx.log(`AI fallback failed: ${e.message}`); return { offers: [] }; });
      offers = (res.offers ?? []).flatMap((o) => {
        const price = parseMoney(o.price);
        const id = /\/itm\/(?:[^/]+\/)?(\d{9,})/.exec(o.url ?? "")?.[1];
        return price && id ? [{ store: "ebay" as const, storeDomain: DOMAIN, itemId: item.id, title: o.title, url: `https://www.ebay.com/itm/${id}`, productId: id, price, shipping: parseShipping(o.shipping), condition: conditionOf(o.condition), seller: o.seller, inStock: true, raw: { buyItNow: true, viaAi: true } }] : [];
      });
    }
    const max = item.maxPrice?.cents;
    return offers.filter((o) => max === undefined || o.price.cents <= max || !!o.raw?.priceRange).slice(0, limit);
  },

  async details(ctx, offer) {
    const id = itemIdOf(offer);
    const html = await openItem(ctx, offer);
    const it = parseItem(html);
    const variants = it.msku ? Object.fromEntries(it.msku.menus.map((m) => [m.label, m.values.filter((v) => !v.outOfStock).map((v) => v.name)])) : offer.variants;
    return {
      ...offer,
      productId: id,
      title: it.title ?? offer.title,
      price: it.price ?? offer.price,
      shipping: it.shipping ?? offer.shipping,
      deliveryText: it.deliveryText ?? offer.deliveryText,
      deliveryDate: lastDate(it.deliveryText) ?? offer.deliveryDate,
      seller: sellerText(it.seller) ?? offer.seller,
      condition: it.condition ?? offer.condition,
      inStock: it.inStock && it.buyItNow,
      variants,
      raw: { ...offer.raw, variationCombos: it.msku ? buyableCombos(it.msku) : undefined, buyItNow: it.buyItNow, auctionOnly: it.auctionOnly, conditionText: it.conditionText, sellerName: it.seller?.name, sellerPositivePercent: it.seller?.positivePercent, sellerFeedbackCount: it.seller?.feedbackCount },
    };
  },

  async addToCart(ctx, offer, quantity, options) {
    const id = itemIdOf(offer);
    const warnings: string[] = [];
    const html = await openItem(ctx, offer);
    const it = parseItem(html);
    if (it.auctionOnly || !it.buyItNow) throw new Error(`eBay listing ${id} has no Buy It Now price (auction only); not adding it`);

    let expectedVar: number | undefined;
    const expected: Record<string, string> = {};
    if (it.msku) {
      // Options come only from the combinations eBay sells (read on the product page by details(),
      // else from this page), so a wanted value that does not exist or an impossible pair never
      // reaches the option picker.
      const combos = Array.isArray(offer.raw?.variationCombos) && (offer.raw!.variationCombos as unknown[]).length
        ? offer.raw!.variationCombos as Record<string, string>[]
        : buyableCombos(it.msku);
      const msku = it.msku;
      const pick = chooseCombo(combos, options, {
        offerCents: offer.price.cents,
        of: (c) => {
          const m = matchOptions(msku, c);
          const vid = m.problems.length ? undefined : variationFor(msku, m.chosen.map((x) => x.value.id));
          return vid === undefined ? undefined : msku.prices[String(vid)]?.cents;
        },
      });
      if (!pick.combo) throw new Error(`eBay listing ${id}: ${pick.problem}`);
      if (JSON.stringify(pick.combo) !== JSON.stringify(Object.fromEntries(Object.entries(options ?? {}).filter(([k]) => k.toLowerCase() !== "condition")))) {
        ctx.log(`eBay options: ${Object.entries(pick.combo).map(([k, v]) => `${k} ${v}`).join(", ")} (a combination eBay sells)`);
      }
      const { chosen, problems } = matchOptions(it.msku, pick.combo);
      if (problems.length) throw new Error(`eBay listing ${id} needs options: ${problems.join("; ")}`);
      let uiOk = true;
      for (const c of chosen) {
        const idx = it.msku.menus.indexOf(c.menu);
        const ok = await chooseValue(ctx, idx, c.menu.label, c.value.name).catch((e: Error) => { ctx.log(`choose ${c.menu.label}: ${e.message.split("\n")[0]}`); return false; });
        if (!ok) uiOk = false;
        expected[c.menu.label] = c.value.name;
      }
      expectedVar = variationFor(it.msku, chosen.map((c) => c.value.id));
      if (!uiOk) {
        ctx.log("eBay option picker did not confirm the choice; asking the AI fallback once");
        await ctx.aiTask(`On this eBay item page, select ${Object.entries(expected).map(([k, v]) => `${k}: ${v}`).join(", ")}. Do not click Buy It Now, do not sign in. Return {"done":true} when the selection shows.`, { maxSteps: 8, sameBrowser: true })
          .catch((e: Error) => warnings.push(`AI option fallback failed: ${e.message}`));
      }
    }
    const qtyOk = await setQuantity(ctx, quantity);

    const atc = ctx.page.locator(`#atcBtn_btn_1, a[data-testid="ux-call-to-action"]:has-text("Add to cart"), button:has-text("Add to cart")`).first();
    if (!(await atc.count())) throw new Error(`eBay listing ${id} has no Add to cart button`);
    await atc.click({ timeout: 15_000, noWaitAfter: true });
    await sleep(ctx, 3000);

    const cart = await readCartNow(ctx, warnings);
    const line = cart.lines.find((l) => l.productId === id && (expectedVar === undefined || l.variationId === String(expectedVar)))
      ?? cart.lines.find((l) => l.productId === id);
    if (!line) {
      warnings.push(`eBay cart does not show item ${id} after Add to cart`);
    } else {
      if (expectedVar !== undefined && line.variationId && line.variationId !== String(expectedVar)) {
        warnings.push(`eBay cart has variation ${line.variationId}, expected ${expectedVar} (${Object.values(expected).join(", ")})`);
      }
      const shown = Object.values(line.options ?? {});
      for (const [k, v] of Object.entries(expected)) {
        if (!shown.some((s) => sameOption(s, v) || s.toLowerCase().includes(v.toLowerCase()))) warnings.push(`Option ${k} '${v}' did not stick, cart shows '${shown.join(", ") || "nothing"}'`);
      }
      if (line.quantity !== quantity) {
        if (!qtyOk || line.quantity < quantity) {
          // Fix the quantity in the cart itself.
          const input = ctx.page.locator(`[data-test-info*="${id}"] input[aria-label="Quantity"], [data-test-info*="${id}"] select[aria-label="Quantity"]`).first();
          if (await input.count()) {
            if ((await input.evaluate((e: any) => e.tagName)) === "SELECT") await input.selectOption(String(quantity)); else { await input.fill(String(quantity)); await input.press("Enter"); }
            await sleep(ctx, 2500);
            const again = await readCartNow(ctx, warnings);
            const l2 = again.lines.find((l) => l.productId === id);
            if (l2?.quantity !== quantity) warnings.push(`Quantity ${quantity} did not stick, cart shows ${l2?.quantity ?? "?"}`);
            return again;
          }
        }
        warnings.push(`Quantity ${quantity} did not stick, cart shows ${line.quantity}`);
      }
    }
    return cart;
  },

  async readCart(ctx) {
    return readCartNow(ctx);
  },

  async clearCart(ctx) {
    await load(ctx, CART_URL, 2000);
    for (let i = 0; i < 25; i++) {
      const rm = ctx.page.locator(`[data-test-id="cart-remove-item"]`).first();
      if (!(await rm.count())) return;
      await rm.click({ timeout: 10_000 });
      await sleep(ctx, 2000);
    }
  },

  async reviewCheckout(ctx) {
    const cart = await readCartNow(ctx);
    if (!cart.lines.length) throw new Error("eBay cart is empty");
    const page = ctx.page;
    const onPay = () => /pay\.ebay\.com/.test(page.url());
    // Clicks here can start a navigation that Playwright waits on; a timeout is not a failure, the URL decides.
    const tryClick = async (loc: ReturnType<typeof page.locator>) => {
      try { if (!(await loc.count())) return false; await loc.click({ timeout: 10_000, noWaitAfter: true }); return true; }
      catch (e) { ctx.log(`eBay checkout click: ${(e as Error).message.split("\n")[0]}`); return false; }
    };
    await tryClick(page.locator(`[data-test-id="cta-top"], button:has-text("Go to checkout")`).first());
    await page.waitForURL(/pay\.ebay\.com/, { timeout: 6000 }).catch(() => {});

    // Signed out: eBay opens a sign-in chooser (iframe) with "Continue as guest". Never sign in.
    if (!onPay()) {
      const frame = page.frameLocator("#auth-iframe");
      const guest = frame.locator(`button:has-text("Continue as guest"), a:has-text("Continue as guest"), button:has-text("Check out as guest")`).first();
      const direct = page.locator(`button:has-text("Continue as guest"), a:has-text("Continue as guest"), #gxo-btn`).first();
      if (!(await tryClick(guest))) await tryClick(direct);
      await page.waitForURL(/pay\.ebay\.com/, { timeout: 20_000 }).catch(() => {});
    }
    if (!onPay()) {
      // eBay names its guest checkout URL in the sign-in iframe; open it directly.
      const src = await page.locator("#auth-iframe").getAttribute("src", { timeout: 5000 }).catch(() => null);
      const gx = src ? new URL(src, "https://signin.ebay.com").searchParams.get("guestCheckoutUrl") : null;
      if (gx && /^https:\/\/pay\.ebay\.com\//.test(gx)) await goto(ctx, gx, 2000);
    }
    if (onPay()) {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(ctx, 3000);
    }
    if (!/pay\.ebay\.com/.test(page.url())) {
      const nu = await needsUser(ctx, "sign_in", "eBay asks you to sign in or continue as guest before checkout. Open the live browser to continue.");
      return { store: "ebay", storeDomain: DOMAIN, lines: cart.lines, subtotal: cart.subtotal, total: cart.subtotal ?? { cents: 0, currency: "USD" }, needsUser: nu, reviewedAt: nowIso() };
    }
    const co = parseCheckout(await page.content());
    const review: CheckoutReview = {
      store: "ebay",
      storeDomain: DOMAIN,
      lines: co.lines.length ? co.lines : cart.lines,
      subtotal: co.subtotal ?? cart.subtotal,
      shipping: co.shipping,
      tax: co.tax,
      total: co.total ?? co.subtotal ?? cart.subtotal ?? { cents: 0, currency: "USD" },
      shipTo: co.shipTo,
      paymentHint: co.paymentHint,
      reviewedAt: nowIso(),
    };
    if (co.needs === "address") review.needsUser = await needsUser(ctx, "address", "eBay guest checkout needs your email and shipping address, then a payment method. Open the live browser to fill them in.");
    else if (co.needs === "payment") review.needsUser = await needsUser(ctx, "payment", "eBay checkout needs a payment method before the order can be placed. Open the live browser to choose one.");
    return review;
  },

  async placeOrder(ctx, approval: Approval): Promise<OrderResult> {
    const page = ctx.page;
    if (!/pay\.ebay\.com/.test(page.url())) {
      const r = await adapter.reviewCheckout(ctx);
      if (r.needsUser) return { store: "ebay", placed: false, needsUser: r.needsUser };
    } else {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(ctx, 3000);
    }
    const co = parseCheckout(await page.content());
    if (!co.total) return { store: "ebay", placed: false, error: "eBay checkout total could not be read; not placing the order" };
    if (co.total.cents !== approval.approvedTotal.cents || co.total.currency !== approval.approvedTotal.currency) {
      return { store: "ebay", placed: false, total: co.total, error: `eBay total is now ${co.total.cents / 100} ${co.total.currency}, approved ${approval.approvedTotal.cents / 100} ${approval.approvedTotal.currency}; not placing the order` };
    }
    if (co.needs || !co.confirmEnabled) {
      return { store: "ebay", placed: false, needsUser: await needsUser(ctx, co.needs ?? "payment", "eBay needs your details before the order can be placed. Open the live browser.") };
    }
    await page.locator(`[data-test-id="CONFIRM_AND_PAY_BUTTON"]`).first().click({ timeout: 15_000 });
    await page.waitForURL((u) => !/rxo\?action=view|rgxo\?action=view/.test(u.toString()), { timeout: 60_000 }).catch(() => {});
    await sleep(ctx, 4000);
    const html = await page.content();
    const text = textLines(html).join(" ");
    if (/verify|verification code|3-?D Secure|authenticate/i.test(text) && !/order (is )?confirmed|thank you/i.test(text)) {
      return { store: "ebay", placed: false, needsUser: await needsUser(ctx, "3ds", "Your bank or eBay asks for a verification step. Open the live browser to finish it.") };
    }
    const placed = /order (is )?confirmed|thank you for your (order|purchase)|you're all set/i.test(text);
    return {
      store: "ebay",
      placed,
      orderId: /order number:?\s*([\d-]{6,})/i.exec(text)?.[1],
      total: co.total,
      confirmationText: clean(/(order (is )?confirmed[^.]*\.?|thank you for your (order|purchase)[^.]*\.?)/i.exec(text)?.[0]),
      placedAt: placed ? nowIso() : undefined,
    };
  },
};

export default adapter;
