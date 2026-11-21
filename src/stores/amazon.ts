// Amazon.com (US) adapter. Reads pages as HTML and parses them in Node with stable signals:
// data-asin, data-component-type, data-cy, data-csa-c-* attributes, the twister JSON for
// variants and the cart's data-* attributes. Clicks go through Playwright on the Phantom page.
//
// The HTML parser, option matcher, bot check wait and approval check live in util.ts.

import type { Page } from "playwright-core";
import type {
  Cart, CartLine, CheckoutReview, Money, NeedsUser, Offer, OrderResult, ProductIds, Rating,
} from "../core/types.js";
import { idsFromSpecs, mergeIds, normalizeIds } from "../core/identity.js";
import type { StoreAdapter, StoreContext } from "./adapter.js";
import {
  aiSearchFallback, approvalMatches, CaptchaHandoffError, clean, clickFirstVisible, declineOffer, decodeEntities, formatMoney, gotoRetry, hasClass, jsonAfter, needsUser,
  nowIso, optionWarnings, parseCount, parseDeliveryDate, parseHtml, parseMoney, parseStars, passBotCheck, pickVariant, qs, qsa,
  shortAddress, sumLines, textOf, type HNode, type VariantChoice,
} from "./util.js";

// ---------------------------------------------------------------------------------------------
// Amazon parsing (pure, unit tested on fixtures)
// ---------------------------------------------------------------------------------------------

const AMZ = "https://www.amazon.com";
const DOMAIN = "amazon.com";

export function amazonProductUrl(asin: string): string { return `${AMZ}/dp/${asin}`; }
export function asinFromUrl(url: string | undefined): string | undefined {
  return url?.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/)?.[1];
}

function firstPrice(scope: HNode | undefined): Money | undefined {
  if (!scope) return undefined;
  for (const p of qsa(scope, "span.a-price")) {
    if (p.attrs["data-a-strike"] === "true" || hasClass(p, "a-text-price")) continue;
    const off = qs(p, ".a-offscreen");
    const m = parseMoney(off ? textOf(off) : textOf(p));
    if (m) return m;
  }
  return undefined;
}

function listPriceFrom(text: string): Money | undefined {
  const m = /(?:List(?: Price)?|Typical(?: price)?|Was(?: Price)?)\s*:?\s*(\$[\d,]+(?:\.\d{2})?)/i.exec(text);
  return m ? parseMoney(m[1]) : undefined;
}

function unitPriceFrom(text: string): Offer["unitPrice"] {
  const m = /\((\$[\d,]*\.?\d+)(?:\s+\$[\d,]*\.?\d+)?\s*\/\s*([^)]{1,20})\)/.exec(text);
  const amount = m ? parseMoney(m[1]) : undefined;
  return m && amount ? { amount, per: m[2].trim() } : undefined;
}

/** Free shipping only when unconditional, or when the price clears the shown threshold. */
function shippingFrom(text: string | undefined, price: Money | undefined): { shipping?: Money; freeOver?: Money } {
  if (!text) return {};
  const paid = /(\$[\d,]+\.\d{2})\s+(?:delivery|shipping)/i.exec(text);
  if (paid && !/FREE/i.test(text.slice(0, paid.index))) return { shipping: parseMoney(paid[1]) };
  if (!/FREE (delivery|shipping)/i.test(text)) return {};
  const over = /(?:over|on)\s+(\$[\d,]+(?:\.\d{2})?)/i.exec(text);
  if (over) {
    const freeOver = parseMoney(over[1]);
    if (freeOver && price && price.cents >= freeOver.cents) return { shipping: { cents: 0, currency: price.currency }, freeOver };
    return { freeOver };
  }
  if (/join prime|with prime|prime members/i.test(text)) return {};
  return { shipping: { cents: 0, currency: price?.currency ?? "USD" } };
}

/** The part of Amazon's delivery text that applies to someone without Prime. */
function nonMemberDelivery(text: string): string {
  const i = text.search(/non-members|or non-member/i);
  return i >= 0 ? text.slice(i) : text;
}

