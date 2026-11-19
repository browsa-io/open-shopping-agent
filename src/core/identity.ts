// Same-item matching across stores. Product pages name the product with a GTIN (UPC, EAN), and
// with the brand and the manufacturer part number (MPN); this module reads them from JSON-LD,
// microdata and spec tables, normalises them, and says whether two offers are the same product.
//
//   exact   = the same GTIN, or (when either side has no GTIN) the same brand and the same MPN
//   similar = anything else, including "not enough data to tell"
//
// Two different GTINs are two different products even when brand and MPN agree (colours and sizes
// of one model share an MPN but not a GTIN). Similar offers are labelled, never dropped.

import type { Offer, ProductIds } from "./types.js";

type J = Record<string, any>;

// ---------------------------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------------------------

/** True when the last digit is the GS1 check digit of the others. */
export function gtinCheckOk(digits: string): boolean {
  if (!/^\d{8,14}$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** A GTIN-8/12/13/14 (UPC, EAN) as GTIN-14 digits, or undefined when it is not a valid one. */
export function normalizeGtin(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const d = String(v).trim().replace(/[\s-]/g, "");
  if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length) || /^0+$/.test(d)) return undefined;
  if (!gtinCheckOk(d)) return undefined;
  return d.padStart(14, "0");
}

const PLACEHOLDER = /^(n\/?a|none|null|unknown|does ?not ?apply|not ?applicable|unbranded|generic|no ?brand|other|see ?description|-+)$/i;

/** An MPN as upper-case letters and digits, or undefined for placeholders and too-short values. */
export function normalizeMpn(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const t = String(v).trim();
  if (!t || PLACEHOLDER.test(t)) return undefined;
  const n = t.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Short or digit-free values ("BLACK", "XL") are too often not a part number.
  if (n.length < 3 || (!/\d/.test(n) && n.length < 6)) return undefined;
  return n.slice(0, 40);
}

/** A brand as lower-case letters and digits ("Logitech, Inc." -> "logitech"), or undefined. */
export function normalizeBrand(v: unknown): string | undefined {
  const raw = typeof v === "string" ? v : v && typeof v === "object" ? (v as J).name : undefined;
  if (typeof raw !== "string") return undefined;
  let t = raw.trim()
    .replace(/^visit the\s+(.+?)\s+store$/i, "$1")
    .replace(/^(brand|by|manufacturer)\s*:?\s+/i, "")
    .replace(/[®™©]/g, "");
  if (!t || PLACEHOLDER.test(t)) return undefined;
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[,.]?\s+(inc|llc|ltd|limited|co|corp|corporation|company|gmbh|plc)\.?$/i, "")
    .replace(/[^a-z0-9]/g, "");
  return t.length >= 2 && !PLACEHOLDER.test(t) ? t.slice(0, 60) : undefined;
}

/** Normalise loosely given identifiers (any of gtin/upc/ean/mpn/brand/sku, raw values). */
export function normalizeIds(input: { gtin?: unknown; gtins?: unknown[]; mpn?: unknown; brand?: unknown; sku?: unknown } | undefined): ProductIds | undefined {
  if (!input) return undefined;
  const gtins = [...new Set([input.gtin, ...(input.gtins ?? [])].map(normalizeGtin).filter((g): g is string => !!g))];
  const out: ProductIds = {};
  if (gtins.length) out.gtin = gtins[0];
  if (gtins.length > 1) out.otherGtins = gtins.slice(1, 6);
  const mpn = normalizeMpn(input.mpn);
  if (mpn) out.mpn = mpn;
  const brand = normalizeBrand(input.brand);
  if (brand) out.brand = brand;
  if ((typeof input.sku === "string" || typeof input.sku === "number") && String(input.sku).trim()) out.sku = String(input.sku).trim().slice(0, 60);
  return Object.keys(out).length ? out : undefined;
}

