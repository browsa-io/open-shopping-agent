// Price per unit: read what one offer contains ("Pack of 24", "2 x 1L", "500 ml", "12 Count
// (Pack of 2)") and turn the price into a comparable "$0.42 / count" or "$0.08 / fl oz".
//
// It refuses to guess: two different sizes in one title ("500 ml / 1 L"), ranges ("12-24 count"),
// choices ("24 or 48 count") or two unrelated counts ("12 rolls = 48 regular rolls") give nothing.
// A unit price the store shows itself wins over one read from the title.
//
// Ranking uses it only as a tie-breaker (same score and same delivered total); front ends offer it
// as a sort the person picks. The default ranking does not change.

import type { Contents, Money, Offer, PerUnit } from "./types.js";

type Kind = "count" | "volume" | "weight";
type Per = PerUnit["per"];

const ML_PER_FL_OZ = 29.5735;
const G_PER_OZ = 28.3495;

interface UnitDef { re: RegExp; kind: "volume" | "weight"; factor: number; label: string }

// Longest spellings first. The factor converts to ml or g.
const UNITS: UnitDef[] = [
  { re: /^(?:fl\.?\s*oz\.?|fluid\s+ounces?|fl\.?\s*ounces?)$/i, kind: "volume", factor: ML_PER_FL_OZ, label: "fl oz" },
  { re: /^(?:millilit(?:er|re)s?|ml)$/i, kind: "volume", factor: 1, label: "ml" },
  { re: /^(?:centilit(?:er|re)s?|cl)$/i, kind: "volume", factor: 10, label: "cl" },
  { re: /^(?:lit(?:er|re)s?|ltr|l)$/i, kind: "volume", factor: 1000, label: "l" },
  { re: /^(?:gallons?|gal)$/i, kind: "volume", factor: 3785.41, label: "gal" },
  { re: /^(?:quarts?|qt)$/i, kind: "volume", factor: 946.353, label: "qt" },
  { re: /^(?:pints?|pt)$/i, kind: "volume", factor: 473.176, label: "pt" },
  { re: /^(?:ounces?|oz\.?)$/i, kind: "weight", factor: G_PER_OZ, label: "oz" },
  { re: /^(?:pounds?|lbs?\.?)$/i, kind: "weight", factor: 453.592, label: "lb" },
  { re: /^(?:kilograms?|kgs?)$/i, kind: "weight", factor: 1000, label: "kg" },
  { re: /^(?:grams?|gr|g)$/i, kind: "weight", factor: 1, label: "g" },
  { re: /^(?:milligrams?|mg)$/i, kind: "weight", factor: 0.001, label: "mg" },
];
const UNIT_SRC = String.raw`(fl\.?\s*oz\.?|fluid\s+ounces?|fl\.?\s*ounces?|millilit(?:er|re)s?|ml|centilit(?:er|re)s?|cl|lit(?:er|re)s?|ltr|l|gallons?|gal|quarts?|qt|pints?|pt|ounces?|oz\.?|pounds?|lbs?\.?|kilograms?|kgs?|grams?|gr|g|milligrams?|mg)`;
const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const COUNT_NOUN = String.raw`(count|ct|cnt|pcs|pc|pieces?|units?|ea|rolls?|pods?|cans?|bottles?|bars?|tablets?|capsules?|caplets?|softgels?|gummies|bags?|packets?|sachets?|sheets?|wipes?|batteries|cells|diapers|filters|cartridges|k-?cups?)`;

function unitDef(text: string): UnitDef | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  return UNITS.find((u) => u.re.test(t));
}

interface Measure { kind: "volume" | "weight"; base: number; text: string }
interface Num { n: number; paren: boolean; noun: string; text: string }

/** Why a title gave no contents, for tests and logs; undefined when it gave some. */
export type Refusal = "none" | "ambiguous_size" | "ambiguous_count" | "range" | "out_of_range";