export function parseAmazonSearch(html: string, itemId: string, now = new Date()): Offer[] {
  const doc = parseHtml(html);
  const out: Offer[] = [];
  const seen = new Set<string>();
  for (const card of qsa(doc, "div[data-component-type=\"s-search-result\"]")) {
    const asin = card.attrs["data-asin"];
    if (!asin || seen.has(asin)) continue;
    const titleBox = qs(card, "[data-cy=\"title-recipe\"]") ?? card;
    let title = "";
    for (const h of qsa(titleBox, "h2")) {
      const t = clean(h.attrs["aria-label"]) ?? textOf(h);
      if (t.length > title.length) title = t;
    }
    if (!title) continue;
    const priceBox = qs(card, "[data-cy=\"price-recipe\"]") ?? card;
    const priceText = textOf(priceBox);
    let price = firstPrice(priceBox);
    if (!price) continue;
    const listPrice = listPriceFrom(priceText);
    const raw: Record<string, unknown> = {};
    if (/Prime (member )?price|Exclusive Prime price/i.test(priceText)) {
      raw.primePrice = price;
      if (listPrice) price = listPrice;
      raw.priceNote = "shown price is for Prime members; using the regular price";
    }
    const cardText = textOf(card);
    const reviews = qs(card, "[data-cy=\"reviews-block\"]") ?? card;
    const starsNode = qs(reviews, "[aria-label*=\"out of 5 stars\"], .a-icon-alt");
    const stars = parseStars(starsNode?.attrs["aria-label"] ?? textOf(starsNode));
    const countNode = qs(reviews, "a[aria-label$=\"ratings\"], a[aria-label$=\"rating\"], [aria-label$=\" ratings\"]");
    const count = parseCount(countNode?.attrs["aria-label"]) ?? parseCount(textOf(qs(reviews, ".s-underline-text")));
    const rating: Rating | undefined = stars !== undefined ? { stars, count: count ?? 0 } : undefined;
    const delivery = clean(textOf(qs(card, "[data-cy=\"delivery-recipe\"]")));
    const relevant = delivery ? nonMemberDelivery(delivery) : undefined;
    const ship = shippingFrom(relevant, price);
    if (ship.freeOver) raw.freeShippingOver = ship.freeOver;
    const sponsored = hasClass(card, "AdHolder") || qsa(card, "span, a").some((x) => x.children.length <= 2 && textOf(x) === "Sponsored") || !!qs(card, ".puis-sponsored-label-text, .s-sponsored-label-text, .s-widget-sponsored-label-text, a[href*=\"/sspa/click\"], [data-component-type=\"sp-sponsored-result\"]");
    const subscribeAndSaveAvailable = /Subscribe (&|and) Save|when you subscribe/i.test(cardText) || undefined;
    const condition = /\b(Renewed|Refurbished)\b/i.test(title) ? "refurbished" : "new";
    out.push({
      store: "amazon", storeDomain: DOMAIN, itemId, title, url: amazonProductUrl(asin), productId: asin,
      image: qs(card, "img.s-image")?.attrs.src,
      price, listPrice, unitPrice: unitPriceFrom(priceText), shipping: ship.shipping,
      deliveryText: delivery?.slice(0, 200), deliveryDate: parseDeliveryDate(relevant, now),
      rating, condition, inStock: !/Currently unavailable|Temporarily out of stock/i.test(cardText),
      sponsored, subscription: false, ...(subscribeAndSaveAvailable ? { subscribeAndSaveAvailable } : {}), raw,
    });
    seen.add(asin);
  }
  return out;
}

export interface AmazonProduct {
  asin?: string;
  title?: string;
  price?: Money;
  listPrice?: Money;
  seller?: string;
  deliveryText?: string;
  deliveryDate?: string;
  shipping?: Money;
  freeShippingOver?: Money;
  inStock: boolean;
  rating?: Rating;
  variants?: Record<string, string[]>;
  selected?: Record<string, string>;
  variantChoices?: VariantChoice[];
  subscribeAndSave: boolean;
  hasAccordion: boolean;
  primeOnlyDefault: boolean;
  canAddToCart: boolean;
  image?: string;
}

export function parseAmazonProduct(html: string, now = new Date()): AmazonProduct {
  const doc = parseHtml(html);
  const asin = qs(doc, "input#ASIN")?.attrs.value ?? qs(doc, "input[name=\"ASIN\"]")?.attrs.value ?? qs(doc, "[data-csa-c-asin]")?.attrs["data-csa-c-asin"];
  const title = clean(textOf(qs(doc, "#productTitle")));
  const newRow = qs(doc, "[id^=\"newAccordionRow\"]");
  const hasAccordion = !!qs(doc, "#buyBoxAccordion");
  const scope = newRow ?? qs(doc, "#desktop_qualifiedBuyBox") ?? qs(doc, "#buybox") ?? doc;
  let price = newRow ? firstPrice(newRow) : undefined;
  price ??= firstPrice(qs(doc, "#corePrice_feature_div")) ?? firstPrice(qs(doc, "#corePriceDisplay_desktop_feature_div"))
    ?? firstPrice(qs(doc, "#apex_desktop")) ?? parseMoney(textOf(qs(doc, "#price_inside_buybox"))) ?? parseMoney(textOf(qs(doc, "#priceblock_ourprice")));
  const core = qs(doc, "#corePriceDisplay_desktop_feature_div") ?? qs(doc, "#corePrice_feature_div");
  const listPrice = parseMoney(textOf(qs(core, ".basisPrice .a-offscreen"))) ?? listPriceFrom(textOf(core));
  const scopeText = textOf(scope);
  let seller = clean(textOf(qs(scope, "#sellerProfileTriggerId")))
    ?? clean(textOf(qs(scope, "[offer-display-feature-name=\"desktop-merchant-info\"] .offer-display-feature-text-message")))
    ?? clean(textOf(qs(scope, "#merchant-info")));
  if (!seller) seller = /Sold by:?\s+(.+?)(?=\s+(?:Returns|Payment|Ships from|Gift options|Packaging|Sold by)\b|$)/.exec(scopeText)?.[1]?.trim();
  if (seller) seller = seller.replace(/\s+and Fulfilled by Amazon\.?$/i, "").replace(/^Ships from and sold by\s+/i, "").slice(0, 80);
  const dNode = qs(scope, "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE [data-csa-c-delivery-time]")
    ?? qs(scope, "[data-csa-c-delivery-time]") ?? qs(doc, "[data-csa-c-delivery-time]");
  let deliveryText: string | undefined;
  let deliveryDate: string | undefined;
  let ship: { shipping?: Money; freeOver?: Money } = {};
  if (dNode) {
    const dp = dNode.attrs["data-csa-c-delivery-price"] ?? "";
    const dt = dNode.attrs["data-csa-c-delivery-time"] ?? "";
    const dc = dNode.attrs["data-csa-c-delivery-condition"] ?? "";
    deliveryText = clean(`${dp} delivery ${dt} ${dc}`);
    deliveryDate = parseDeliveryDate(dt, now);
    if (/^free$/i.test(dp)) ship = shippingFrom(`FREE delivery ${dc}`, price);
    else if (parseMoney(dp)) ship = { shipping: parseMoney(dp) };
  }
  const availText = textOf(qs(scope, "#availability") ?? qs(doc, "#availability"));
  const canAddToCart = !!qs(doc, "#add-to-cart-button");
  const inStock = /currently unavailable|out of stock/i.test(availText) ? false : canAddToCart || /in stock|left in stock/i.test(availText);
  const starsAttr = qs(doc, "#acrPopover")?.attrs.title ?? textOf(qs(doc, "#acrPopover .a-icon-alt"));
  const stars = parseStars(starsAttr) ?? parseStars(textOf(qs(doc, "#acrPopover")).split(" ")[0]);
  const count = parseCount(textOf(qs(doc, "#acrCustomerReviewText")));
  // Variants from the twister JSON.
  const base = Math.max(0, html.indexOf("\"dimensionToAsinMap\"") - 200);
  let variants: Record<string, string[]> | undefined;
  let variantChoices: VariantChoice[] | undefined;
  let selected: Record<string, string> | undefined;
  if (html.indexOf("\"dimensionToAsinMap\"") >= 0) {
    const values = jsonAfter(html, "\"variationValues\"", base) as Record<string, string[]> | undefined;
    const labels = (jsonAfter(html, "\"variationDisplayLabels\"", base) ?? {}) as Record<string, string>;
    const dims = jsonAfter(html, "\"dimensions\"", base) as string[] | undefined;
    const display = jsonAfter(html, "\"dimensionValuesDisplayData\"", base) as Record<string, string[]> | undefined;
    if (values && dims && display) {
      variants = {};
      for (const d of dims) if (values[d]) variants[labels[d] ?? d] = values[d];
      variantChoices = Object.entries(display).map(([id, vals]) => ({
        id, values: Object.fromEntries(dims.map((d, i) => [labels[d] ?? d, vals[i]]).filter(([, v]) => v !== undefined)),
      }));
      if (asin) selected = variantChoices.find((c) => c.id === asin)?.values;
    }
  }
  const sns = !!qs(doc, "[id^=\"snsAccordionRow\"], #sns-base-price, #snsAccordionRowMiddle") || /Subscribe (&|and) Save/i.test(textOf(qs(doc, "#buyBoxAccordion")));
  const primeOnlyDefault = !!qs(doc, "#primeSavingsUpsellAccordionRow, [data-csa-c-buying-option-type=\"PRIME_SAVINGS_UPSELL\"]");
  return {
    asin, title, price, listPrice, seller, deliveryText, deliveryDate, shipping: ship.shipping, freeShippingOver: ship.freeOver,
    inStock, rating: stars !== undefined ? { stars, count: count ?? 0 } : undefined,
    variants, selected, variantChoices, subscribeAndSave: sns, hasAccordion, primeOnlyDefault, canAddToCart,
    image: qs(doc, "#landingImage")?.attrs["data-old-hires"] || qs(doc, "#landingImage")?.attrs.src,
  };
}