/** Keep `a`'s values, fill the gaps from `b`. Already normalised ids only. */
export function mergeIds(a: ProductIds | undefined, b: ProductIds | undefined): ProductIds | undefined {
  if (!a) return b;
  if (!b) return a;
  const gtins = [...new Set([a.gtin, ...(a.otherGtins ?? []), b.gtin, ...(b.otherGtins ?? [])].filter((g): g is string => !!g))];
  const out: ProductIds = { ...b, ...a };
  delete out.otherGtins;
  if (gtins.length) out.gtin = a.gtin ?? gtins[0];
  const others = gtins.filter((g) => g !== out.gtin);
  if (others.length) out.otherGtins = others.slice(0, 6);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading identifiers from pages
// ---------------------------------------------------------------------------------------------

const GTIN_KEYS = ["gtin14", "gtin13", "gtin12", "gtin8", "gtin", "upc", "ean"];

function isProduct(o: J): boolean {
  const t = o?.["@type"];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && /^(Product|ProductGroup|IndividualProduct|ProductModel|Vehicle)$/i.test(x.replace(/^.*[/#]/, "")));
}

function gtinsOf(o: J | undefined): string[] {
  if (!o || typeof o !== "object") return [];
  const out: string[] = [];
  for (const k of GTIN_KEYS) {
    const v = o[k];
    for (const x of Array.isArray(v) ? v : [v]) {
      const g = normalizeGtin(x);
      if (g) out.push(g);
    }
  }
  return out;
}

/**
 * Identifiers from the JSON-LD objects of a product page (util.jsonLd output). Product-level GTINs
 * win; otherwise the offers' GTINs when they all name one product (a ProductGroup page that lists
 * every colour's GTIN names none of them). `variantSku` picks one offer by SKU.
 */
export function idsFromJsonLd(objects: J[], variantSku?: string): ProductIds | undefined {
  const products = objects.filter(isProduct);
  if (!products.length) return undefined;
  const p = products[0];
  let gtins = gtinsOf(p);
  const offers: J[] = Array.isArray(p.offers) ? p.offers : p.offers ? [p.offers] : [];
  const variants: J[] = Array.isArray(p.hasVariant) ? p.hasVariant : [];
  if (!gtins.length) {
    const pool = [...offers, ...variants];
    const bySku = variantSku ? pool.find((o) => String(o?.sku ?? "") === variantSku) : undefined;
    if (bySku) gtins = gtinsOf(bySku);
    else {
      const all = [...new Set(pool.flatMap(gtinsOf))];
      if (all.length === 1) gtins = all;
    }
  }
  const mpnSrc = p.mpn ?? (typeof p.model === "string" ? p.model : p.model?.mpn) ?? offers.find((o) => o?.mpn)?.mpn;
  return normalizeIds({ gtin: gtins[0], gtins: gtins.slice(1), mpn: mpnSrc, brand: p.brand ?? p.manufacturer, sku: p.sku });
}

/** Microdata and meta tags: itemprop="gtin13" content="...", itemprop="mpn", itemprop="brand". */
export function idsFromMicrodata(html: string): ProductIds | undefined {
  const found: Record<string, string> = {};
  const re = /<(?:meta|span|div|link|td|dd)\b[^>]*\bitemprop=["'](gtin(?:8|12|13|14)?|mpn|sku)["'][^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const content = /\bcontent=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (content && !found[m[1].toLowerCase()]) found[m[1].toLowerCase()] = content;
  }
  const brand = /<[^>]*\bitemprop=["']brand["'][^>]*\bcontent=["']([^"']+)["']/i.exec(html)?.[1];
  const meta = /<meta[^>]*\bproperty=["'](?:product|og):upc["'][^>]*\bcontent=["']([^"']+)["']/i.exec(html)?.[1];
  const gtin = found.gtin14 ?? found.gtin13 ?? found.gtin12 ?? found.gtin8 ?? found.gtin ?? meta;
  return normalizeIds({ gtin, mpn: found.mpn, brand, sku: found.sku });
}

/** JSON-LD first, microdata for the gaps. */
export function idsFromHtml(html: string, jsonLdObjects: J[], variantSku?: string): ProductIds | undefined {
  return mergeIds(idsFromJsonLd(jsonLdObjects, variantSku), idsFromMicrodata(html));
}

/**
 * Spec table rows as [label, value] (Amazon's product details, eBay item specifics, Walmart
 * specifications): UPC, EAN, GTIN, model and part numbers, brand.
 */
export function idsFromSpecs(rows: [string, string][]): ProductIds | undefined {
  const gtins: string[] = [];
  let mpn: string | undefined;
  let model: string | undefined;
  let brand: string | undefined;
  for (const [label0, value] of rows) {
    const label = label0.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
    if (/^(upc|ean|gtin|isbn 13|global trade identification number|international article number|universal product code)\b/.test(label)) {
      for (const tok of value.split(/[\s,;/]+/)) { const g = normalizeGtin(tok); if (g) gtins.push(g); }
    } else if (/^(manufacturer part number|mpn|part number|manufacturer part)$/.test(label)) mpn ??= value;
    else if (/^(item model number|model number|model|model no|manufacturer model number)$/.test(label)) model ??= value;
    else if (/^(brand|brand name)$/.test(label)) brand ??= value;
  }
  const uniq = [...new Set(gtins)];
  return normalizeIds({ gtin: uniq[0], gtins: uniq.slice(1), mpn: mpn ?? model, brand });
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

export interface SameItem {
  match: "exact" | "similar";
  by?: "gtin" | "brand_mpn";
}

function gtinSet(ids: ProductIds | undefined): Set<string> {
  return new Set([ids?.gtin, ...(ids?.otherGtins ?? [])].filter((g): g is string => !!g));
}

/** Is `b` the same product as `a`? Exact only on proof: a shared GTIN, or the same brand and MPN. */
export function sameItem(a: Pick<Offer, "ids">, b: Pick<Offer, "ids">): SameItem {
  const ga = gtinSet(a.ids);
  const gb = gtinSet(b.ids);
  if (ga.size && gb.size) {
    for (const g of ga) if (gb.has(g)) return { match: "exact", by: "gtin" };
    return { match: "similar" };
  }
  if (a.ids?.brand && a.ids?.mpn && a.ids.brand === b.ids?.brand && a.ids.mpn === b.ids?.mpn) return { match: "exact", by: "brand_mpn" };
  return { match: "similar" };
}

/** Copies of `offers` labelled relative to `ref` (the chosen item). `ref` itself is returned unlabelled. */
export function labelSameItem(ref: Offer, offers: Offer[]): Offer[] {
  return offers.map((o) => {
    if (o === ref || (o.store === ref.store && o.url === ref.url)) return o;
    const s = sameItem(ref, o);
    const out: Offer = { ...o, match: s.match };
    if (s.by) out.matchBy = s.by; else delete out.matchBy;
    return out;
  });
}

/** One short line for a label: "Same GTIN" / "Same brand and model number" / "Not confirmed as the same product". */
export function matchText(o: Pick<Offer, "match" | "matchBy">): string {
  if (o.match === "exact") return o.matchBy === "gtin" ? "Exact match: same GTIN (UPC/EAN)" : "Exact match: same brand and model number";
  return "Similar: not confirmed as the same product";
}