/** Contents of one offer from its title (or any product text), or why not. */
export function explainContents(text: string): { contents?: Contents; refused?: Refusal } {
  let s = ` ${String(text ?? "")} `.replace(/[×✕✖]/g, "x").replace(/(\d),(\d{3})(?!\d)/g, "$1$2").replace(/\s+/g, " ");
  // A range or a choice of sizes or counts: never guess which one the price is for.
  if (new RegExp(String.raw`\b\d+(?:\.\d+)?\s*(?:-|–|to|or|/)\s*\d+(?:\.\d+)?\s*-?\s*(?:${UNIT_SRC}|${COUNT_NOUN}|packs?|pk)\b`, "i").test(s)) return { refused: "range" };
  if (/\bvariety\s+of\s+sizes\b|\bassorted\s+sizes\b|\bmultiple\s+sizes\b/i.test(s)) return { refused: "ambiguous_size" };

  const measures: Measure[] = [];
  const counts: Num[] = [];
  const packs: Num[] = [];
  let mult: number | undefined;

  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    s = s.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      return fn(m) === false ? m[0] : " ";
    });
  };
  const measure = (num: string, unit: string, raw: string): Measure | undefined => {
    const u = unitDef(unit);
    if (!u) return undefined;
    // "5G" or "4G LTE" is a network, not 5 grams: grams only in lower case or spelled out.
    if (u.label === "g" && /^G/.test(unit)) return undefined;
    const v = parseFloat(num);
    if (!(v > 0)) return undefined;
    return { kind: u.kind, base: v * u.factor, text: raw.trim().replace(/\s+/g, " ") };
  };

  // "2 x 1L", "6 x 12 fl oz"
  take(new RegExp(String.raw`\b(\d{1,4})\s*x\s*${NUM}\s*-?\s*${UNIT_SRC}(?![a-z])`, "gi"), (m) => {
    const me = measure(m[2], m[3], m[0]);
    const n = parseInt(m[1], 10);
    if (!me || !(n > 0)) return false;
    measures.push({ ...me, base: me.base * n });
    counts.push({ n, paren: false, noun: "x", text: `${n} x` });
    mult = n;
  });
  // "500ml x 6"
  take(new RegExp(String.raw`${NUM}\s*-?\s*${UNIT_SRC}\s*x\s*(\d{1,4})\b`, "gi"), (m) => {
    const me = measure(m[1], m[2], m[0]);
    const n = parseInt(m[3], 10);
    if (!me || !(n > 0)) return false;
    measures.push({ ...me, base: me.base * n });
    counts.push({ n, paren: false, noun: "x", text: `x ${n}` });
    mult = n;
  });
  // "Pack of 24", "(Pack of 2)", "Set of 4", "Case of 12"
  take(/(\()?\s*\b(?:pack|set|case|box|bundle|lot)\s+of\s+(\d{1,5})\b/gi, (m) => {
    packs.push({ n: parseInt(m[2], 10), paren: !!m[1], noun: "pack", text: m[0].replace(/[()]/g, "").trim() });
  });
  // "24 Pack", "24-pack", "6pk"
  take(/\b(\d{1,5})\s*-?\s*(?:packs?|pk)\b/gi, (m) => {
    packs.push({ n: parseInt(m[1], 10), paren: false, noun: "pack", text: m[0].trim() });
  });
  // "12 Count", "48 ct", "4 pcs", "24 cans"
  take(new RegExp(String.raw`\b(\d{1,5})\s*-?\s*${COUNT_NOUN}\b`, "gi"), (m) => {
    counts.push({ n: parseInt(m[1], 10), paren: false, noun: m[2].toLowerCase().replace(/s$/, ""), text: m[0].trim() });
  });
  // "500 ml", "1.5 L", "16 oz", "2 lb"
  let total = false;
  take(new RegExp(String.raw`(?<![\w.])${NUM}\s*-?\s*${UNIT_SRC}(?![a-z])(\s+total)?`, "gi"), (m) => {
    const me = measure(m[1], m[2], m[0].replace(/\s+total$/i, ""));
    if (!me) return false;
    if (m[3]) total = true;
    measures.push(me);
  });

  // Sizes: at most one, after removing exact repeats ("6 x 500 ml (3 l)" names 3 l twice).
  // Two spellings of one size ("3.4 fl oz / 100 ml") are within 3% of each other: one size.
  const sizes: Measure[] = [];
  for (const m of measures) if (!sizes.some((x) => x.kind === m.kind && Math.abs(x.base - m.base) <= 0.03 * Math.max(x.base, m.base))) sizes.push(m);
  if (sizes.length > 1) {
    // "6 x 500 ml, 3 l" or a total equal to the multiplied size is fine; anything else is a guess.
    const multiplied = mult ? sizes.filter((m) => sizes.some((x) => x !== m && Math.abs(x.base - m.base * mult!) < 0.5)) : [];
    if (!(sizes.length === 2 && multiplied.length === 1 && sizes[0].kind === sizes[1].kind)) return { refused: "ambiguous_size" };
    sizes.splice(sizes.indexOf(multiplied[0]), 1);
  }

  // Counts: one number, or a count times a "(Pack of N)".
  const all = [...counts, ...packs];
  const nums = [...new Set(all.map((x) => x.n))];
  let count: number | undefined;
  let countText = "";
  if (nums.length === 1) {
    count = nums[0];
    countText = `${count} count`;
  } else if (nums.length === 2) {
    const parenPacks = packs.filter((p) => p.paren);
    const outer = parenPacks.length === 1 ? parenPacks[0] : undefined;
    const inner = outer ? all.filter((x) => x.n !== outer.n) : [];
    if (!outer || !inner.length || new Set(inner.map((x) => x.n)).size !== 1) return { refused: "ambiguous_count" };
    count = inner[0].n * outer.n;
    countText = `${outer.n} x ${inner[0].n} count`;
  } else if (nums.length > 2) {
    return { refused: "ambiguous_count" };
  }
  if (count !== undefined && (count <= 0 || count > 100_000)) return { refused: "out_of_range" };

  let size = sizes[0];
  if (size && count !== undefined && !mult && !total) {
    // A size next to a count is the size of one piece ("12 fl oz, 12 Pack").
    size = { ...size, base: size.base * count, text: `${count} x ${size.text}` };
  } else if (size && count !== undefined && mult && count !== mult) {
    // "2 x 1 l (Pack of 3)": the outer pack multiplies the size too.
    if (count % mult !== 0) return { refused: "ambiguous_count" };
    size = { ...size, base: size.base * (count / mult), text: `${count / mult} x ${size.text}` };
  }
  if (!size && count === undefined) return { refused: "none" };
  if (size && (size.base <= 0 || size.base > 1e7)) return { refused: "out_of_range" };

  const c: Contents = { source: "title", text: size ? size.text : countText };
  if (count !== undefined) c.count = count;
  if (size?.kind === "volume") c.ml = round(size.base, 3);
  if (size?.kind === "weight") c.g = round(size.base, 3);
  return { contents: c };
}