/**
 * Identifiers from a product page: the product details tables and bullets (UPC, EAN, "Item model
 * number", "Manufacturer Part Number", "Brand") and the byline ("Visit the Logitech Store").
 * Amazon has no JSON-LD on product pages.
 */
export function amazonIds(html: string): ProductIds | undefined {
  const doc = parseHtml(html);
  const rows: [string, string][] = [];
  const strip = (s: string) => s.replace(/[‎‏ ]|&[lr]rm;|&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  for (const table of ["#productDetails_techSpec_section_1", "#productDetails_techSpec_section_2", "#productDetails_detailBullets_sections1", "#technicalSpecifications_section_1", "#poExpander", "#productOverview_feature_div"]) {
    for (const tr of qsa(doc, `${table} tr`)) {
      const cells = qsa(tr, "td");
      const th = qs(tr, "th");
      const label = strip(textOf(th ?? cells[0]));
      const value = strip(textOf(cells[cells.length - 1]));
      if (label && value && label !== value) rows.push([label, value]);
    }
  }
  for (const li of qsa(doc, "#detailBullets_feature_div li")) {
    const t = strip(textOf(li));
    const i = t.indexOf(":");
    if (i > 0) rows.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
  }
  const byline = strip(textOf(qs(doc, "#bylineInfo")));
  return mergeIds(idsFromSpecs(rows), normalizeIds({ brand: byline || undefined }));
}

export function parseAmazonCart(html: string): Cart {
  const doc = parseHtml(html);
  const lines: CartLine[] = [];
  const warnings: string[] = [];
  const list = qs(doc, "#sc-active-cart") ?? qs(doc, "#activeCartViewForm") ?? qs(doc, "[data-name=\"Active Items\"]");
  if (!list) warnings.push("Amazon cart page did not load");
  for (const n of list ? qsa(list, "div[data-itemtype=\"active\"][data-asin]") : []) {
    const asin = n.attrs["data-asin"];
    if (!asin) continue;
    const qty = parseInt(n.attrs["data-quantity"] ?? "1", 10) || 1;
    // data-price is a bare number: its currency is the one the line's price text shows.
    const shown = firstPrice(n);
    const unit = parseMoney(n.attrs["data-price"], shown?.currency ?? "USD") ?? shown;
    if (!unit) continue;
    const title = clean(n.attrs["data-producttitle"]) ?? clean(textOf(qs(n, ".sc-product-title"))) ?? asin;
    const options: Record<string, string> = {};
    for (const v of qsa(n, ".sc-product-variation")) {
      const t = textOf(v);
      const i = t.indexOf(":");
      if (i > 0) options[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    const text = textOf(n);
    if (/Subscribe (&|and) Save|Deliver(y)? every/i.test(text)) warnings.push(`Amazon cart line "${title.slice(0, 60)}" looks like a subscription`);
    lines.push({
      title, quantity: qty, price: { cents: unit.cents * qty, currency: unit.currency },
      options: Object.keys(options).length ? options : undefined, url: amazonProductUrl(asin), productId: asin,
    });
  }
  const subtotal = parseMoney(textOf(qs(doc, "#sc-subtotal-amount-activecart"))) ?? parseMoney(textOf(qs(doc, "#sc-subtotal-amount-buybox")));
  return { store: "amazon", storeDomain: DOMAIN, lines, subtotal: lines.length || !list ? subtotal : { cents: 0, currency: "USD" }, readAt: nowIso(), warnings };
}

export type CheckoutState =
  | "signin" | "mfa" | "captcha" | "membership_offer" | "address" | "payment" | "review" | "confirmation" | "unavailable" | "unknown";

/** Which checkout page Amazon shows, from its URL and HTML. */
export function amazonCheckoutState(url: string, html: string): CheckoutState {
  const doc = parseHtml(html);
  if (/\/errors\/validateCaptcha/.test(url) || qs(doc, "form[action*=\"validateCaptcha\"], #captchacharacters")) return "captcha";
  if (/\/ap\/(mfa|cvf|challenge)/.test(url) || qs(doc, "#auth-mfa-otpcode, input[name=\"otpCode\"], input[name=\"code\"][autocomplete=\"one-time-code\"]")) return "mfa";
  if (/\/ap\/(signin|register)|\/ax\/claim/.test(url) || qs(doc, "#ap_email, #ap_email_login, form[name=\"signIn\"], input#ap_password")) return "signin";
  if (/thankyou|\/buy\/thankyou|order-confirmation/i.test(url)) return "confirmation";
  const text = textOf(qs(doc, "body") ?? doc).slice(0, 20_000);
  if (qs(doc, "input[name=\"placeYourOrder1\"], #submitOrderButtonId, #placeOrder, #bottomSubmitOrderButtonId, #turbo-checkout-pyo-button")
    || /Place your order/.test(text) && /Order total/i.test(text)) return "review";
  // Seen live 2026-11-18: a bare page "You cannot buy this item because it's out of stock" right
  // after Proceed to checkout, for items the cart showed in stock a moment before.
  if (/cannot buy this item because it'?s out of stock/i.test(text)) return "unavailable";
  if (/prime/i.test(url) && /\/(checkout|gp\/buy)/.test(url)) return "membership_offer";
  if (/(Try|Start your|Get) .{0,30}(Prime|free trial)|Prime free trial|FREE trial of Prime/i.test(text)
    && qs(doc, "#prime-declineCTA, #prime-no-thanks, .prime-nothanks-button, a[id*=\"decline\"], a[id*=\"nothanks\"], button[id*=\"decline\"]")) return "membership_offer";
  if (qs(doc, "#address-ui-widgets-enterAddressFullName, form#address-ui-checkout-form, #address-ui-widgets-enterAddressLine1")
    || /(Add|Enter) a (new )?(delivery|shipping) address/i.test(text)) return "address";
  if (qs(doc, "input[name=\"addCreditCardNumber\"], #pp-add-credit-card, [data-testid=\"add-payment-method\"]")
    || /Add a (credit or debit )?card|Choose a payment method/i.test(text)) return "payment";
  return "unknown";
}

export function parseAmazonReview(html: string): Omit<CheckoutReview, "lines" | "reviewedAt"> & { total?: Money } {
  const doc = parseHtml(html);
  const box = qs(doc, "#subtotals-marketplace-table") ?? qs(doc, "#subtotals") ?? qs(doc, "#order-summary") ?? qs(doc, "[data-testid=\"order-summary\"]") ?? doc;
  const t = textOf(box);
  const pick = (re: RegExp) => { const m = re.exec(t); return m ? parseMoney(m[1]) : undefined; };
  const subtotal = pick(/Items(?:\s*\(\d+\))?:\s*(\$[\d,]+\.\d{2})/i);
  const shipping = pick(/Shipping (?:&|and) handling:\s*(\$[\d,]+\.\d{2}|FREE)/i);
  const tax = pick(/(?:Estimated tax to be collected|Estimated tax|Tax):\s*(\$[\d,]+\.\d{2})/i);
  const total = pick(/Order total:\s*(\$[\d,]+\.\d{2})/i) ?? pick(/\bTotal:\s*(\$[\d,]+\.\d{2})/i);
  const shipTo = shortAddress(qs(doc, "#deliver-to-address-text, .displayAddressDiv, [data-testid=\"shipping-address\"], #shipaddress, #deliver-to-customer-text"));
  const pm = /\b(Prime Visa|Amazon Visa|Amazon Store Card|American Express|Amex|Visa|Mastercard|MasterCard|Discover|JCB|Diners Club|Debit card|Credit card|Card)\s+ending in\s+(\d{4})/.exec(textOf(doc));
  return {
    store: "amazon", storeDomain: DOMAIN, subtotal, shipping, tax, total: total ?? { cents: 0, currency: "USD" },
    shipTo,
    paymentHint: pm ? `${pm[1].trim()} ending in ${pm[2]}` : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Amazon browser steps
// ---------------------------------------------------------------------------------------------

async function amazonBlocked(page: Page): Promise<boolean> {
  if (/\/errors\/validateCaptcha/.test(page.url())) return true;
  if (await page.locator("form[action*=\"validateCaptcha\"], #captchacharacters, form#checkpointForm, form[action*=\"/checkpoint/validate\"]").count().catch(() => 0)) return true;
  const title = await page.title().catch(() => "");
  if (/^Amazon\.com$/i.test(title.trim()) || /robot|captcha/i.test(title)) {
    const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 1500);
    return /continue shopping|characters you see|not a robot/i.test(body) && !(await page.locator("#nav-logo, #twotabsearchtextbox").count().catch(() => 0));
  }
  return false;
}

async function amazonPassBotCheck(ctx: StoreContext): Promise<void> {
  await passBotCheck(ctx, "Amazon", () => amazonBlocked(ctx.page), {
    retry: async () => {
      // Soft checks: an "I am human" box and a "Continue shopping" button; else reload.
      await clickFirstVisible(ctx.page, ["#continueCheck"]);
      await ctx.page.waitForTimeout(800);
      if (!(await clickFirstVisible(ctx.page, ["#checkpointForm button[type=\"submit\"]", "button:has-text(\"Continue shopping\")", "input[type=\"submit\"][value*=\"Continue\"]"]))) {
        await ctx.page.reload({ waitUntil: "domcontentloaded" });
      }
    },
  });
}

const SET_ZIP_JS = `async (zip) => {
  const el = document.querySelector("#nav-global-location-data-modal-action");
  if (!el) return "no-widget";
  const cfg = JSON.parse(el.getAttribute("data-a-modal") || "{}");
  const tok1 = cfg.ajaxHeaders ? cfg.ajaxHeaders["anti-csrftoken-a2z"] : "";
  const h = await (await fetch(cfg.url, { headers: { "anti-csrftoken-a2z": tok1 } })).text();
  const m = h.match(/CSRF_TOKEN\\s*:\\s*"([^"]+)"/);
  if (!m) return "no-token";
  const r = await fetch("/portal-migration/hz/glow/address-change?actionSource=glow", {
    method: "POST", headers: { "anti-csrftoken-a2z": m[1], "content-type": "application/json" },
    body: JSON.stringify({ locationType: "LOCATION_INPUT", zipCode: zip, deviceType: "web", storeContext: "generic", pageType: "Search", actionSource: "glow" }),
  });
  const b = await r.text();
  return r.ok && b.indexOf('"isAddressUpdated":1') >= 0 ? "ok" : "failed:" + r.status;
}`;

/** Make Amazon show US prices: set the delivery ZIP (ctx.zip, else 10001) when it shows another place. */
async function ensureUsLocation(ctx: StoreContext): Promise<boolean> {
  const page = ctx.page;
  const loc = clean(await page.locator("#glow-ingress-line2").first().textContent({ timeout: 3000 }).catch(() => null));
  if (!loc) return false;
  const want = ctx.zip;
  if (want ? loc.includes(want) : /\b\d{5}\b/.test(loc)) return false;
  const zip = want ?? "10001";
  const r = await page.evaluate(`(${SET_ZIP_JS})(${JSON.stringify(zip)})`).catch((e: Error) => `error:${e.message}`);
  ctx.log(`Amazon: delivery location "${loc}" set to ${zip}: ${r}`);
  if (r === "ok") { await page.reload({ waitUntil: "domcontentloaded" }); return true; }
  return false;
}

/** Amazon's "Sorry! Something went wrong" page (the dogs page): a soft block or a hiccup. */
export function isAmazonErrorPage(title: string, html: string): boolean {
  return /Sorry! Something went wrong/i.test(title) || /alt="Dogs of Amazon"|href="\/dogsofamazon/.test(html);
}

/**
 * Amazon's currency preference cookie. Outside the US, amazon.com converts prices to the local
 * currency (seen live 2026-11-19: "EUR 1,827.04", with its i18n-prefs cookie set to that currency). With
 * i18n-prefs=USD it shows US dollars again (checked live; the currency=USD URL parameter does
 * not do it on search pages). Set before every navigation unless it already says USD.
 */
export const AMAZON_USD_COOKIE = { name: "i18n-prefs", value: "USD", domain: ".amazon.com", path: "/" } as const;

export async function preferUsd(ctx: StoreContext): Promise<void> {
  try {
    const bc = ctx.page.context();
    const have = (await bc.cookies(AMZ)).find((c) => c.name === AMAZON_USD_COOKIE.name);
    if (have?.value === "USD") return;
    await bc.addCookies([{ ...AMAZON_USD_COOKIE, expires: Math.floor(Date.now() / 1000) + 365 * 86_400 }]);
    if (have) ctx.log(`Amazon: currency preference was ${have.value}; set to USD`);
  } catch (e) {
    ctx.log(`Amazon: could not set the USD currency preference (${(e as Error).message.split("\n")[0].slice(0, 100)})`);
  }
}

/** The non-USD currency of parsed offers, if any ("EUR"). */
export function foreignCurrency(offers: Offer[]): string | undefined {
  return offers.find((o) => o.price.currency !== "USD")?.price.currency;
}

async function gotoAmazon(ctx: StoreContext, url: string): Promise<void> {
  await preferUsd(ctx);
  await gotoRetry(ctx, url);
  await settleAmazon(ctx, url);
  await amazonPassBotCheck(ctx);
  if (await ensureUsLocation(ctx)) await settleAmazon(ctx, url);
}

/** Get past Amazon's error page: wait, visit the home page, retry the URL (twice), else throw. */
async function settleAmazon(ctx: StoreContext, url: string): Promise<void> {
  const page = ctx.page;
  for (let i = 0; i < 3; i++) {
    const title = await page.title().catch(() => "");
    if (!isAmazonErrorPage(title, title ? "" : await page.content().catch(() => ""))) break;
    if (i === 2) throw new Error("Amazon shows its error page (\"Sorry! Something went wrong\") to this browser. Try again later, or from another exit address.");
    ctx.log("Amazon: error page, waiting and retrying");
    await page.waitForTimeout(4000 + i * 6000);
    await page.goto(`${AMZ}/`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    await gotoRetry(ctx, url);
  }
}

const SET_QTY_JS = `(q) => {
  const b = Array.from(document.querySelectorAll("#add-to-cart-button")).find((x) => x.offsetParent !== null);
  const f = b ? b.closest("form") : null;
  const s = f ? f.querySelector("select[name='quantity']") : document.querySelector("select#quantity");
  if (!s) return q === 1 ? "ok" : "no-select";
  const opt = Array.from(s.options).find((o) => o.value === String(q));
  if (!opt) return "max:" + (s.options.length ? s.options[s.options.length - 1].value : "?");
  s.value = String(q);
  s.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}`;

async function readAmazonCart(ctx: StoreContext): Promise<Cart> {
  await gotoAmazon(ctx, `${AMZ}/gp/cart/view.html`);
  await ctx.page.waitForSelector("#sc-active-cart, #activeCartViewForm, [data-name=\"Active Items\"], .sc-your-amazon-cart-is-empty", { timeout: 15_000 }).catch(() => undefined);
  const cart = parseAmazonCart(await ctx.page.content());
  if (cart.warnings.includes("Amazon cart page did not load")) throw new Error(`Amazon cart page did not load (${(await ctx.page.title().catch(() => "")) || ctx.page.url()})`);
  return cart;
}

async function amazonSetCartQuantity(ctx: StoreContext, asin: string, quantity: number, current: number): Promise<void> {
  const page = ctx.page;
  const row = `div[data-itemtype="active"][data-asin="${asin}"]`;
  for (let q = current; q < quantity; q++) {
    const ok = await clickFirstVisible(page, [`${row} button[data-a-selector="increment"]`, `${row} [aria-label^="Increase quantity"]`, `${row} button[aria-label*="Increase"]`]);
    if (!ok) break;
    await page.waitForTimeout(1800);
  }
}

async function amazonCheckoutReview(ctx: StoreContext): Promise<CheckoutReview> {
  const cart = await readAmazonCart(ctx);
  if (!cart.lines.length) throw new Error("Amazon cart is empty");
  const page = ctx.page;
  const base = { lines: cart.lines, subtotal: cart.subtotal, total: cart.subtotal ?? sumLines(cart.lines) };
  const stop = async (reason: NeedsUser["reason"], message: string): Promise<CheckoutReview> => ({
    store: "amazon", storeDomain: DOMAIN, ...base, needsUser: await needsUser(ctx, reason, message), reviewedAt: nowIso(),
  });
  const clicked = await clickFirstVisible(page, ["input[name=\"proceedToRetailCheckout\"]", "#sc-buy-box-ptc-button input", "[data-feature-id=\"proceed-to-checkout-action\"]"]);
  if (!clicked) await page.goto(`${AMZ}/gp/cart/desktop/go-to-checkout.html`, { waitUntil: "domcontentloaded" });
  let declined = 0;
  let unavailable = 0;
  for (let step = 0; step < 8; step++) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    const state = amazonCheckoutState(page.url(), await page.content());
    ctx.log(`Amazon checkout: ${state}`);
    switch (state) {
      case "signin": return stop("sign_in", "Amazon asks you to sign in. Open the live link, sign in, then run checkout again.");
      case "mfa": return stop("verification_code", "Amazon asks for a verification code. Open the live link and enter it.");
      case "captcha":
        try { await amazonPassBotCheck(ctx); } catch (e) {
          if (e instanceof CaptchaHandoffError) return { store: "amazon", storeDomain: DOMAIN, ...base, needsUser: e.handoff, reviewedAt: nowIso() };
          throw e;
        }
        continue;
      case "membership_offer":
        if (declined++ < 3 && await declineOffer(page, ["#prime-declineCTA", "#prime-no-thanks", ".prime-nothanks-button", "a[id*=\"nothanks\"]", "a[id*=\"decline\"]", "button[id*=\"decline\"]"])) continue;
        return stop("other", "Amazon shows a Prime or trial offer that could not be declined safely. Open the live link and decline it.");
      case "address": return stop("address", "Amazon needs a delivery address. Open the live link and add it.");
      case "payment": return stop("payment", "Amazon needs a payment method. Open the live link and choose one.");
      case "unavailable":
        if (unavailable++ === 0) {
          // Once: back to the cart and Proceed to checkout again.
          ctx.log("Amazon checkout says an item is out of stock; going back to the cart and trying once more");
          await readAmazonCart(ctx);
          if (!(await clickFirstVisible(page, ["input[name=\"proceedToRetailCheckout\"]", "#sc-buy-box-ptc-button input", "[data-feature-id=\"proceed-to-checkout-action\"]"]))) {
            await page.goto(`${AMZ}/gp/cart/desktop/go-to-checkout.html`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
          }
          continue;
        }
        return stop("other", "Amazon's checkout says an item in the cart is out of stock, although the cart shows it. Open the live link to choose another seller or item.");
      case "review": {
        const r = parseAmazonReview(await page.content());
        if (!r.total || r.total.cents === 0) return stop("other", "Amazon's order review did not show a total. Open the live link to check it.");
        return { ...r, lines: cart.lines, total: r.total, reviewedAt: nowIso() };
      }
      default: continue;
    }
  }
  return stop("other", "Amazon checkout showed a page the agent does not know. Open the live link to continue.");
}

const adapter: StoreAdapter = {
  id: "amazon",
  name: "Amazon",
  domains: ["amazon.com", "www.amazon.com"],

  searchUrl(query: string): string {
    return `${AMZ}/s?k=${encodeURIComponent(query).replace(/%20/g, "+")}`;
  },

  async search(ctx, item, limit) {
    const url = this.searchUrl(item.query, DOMAIN);
    await gotoAmazon(ctx, url);
    await ctx.page.waitForSelector("div[data-component-type=\"s-search-result\"]", { timeout: 15_000 }).catch(() => undefined);
    let offers = parseAmazonSearch(await ctx.page.content(), item.id);
    const foreign = foreignCurrency(offers);
    if (foreign) {
      // Amazon kept the local currency (it may set the cookie back after the delivery location
      // changed): ask for USD again and load the search once more. Offers still in another
      // currency are marked by the engine and never picked.
      ctx.log(`Amazon: prices shown in ${foreign}; asking for US dollars and loading the search again`);
      await gotoAmazon(ctx, url);
      await ctx.page.waitForSelector("div[data-component-type=\"s-search-result\"]", { timeout: 15_000 }).catch(() => undefined);
      offers = parseAmazonSearch(await ctx.page.content(), item.id);
      const still = foreignCurrency(offers);
      if (still) ctx.log(`Amazon: prices still in ${still} after asking for USD`);
    }
    if (!offers.length) {
      ctx.log(`Amazon: no results parsed on "${await ctx.page.title().catch(() => "")}", loading the search again`);
      await gotoAmazon(ctx, url);
      await ctx.page.waitForSelector("div[data-component-type=\"s-search-result\"]", { timeout: 15_000 }).catch(() => undefined);
      offers = parseAmazonSearch(await ctx.page.content(), item.id);
    }
    if (!offers.length) offers = await aiSearchFallback(ctx, { store: "amazon", domain: DOMAIN, url, item, limit, idHint: "the ASIN", productId: (u) => asinFromUrl(u), productUrl: amazonProductUrl });
    return offers.slice(0, limit);
  },

  async details(ctx, offer) {
    const asin = offer.productId ?? asinFromUrl(offer.url);
    await gotoAmazon(ctx, asin ? `${amazonProductUrl(asin)}?th=1&psc=1` : offer.url);
    await ctx.page.waitForSelector("#productTitle", { timeout: 15_000 }).catch(() => undefined);
    const html = await ctx.page.content();
    const p = parseAmazonProduct(html);
    const ids = mergeIds(amazonIds(html), offer.ids);
    const raw = { ...(offer.raw ?? {}) };
    if (p.variantChoices) raw.variantChoices = p.variantChoices;
    if (p.selected) raw.selectedOptions = p.selected;
    if (p.primeOnlyDefault) raw.primePriceShownFirst = true;
    if (p.freeShippingOver) raw.freeShippingOver = p.freeShippingOver;
    return {
      ...offer,
      title: p.title ?? offer.title,
      productId: p.asin ?? offer.productId,
      url: p.asin ? amazonProductUrl(p.asin) : offer.url,
      price: p.price ?? offer.price,
      listPrice: p.listPrice ?? offer.listPrice,
      seller: p.seller ?? offer.seller,
      deliveryText: p.deliveryText ?? offer.deliveryText,
      deliveryDate: p.deliveryDate ?? offer.deliveryDate,
      shipping: p.shipping ?? offer.shipping,
      rating: p.rating ?? offer.rating,
      inStock: p.inStock,
      variants: p.variants ?? offer.variants,
      image: offer.image ?? p.image,
      subscription: false,
      ...(p.subscribeAndSave || offer.subscribeAndSaveAvailable ? { subscribeAndSaveAvailable: true } : {}),
      ...(ids ? { ids } : {}),
      raw,
    };
  },

  async addToCart(ctx, offer, quantity, options) {
    const page = ctx.page;
    const asin0 = offer.productId ?? asinFromUrl(offer.url);
    if (!asin0) throw new Error("Amazon offer has no ASIN");
    await gotoAmazon(ctx, `${amazonProductUrl(asin0)}?th=1&psc=1`);
    await page.waitForSelector("#productTitle", { timeout: 15_000 }).catch(() => undefined);
    let prod = parseAmazonProduct(await page.content());
    let target = prod.asin ?? asin0;
    const wanted = options && Object.keys(options).length ? options : undefined;
    const warnings: string[] = [];
    if (wanted) {
      if (!prod.variantChoices?.length) {
        warnings.push(`Amazon shows no options for ${target}; asked for ${Object.entries(wanted).map(([k, v]) => `${k} "${v}"`).join(", ")}`);
      } else {
        const pick = pickVariant(prod.variantChoices, wanted);
        if (!pick.id) throw new Error(`Amazon: ${pick.reason}`);
        if (pick.id !== prod.asin) {
          target = pick.id;
          await gotoAmazon(ctx, `${amazonProductUrl(target)}?th=1&psc=1`);
          await page.waitForSelector("#productTitle", { timeout: 15_000 }).catch(() => undefined);
          prod = parseAmazonProduct(await page.content());
        }
        if (prod.asin !== target) warnings.push(`Amazon opened ${prod.asin ?? "another item"} instead of ${target}`);
        warnings.push(...optionWarnings("Amazon product page", wanted, prod.selected).map((w) => w.replace("did not stick", "is not selected")));
      }
    }
    // One-time purchase from the regular new offer, never the Prime-only or subscription row.
    const newRow = page.locator("[id^=\"newAccordionRow\"]").first();
    if (await newRow.count()) {
      const cls = (await newRow.getAttribute("class").catch(() => "")) ?? "";
      if (!cls.includes("a-accordion-active")) {
        await newRow.locator(".accordion-header, .a-accordion-row").first().click({ timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(1200);
      }
    }
    let added = false;
    const atc = page.locator("#add-to-cart-button:visible").first();
    if (await atc.count()) {
      const q = await page.evaluate(`(${SET_QTY_JS})(${quantity})`).catch(() => "error");
      if (q !== "ok") ctx.log(`Amazon quantity select: ${q}`);
      await atc.click({ timeout: 15_000, noWaitAfter: true }).catch(async (e: Error) => {
        // Covered or never "stable" on a slow page: press the same button from the page itself.
        ctx.log(`Amazon Add to cart click: ${e.message.split("\n")[0].slice(0, 100)}; pressing it from the page`);
        await atc.evaluate((el: any) => el.click());
      });
      await page.waitForLoadState("domcontentloaded", { timeout: 45_000 }).catch(() => undefined);
      await page.waitForTimeout(2500);
      // Decline protection plans offered in a side sheet.
      await clickFirstVisible(page, ["#attachSiNoCoverage input", "#attachSiNoCoverage", "button:has-text(\"No Thanks\")", "#attach-close_sideSheet-link"]);
      await page.waitForTimeout(1000);
      added = true;
    }
    let cart = await readAmazonCart(ctx);
    let line = cart.lines.find((l) => l.productId === target);
    if (!line && !added) {
      // No add button on the page: the old cart-add URL adds the featured offer of an ASIN.
      await gotoAmazon(ctx, `${AMZ}/gp/aws/cart/add.html?ASIN.1=${target}&Quantity.1=${quantity}`);
      await clickFirstVisible(page, ["input[name=\"add\"]", "input[value=\"Continue\"]", "#a-autoid-0 input"]);
      await page.waitForTimeout(2500);
      cart = await readAmazonCart(ctx);
      line = cart.lines.find((l) => l.productId === target);
    }
    if (!line) {
      const opt = wanted ? ` with ${Object.entries(wanted).map(([k, v]) => `${k} "${v}"`).join(", ")}` : "";
      await ctx.aiTask(
        `On ${amazonProductUrl(target)}, add ${quantity} of this exact item${opt} to the cart as a one-time purchase. ` +
        `Choose the regular price, not Subscribe & Save, not a Prime-only price, not used. Decline Prime, trials and protection plans. Do not check out.`,
        { startUrl: `${amazonProductUrl(target)}?th=1&psc=1`, maxSteps: 12, sameBrowser: true },
      ).catch((e: Error) => ctx.log(`Amazon AI add-to-cart failed: ${e.message}`));
      cart = await readAmazonCart(ctx);
      line = cart.lines.find((l) => l.productId === target);
    }
    if (line && line.quantity < quantity) {
      await amazonSetCartQuantity(ctx, target, quantity, line.quantity);
      cart = await readAmazonCart(ctx);
      line = cart.lines.find((l) => l.productId === target);
    }
    cart.warnings.push(...warnings);
    if (!line) {
      cart.warnings.push(`Amazon cart does not show ${target} after adding it`);
      return cart;
    }
    if (line.quantity !== quantity) cart.warnings.push(`Amazon cart has quantity ${line.quantity}, wanted ${quantity}`);
    if (wanted && prod.variantChoices?.length) {
      // The ASIN is the variant, so a cart line with the target ASIN has the wanted options even when
      // the cart does not list every one of them.
      cart.warnings.push(...optionWarnings("Amazon", wanted, line.options).filter((w) => !(line!.productId === target && /does not show option/.test(w))));
    }
    const unit = Math.round(line.price.cents / line.quantity);
    const expected = target !== (offer.productId ?? asin0) ? prod.price : offer.price;
    if (expected && unit !== expected.cents) cart.warnings.push(`Amazon cart price ${formatMoney({ cents: unit, currency: line.price.currency })} differs from the product page price ${formatMoney(expected)}`);
    return cart;
  },

  readCart: readAmazonCart,

  async clearCart(ctx) {
    await readAmazonCart(ctx);
    for (let i = 0; i < 30; i++) {
      const ok = await clickFirstVisible(ctx.page, [
        "div[data-itemtype=\"active\"] input[data-action=\"delete-active\"]",
        "div[data-itemtype=\"active\"] input[value=\"Delete\"]",
        "div[data-itemtype=\"active\"] [data-feature-id=\"item-delete-button\"] input",
      ]);
      if (!ok) break;
      await ctx.page.waitForTimeout(1800);
    }
  },

  reviewCheckout: amazonCheckoutReview,

  async placeOrder(ctx, approval) {
    if (approval.store !== "amazon") throw new Error("approval is for another store");
    const review = await amazonCheckoutReview(ctx);
    if (review.needsUser) return { store: "amazon", placed: false, needsUser: review.needsUser };
    if (!approvalMatches(review.total, approval)) {
      return { store: "amazon", placed: false, total: review.total, error: `Amazon total is now ${formatMoney(review.total)}, approved ${formatMoney(approval.approvedTotal)}; order not placed` };
    }
    const page = ctx.page;
    const clicked = await clickFirstVisible(page, ["input[name=\"placeYourOrder1\"]", "#submitOrderButtonId input", "#placeOrder", "#bottomSubmitOrderButtonId input", "#turbo-checkout-pyo-button"], 15_000);
    if (!clicked) return { store: "amazon", placed: false, error: "Amazon's Place your order button was not found; order not placed" };
    // From here the click was sent: every result says submitted, so the engine never clicks again.
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1500);
      const url = page.url();
      const state = amazonCheckoutState(url, await page.content());
      if (state === "mfa") return { store: "amazon", placed: false, submitted: true, needsUser: await needsUser(ctx, "3ds", "Amazon or your bank asks to verify the payment. Open the live link.") };
      const body = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
      if (state === "confirmation" || /Order placed, thank you|Thank you, your order has been placed/i.test(body)) {
        return {
          store: "amazon", placed: true, submitted: true, orderId: /\b(\d{3}-\d{7}-\d{7})\b/.exec(body)?.[1], total: review.total,
          confirmationText: clean(/(Order placed, thank you!?|Thank you, your order has been placed\.?)/i.exec(body)?.[1]), placedAt: nowIso(),
        } satisfies OrderResult;
      }
    }
    return { store: "amazon", placed: false, submitted: true, needsUser: await needsUser(ctx, "other", "Amazon did not show an order confirmation. Open the live link to check before trying again.") };
  },
};

export default adapter;