/** Contents of one offer from its title, or undefined when unknown or ambiguous. */
export function readContents(text: string): Contents | undefined {
  return explainContents(text).contents;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------------------------
// Unit prices
// ---------------------------------------------------------------------------------------------

/** "$0.42", "$0.042", "$0.0042": two decimals when it is at least 10 cents, else enough to see a difference. */
export function formatUnitCents(cents: number, currency = "USD"): string {
  const d = cents >= 10 ? 2 : cents >= 1 ? 3 : 4;
  const v = (cents / 100).toFixed(d);
  return currency === "USD" ? `$${v}` : `${currency} ${v}`;
}

/** How many `per` units the contents hold, or undefined. */
export function quantityIn(c: Contents | undefined, per: Per): number | undefined {
  if (!c) return undefined;
  if (per === "count") return c.count && c.count > 0 ? c.count : undefined;
  if (per === "fl oz") return c.ml ? c.ml / ML_PER_FL_OZ : undefined;
  return c.g ? c.g / G_PER_OZ : undefined;
}

/** The unit an offer is best compared in: its size when known (fl oz, oz), else its count. */
export function preferredPer(c: Contents | undefined): Per | undefined {
  if (!c) return undefined;
  if (c.ml) return "fl oz";
  if (c.g) return "oz";
  if (c.count) return "count";
  return undefined;
}

/** Unit price from contents and a price. */
export function perUnitFrom(price: Money, c: Contents | undefined, per: Per | undefined = preferredPer(c)): PerUnit | undefined {
  if (!per || !Number.isFinite(price?.cents) || price.cents <= 0) return undefined;
  const q = quantityIn(c, per);
  if (!q) return undefined;
  const cents = price.cents / q;
  return { cents: round(cents, 4), currency: price.currency, per, text: `${formatUnitCents(cents, price.currency)} / ${per}`, source: "title" };
}

/**
 * A unit price the store showed ({ amount, per: "count" | "Fl Oz" | "100 ct" | "lb" ... }) in the
 * comparable units, keeping the store's own words for display. Undefined for units it cannot place.
 */
export function perUnitFromStore(up: Offer["unitPrice"]): PerUnit | undefined {
  if (!up || !Number.isFinite(up.amount?.cents) || up.amount.cents <= 0 || typeof up.per !== "string") return undefined;
  const m = /^\s*(?:per\s+)?(\d+(?:\.\d+)?)?\s*(.+?)\s*$/i.exec(up.per.replace(/^\//, ""));
  if (!m) return undefined;
  const q = m[1] ? parseFloat(m[1]) : 1;
  const word = m[2].toLowerCase();
  if (!(q > 0)) return undefined;
  let per: Per;
  let cents: number;
  if (new RegExp(String.raw`^(?:${COUNT_NOUN}|each|item|piece)$`, "i").test(word)) {
    per = "count";
    cents = up.amount.cents / q;
  } else {
    const u = unitDef(word);
    if (!u) return undefined;
    const base = q * u.factor;
    per = u.kind === "volume" ? "fl oz" : "oz";
    cents = up.amount.cents / (base / (u.kind === "volume" ? ML_PER_FL_OZ : G_PER_OZ));
  }
  const shown = `${formatUnitCents(up.amount.cents, up.amount.currency)} / ${up.per.replace(/^\//, "").trim().toLowerCase()}`;
  return { cents: round(cents, 4), currency: up.amount.currency, per, text: shown, source: "store" };
}

/** The offer with `contents` (from its title) and `perUnit` (the store's, else computed) filled when known. */
export function withUnits(o: Offer): Offer {
  const contents = o.contents ?? readContents(o.title);
  const perUnit = o.perUnit ?? perUnitFromStore(o.unitPrice) ?? perUnitFrom(o.price, contents);
  if (!contents && !perUnit) return o;
  const out: Offer = { ...o };
  if (contents) out.contents = contents;
  if (perUnit) out.perUnit = perUnit;
  return out;
}

/** The offer's price per `per` unit in cents, or undefined when it cannot be compared in that unit. */
export function unitCentsIn(o: Offer, per: Per): number | undefined {
  if (o.perUnit?.per === per) return o.perUnit.cents;
  const q = quantityIn(o.contents, per);
  return q && o.price?.cents > 0 ? o.price.cents / q : undefined;
}

/** The unit most of these offers can be compared in (ties: fl oz, oz, then count). */
export function commonPer(offers: Offer[]): Per | undefined {
  const order: Per[] = ["fl oz", "oz", "count"];
  let best: Per | undefined;
  let bestN = 0;
  for (const per of order) {
    const n = offers.filter((o) => unitCentsIn(o, per) !== undefined).length;
    if (n > bestN) { best = per; bestN = n; }
  }
  return best;
}

/** Compare two offers by unit price in `per`: negative when `a` is cheaper; 0 when either is unknown. */
export function compareUnitPrice(a: Offer, b: Offer, per: Per | undefined): number {
  if (!per) return 0;
  const x = unitCentsIn(a, per);
  const y = unitCentsIn(b, per);
  if (x === undefined || y === undefined || a.price.currency !== b.price.currency) return 0;
  return x - y;
}

/** Offers sorted by unit price, cheapest first; offers without a comparable unit price keep their order at the end. */
export function sortByUnitPrice(offers: Offer[]): Offer[] {
  const per = commonPer(offers);
  if (!per) return offers.slice();
  const known = offers.filter((o) => unitCentsIn(o, per) !== undefined);
  const unknown = offers.filter((o) => unitCentsIn(o, per) === undefined);
  return [...known.sort((a, b) => unitCentsIn(a, per)! - unitCentsIn(b, per)!), ...unknown];
}
