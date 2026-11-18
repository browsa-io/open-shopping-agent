// Helpers shared by store adapters. Owned by the core workstream; adapters import, never fork.

import type { Page } from "playwright-core";
import type { Approval, CartLine, ItemRequest, Money, NeedsUser, Offer, StoreId } from "../core/types.js";
import type { StoreContext } from "./adapter.js";

const SYMBOLS: Record<string, string> = { "$": "USD", "US$": "USD", "£": "GBP", "€": "EUR", "C$": "CAD", "CA$": "CAD" };

/**
 * "$1,299.99" -> { cents: 129999, currency: "USD" }. Takes the first price in the text, so
 * "$12.99 ($0.65/count)" gives 1299. Returns undefined when there is no price. "Free" -> 0.
 */
export function parseMoney(text: string | null | undefined, currency = "USD"): Money | undefined {
  if (!text) return undefined;
  const t = text.replace(/ /g, " ").trim();
  if (/^free\b/i.test(t)) return { cents: 0, currency };
  const m = t.match(/(US\$|C\$|CA\$|[$£€])?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!m) return undefined;
  const whole = parseInt(m[2].replace(/,/g, ""), 10);
  const frac = m[3] ? parseInt(m[3].padEnd(2, "0"), 10) : 0;
  return { cents: whole * 100 + frac, currency: (m[1] && SYMBOLS[m[1]]) || currency };
}

/** Amazon-style split prices: whole "12" + fraction "99" -> 1299 cents. */
export function moneyFromParts(whole: string | null | undefined, fraction: string | null | undefined, currency = "USD"): Money | undefined {
  if (!whole) return undefined;
  const w = parseInt(whole.replace(/[^\d]/g, ""), 10);
  if (Number.isNaN(w)) return undefined;
  const f = fraction ? parseInt(fraction.replace(/[^\d]/g, "").padEnd(2, "0").slice(0, 2), 10) : 0;
  return { cents: w * 100 + f, currency };
}

export function formatMoney(m: Money | undefined): string {
  if (!m) return "?";
  const sign = m.cents < 0 ? "-" : "";
  const abs = Math.abs(m.cents);
  const sym = m.currency === "USD" ? "$" : m.currency === "GBP" ? "£" : m.currency === "EUR" ? "€" : m.currency + " ";
  return `${sign}${sym}${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function addMoney(a: Money, b: Money | undefined): Money {
  if (!b) return a;
  if (a.currency !== b.currency) throw new Error(`currency mismatch ${a.currency} vs ${b.currency}`);
  return { cents: a.cents + b.cents, currency: a.currency };
}

/** "4.6 out of 5 stars" -> 4.6; "(12,345)" -> 12345. */
export function parseStars(text: string | null | undefined): number | undefined {
  const m = text?.match(/(\d(?:\.\d)?)\s*(?:out of 5|stars?|\/\s*5)/i) ?? text?.match(/^\s*(\d(?:\.\d)?)\s*$/);
  return m ? parseFloat(m[1]) : undefined;
}

export function parseCount(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Math.round(m[2] ? n * (/k/i.test(m[2]) ? 1_000 : 1_000_000) : n);
}

/** Collapse whitespace; undefined for empty. */
export function clean(text: string | null | undefined): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  return t ? t : undefined;
}

/** Build a NeedsUser with a Phantom Live control link (best effort: no link if minting fails). */
export async function needsUser(ctx: StoreContext, reason: NeedsUser["reason"], message: string): Promise<NeedsUser> {
  let liveUrl: string | undefined;
  try { liveUrl = await ctx.liveLink(); } catch (e) { ctx.log(`live link failed: ${(e as Error).message}`); }
  return { reason, message, liveUrl };
}

/** Wait for any of the selectors; returns the index that appeared, or -1 on timeout. */
export async function firstVisible(ctx: StoreContext, selectors: string[], timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < selectors.length; i++) {
      if (await ctx.page.locator(selectors[i]).first().isVisible().catch(() => false)) return i;
    }
    await ctx.page.waitForTimeout(250);
  }
  return -1;
}

export const nowIso = () => new Date().toISOString();

/** Network errors of the exit itself (a proxy tunnel that failed, a reset): worth a retry. */
export function isTransientNetError(e: unknown): boolean {
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_NETWORK_CHANGED|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT/i.test(String((e as Error)?.message ?? e));
}

/**
 * page.goto with retries for the exit's own hiccups: a failed proxy tunnel or a dropped
 * connection (residential exits rotate) is retried twice after a short wait, a navigation
 * timeout once. Other errors are thrown at once.
 */
export async function gotoRetry(ctx: StoreContext, url: string, opts: { timeout?: number; waitUntil?: "domcontentloaded" | "load" } = {}): Promise<Awaited<ReturnType<Page["goto"]>>> {
  let timeouts = 0;
  for (let i = 0; ; i++) {
    try {
      return await ctx.page.goto(url, { waitUntil: opts.waitUntil ?? "domcontentloaded", timeout: opts.timeout ?? 45_000 });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const timeout = /Timeout \d+ms exceeded/.test(msg);
      if (ctx.signal.aborted || i >= 2 || !(isTransientNetError(e) || (timeout && timeouts++ === 0))) throw e;
      ctx.log(`${ctx.domain}: ${timeout ? "the page took too long" : msg.match(/net::\w+/)?.[0] ?? "network error"}; trying again`);
      await ctx.page.waitForTimeout(2000 * (i + 1)).catch(() => undefined);
    }
  }
}

/** True when an error says the tab crashed, was closed or stopped answering (not a page-level error). */
export function isDeadPageError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /Target crashed|Page crashed|page has been closed|Target page, context or browser has been closed|Target closed|browser has been closed|page stopped answering|Session closed/i.test(m);
}

/** True when ctx.page is closed or does not answer a trivial evaluate within `ms`. */
export async function pageIsDead(ctx: StoreContext, ms = 8000): Promise<boolean> {
  if (ctx.page.isClosed()) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), ms); });
  try {
    const r = await Promise.race([ctx.page.evaluate("1").then(() => "ok" as const, (e: unknown) => (isDeadPageError(e) ? "dead" as const : "ok" as const)), late]);
    return r !== "ok";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * page.evaluate with a deadline. A wedged page (seen live: Playwright never gets the new
 * document's context after some navigations) would otherwise hang the run. When the tab is dead
 * (no answer, crashed or closed), replace it once with ctx.newPage(), let `reopen` load the page
 * again (given the old URL), and evaluate once more.
 */
export async function evalWithRenew<R, A = undefined>(
  ctx: StoreContext, fn: (arg: A) => R | Promise<R>, arg: A | undefined, o: { ms?: number; reopen: (lastUrl: string) => Promise<void> },
): Promise<R> {
  const ms = o.ms ?? 30_000;
  const once = async (): Promise<R> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the ${ctx.domain} page stopped answering (no reply in ${Math.round(ms / 1000)} s)`)), ms);
    });
    try {
      return await Promise.race([ctx.page.evaluate(fn as never, arg as never) as Promise<R>, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    return await once();
  } catch (e) {
    if (!isDeadPageError(e) && !ctx.page.isClosed()) throw e;
    let last = "";
    try { last = ctx.page.url(); } catch { /* closed */ }
    await replacePage(ctx, /stopped answering/.test(String((e as Error)?.message)) ? "stopped answering" : "crashed or closed");
    await o.reopen(last);
    return once();
  }
}

/** Swap a crashed, closed or frozen tab for a fresh one in the same browser (ctx.newPage), logging why. */
export async function replacePage(ctx: StoreContext, why: string): Promise<Page> {
  ctx.log(`${ctx.domain}: the tab ${why}; opening a fresh tab in the same browser`);
  return ctx.newPage();
}

// ---------------------------------------------------------------------------------------------
// HTML tree helpers: a tolerant parser with a tiny selector engine (Amazon, Walmart)
// ---------------------------------------------------------------------------------------------

export interface HNode {
  tag: string;
  attrs: Record<string, string>;
  children: (HNode | string)[];
  parent: HNode | null;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "noscript", "template", "xmp", "title"]);
const NO_TEXT = new Set(["script", "style", "noscript", "template", "head", "svg"]);
const AUTO_CLOSE: Record<string, string[]> = {
  li: ["li"], option: ["option"], p: ["p"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], dt: ["dt", "dd"], dd: ["dt", "dd"],
};
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  reg: "®", trade: "™", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  times: "×", deg: "°", zwnj: "", zwj: "", shy: "", bull: "•", middot: "·", frac12: "½",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v ?? m;
  });
}

function isSpace(c: number): boolean { return c === 32 || c === 9 || c === 10 || c === 13 || c === 12; }
function isNameChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 58 || c === 95;
}

/** Tolerant HTML parser: enough structure for attribute and text lookups on store pages. */
export function parseHtml(src: string): HNode {
  const root: HNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { cur.children.push(src.slice(i)); break; }
    if (lt > i) cur.children.push(src.slice(i, lt));
    const c1 = src.charCodeAt(lt + 1);
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (c1 === 33 || c1 === 63) { const e = src.indexOf(">", lt); i = e === -1 ? n : e + 1; continue; }
    if (c1 === 47) {
      const e = src.indexOf(">", lt);
      const name = src.slice(lt + 2, e === -1 ? n : e).trim().toLowerCase();
      i = e === -1 ? n : e + 1;
      let x: HNode | null = cur;
      while (x && x !== root && x.tag !== name) x = x.parent;
      if (x && x !== root) cur = x.parent ?? root;
      continue;
    }
    let j = lt + 1;
    while (j < n && isNameChar(src.charCodeAt(j))) j++;
    if (j === lt + 1) { cur.children.push("<"); i = lt + 1; continue; }
    const tag = src.slice(lt + 1, j).toLowerCase();
    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (j < n) {
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      if (j >= n) break;
      const ch = src[j];
      if (ch === ">") { j++; break; }
      if (ch === "/") { if (src[j + 1] === ">") { selfClose = true; j += 2; break; } j++; continue; }
      let k = j;
      while (k < n) {
        const ck = src.charCodeAt(k);
        if (isSpace(ck) || ck === 61 || ck === 62 || (ck === 47 && src[k + 1] === ">")) break;
        k++;
      }
      if (k === j) { j++; continue; }
      const name = src.slice(j, k).toLowerCase();
      j = k;
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      let val = "";
      if (src[j] === "=") {
        j++;
        while (j < n && isSpace(src.charCodeAt(j))) j++;
        const q = src[j];
        if (q === "\"" || q === "'") {
          const e = src.indexOf(q, j + 1);
          val = src.slice(j + 1, e === -1 ? n : e);
          j = e === -1 ? n : e + 1;
        } else {
          let e = j;
          while (e < n && !isSpace(src.charCodeAt(e)) && src[e] !== ">") e++;
          val = src.slice(j, e);
          j = e;
        }
      }
      if (name && !(name in attrs)) attrs[name] = decodeEntities(val);
    }
    i = j;
    const auto = AUTO_CLOSE[tag];
    if (auto && auto.includes(cur.tag)) cur = cur.parent ?? root;
    const node: HNode = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (VOID.has(tag) || selfClose) continue;
    if (RAW.has(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, "ig");
      re.lastIndex = i;
      const m = re.exec(src);
      const end = m ? m.index : n;
      if (end > i) node.children.push(src.slice(i, end));
      i = m ? m.index + m[0].length : n;
      continue;
    }
    cur = node;
  }
  return root;
}

interface Compound { tag?: string; id?: string; classes: string[]; attrs: { name: string; op: string; value: string }[] }
const selCache = new Map<string, Compound[][]>();

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0; let quote = ""; let buf = "";
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = ""; buf += ch; continue; }
    if (ch === "\"" || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) { if (buf.trim()) out.push(buf.trim()); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseCompound(s: string): Compound {
  const c: Compound = { classes: [], attrs: [] };
  let i = 0;
  const m = /^[a-zA-Z*][a-zA-Z0-9-]*/.exec(s);
  if (m) { if (m[0] !== "*") c.tag = m[0].toLowerCase(); i = m[0].length; }
  while (i < s.length) {
    const ch = s[i];
    if (ch === "#" || ch === ".") {
      const mm = /^[^#.[\s]+/.exec(s.slice(i + 1));
      const v = mm ? mm[0] : "";
      if (ch === "#") c.id = v; else c.classes.push(v);
      i += 1 + v.length;
    } else if (ch === "[") {
      let end = i + 1; let quote = "";
      for (; end < s.length; end++) {
        const ce = s[end];
        if (quote) { if (ce === quote) quote = ""; continue; }
        if (ce === "\"" || ce === "'") { quote = ce; continue; }
        if (ce === "]") break;
      }
      const body = s.slice(i + 1, end);
      const am = /^\s*([^\s~|^$*!=]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*$/.exec(body);
      if (am) c.attrs.push({ name: am[1].toLowerCase(), op: am[2] ?? "", value: am[3] ?? am[4] ?? am[5] ?? "" });
      i = end + 1;
    } else i++;
  }
  return c;
}

function parseSelector(sel: string): Compound[][] {
  let r = selCache.get(sel);
  if (!r) { r = splitTop(sel, ",").map((alt) => splitTop(alt, " ").map(parseCompound)); selCache.set(sel, r); }
  return r;
}

function matches(n: HNode, c: Compound): boolean {
  if (c.tag && n.tag !== c.tag) return false;
  if (c.id && n.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const cl = ` ${(n.attrs.class ?? "").replace(/\s+/g, " ")} `;
    for (const k of c.classes) if (!cl.includes(` ${k} `)) return false;
  }
  for (const a of c.attrs) {
    const v = n.attrs[a.name];
    if (v === undefined) return false;
    const w = a.value;
    switch (a.op) {
      case "": break;
      case "=": if (v !== w) return false; break;
      case "*=": if (!v.includes(w)) return false; break;
      case "^=": if (!v.startsWith(w)) return false; break;
      case "$=": if (!v.endsWith(w)) return false; break;
      case "~=": if (!v.split(/\s+/).includes(w)) return false; break;
      case "|=": if (v !== w && !v.startsWith(w + "-")) return false; break;
    }
  }
  return true;
}

function matchChain(n: HNode, chain: Compound[], scope: HNode): boolean {
  if (!matches(n, chain[chain.length - 1])) return false;
  let k = chain.length - 2;
  let p = n.parent;
  while (k >= 0 && p && p !== scope.parent) {
    if (p.tag !== "#root" && matches(p, chain[k])) k--;
    p = p.parent;
  }
  return k < 0;
}

function walk(root: HNode, sel: string, first: boolean): HNode[] {
  const alts = parseSelector(sel);
  const out: HNode[] = [];
  const stack: HNode[] = [];
  for (let i = root.children.length - 1; i >= 0; i--) { const ch = root.children[i]; if (typeof ch !== "string") stack.push(ch); }
  while (stack.length) {
    const n = stack.pop()!;
    for (const chain of alts) {
      if (matchChain(n, chain, root)) { out.push(n); if (first) return out; break; }
    }
    for (let i = n.children.length - 1; i >= 0; i--) { const ch = n.children[i]; if (typeof ch !== "string") stack.push(ch); }
  }
  return out;
}

/** All descendants matching a simple CSS selector (tag, #id, .class, [attr op value], descendant, comma). */
export function qsa(root: HNode, sel: string): HNode[] { return walk(root, sel, false); }
export function qs(root: HNode | undefined | null, sel: string): HNode | undefined { return root ? walk(root, sel, true)[0] : undefined; }
export function hasClass(n: HNode, cls: string): boolean { return ` ${n.attrs.class ?? ""} `.replace(/\s+/g, " ").includes(` ${cls} `); }

/** Visible-ish text of a node: scripts and styles skipped, entities decoded, whitespace collapsed. */
export function textOf(n: HNode | undefined | null): string {
  if (!n) return "";
  const parts: string[] = [];
  const stack: (HNode | string)[] = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (typeof x === "string") { parts.push(x); continue; }
    if (x !== n && NO_TEXT.has(x.tag)) continue;
    if (x.tag === "br") { parts.push(" "); continue; }
    for (let i = x.children.length - 1; i >= 0; i--) stack.push(x.children[i]);
  }
  return decodeEntities(parts.join(" ")).replace(/[\s ​-‍﻿]+/g, " ").replace(/ ([,.:;!?)])/g, "$1").replace(/\( /g, "(").trim();
}

/** JSON value (object or array) right after `key` in raw page source, e.g. `"variationValues" : {...}`. */
export function jsonAfter(src: string, key: string, from = 0): unknown {
  const i = src.indexOf(key, from);
  if (i < 0) return undefined;
  let j = i + key.length;
  while (j < src.length && src[j] !== "{" && src[j] !== "[") {
    if (j - i - key.length > 12) return undefined;
    j++;
  }
  let depth = 0; let quote = "";
  for (let k = j; k < src.length; k++) {
    const ch = src[k];
    if (quote) { if (ch === "\\") { k++; continue; } if (ch === quote) quote = ""; continue; }
    if (ch === "\"") { quote = ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) { try { return JSON.parse(src.slice(j, k + 1)); } catch { return undefined; } }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Dates, options, approval, bot checks, clicks
// ---------------------------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** First delivery date in a store's text ("Thu, Nov 20", "tomorrow", "Today", "in 2 days") as YYYY-MM-DD. */
export function parseDeliveryDate(text: string | undefined, now = new Date()): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  const found: { at: number; date: Date }[] = [];
  const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/.exec(t);
  if (md) {
    const month = MONTHS.indexOf(md[1]);
    let year = now.getFullYear();
    if (month < now.getMonth() - 1) year++;
    found.push({ at: md.index, date: new Date(year, month, parseInt(md[2], 10)) });
  }
  const today = t.search(/\btoday\b/);
  if (today >= 0) found.push({ at: today, date: new Date(now.getFullYear(), now.getMonth(), now.getDate()) });
  const tom = t.search(/\btomorrow\b/);
  if (tom >= 0) found.push({ at: tom, date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) });
  const inDays = /\bin (\d{1,2}) days?\b/.exec(t);
  if (inDays) found.push({ at: inDays.index, date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + parseInt(inDays[1], 10)) });
  if (!found.length) return undefined;
  found.sort((a, b) => a.at - b.at);
  return isoDay(found[0].date);
}

/** Normalise an option name or value for matching: case, spaces, "feet"/"ft", "colour"/"color". */
export function normOption(s: string): string {
  return s.toLowerCase()
    .replace(/colour/g, "color")
    .replace(/\b(feet|foot)\b|'|’/g, "ft")
    .replace(/\b(inches|inch)\b|"|”/g, "in")
    .replace(/[^a-z0-9.]/g, "");
}

export interface VariantChoice { id: string; values: Record<string, string>; available?: boolean }

/**
 * Pick the variant whose option values equal the wanted ones. Keys match by name ("color" ~
 * "Color", "color_name") or, failing that, by which dimension offers the wanted value.
 * Returns the id, or an explanation of what is offered.
 */
export function pickVariant(choices: VariantChoice[], wanted: Record<string, string>): { id?: string; reason?: string } {
  const dims = new Set<string>();
  for (const c of choices) for (const k of Object.keys(c.values)) dims.add(k);
  const dimList = [...dims];
  const mapKey = (k: string, v: string): string | undefined => {
    const nk = normOption(k);
    const byName = dimList.find((d) => normOption(d) === nk) ?? dimList.find((d) => normOption(d).includes(nk) || nk.includes(normOption(d)));
    if (byName) return byName;
    const nv = normOption(v);
    return dimList.find((d) => choices.some((c) => c.values[d] !== undefined && normOption(c.values[d]) === nv));
  };
  const wantedDims: { dim: string; value: string }[] = [];
  for (const [k, v] of Object.entries(wanted)) {
    const dim = mapKey(k, v);
    if (!dim) return { reason: `no option "${k}" (offered: ${dimList.join(", ") || "none"})` };
    wantedDims.push({ dim, value: v });
  }
  const valueMatch = (have: string | undefined, want: string, loose: boolean) => {
    if (have === undefined) return false;
    const a = normOption(have); const b = normOption(want);
    return loose ? a.includes(b) || b.includes(a) : a === b;
  };
  for (const loose of [false, true]) {
    const hits = choices.filter((c) => wantedDims.every((w) => valueMatch(c.values[w.dim], w.value, loose)));
    const pick = hits.find((c) => c.available !== false) ?? hits[0];
    if (pick) return { id: pick.id };
  }
  const offered = wantedDims.map((w) => `${w.dim}: ${[...new Set(choices.map((c) => c.values[w.dim]).filter(Boolean))].join(", ")}`).join("; ");
  return { reason: `no variant with ${Object.entries(wanted).map(([k, v]) => `${k} "${v}"`).join(", ")} (offered: ${offered})` };
}

/** Compare the options a cart line shows with the wanted ones; returns warnings. */
export function optionWarnings(store: string, wanted: Record<string, string> | undefined, shown: Record<string, string> | undefined): string[] {
  if (!wanted) return [];
  const out: string[] = [];
  const shownEntries = Object.entries(shown ?? {});
  for (const [k, v] of Object.entries(wanted)) {
    const nk = normOption(k);
    const hit = shownEntries.find(([sk]) => normOption(sk) === nk || normOption(sk).includes(nk) || nk.includes(normOption(sk)))
      ?? shownEntries.find(([, sv]) => normOption(sv) === normOption(v));
    if (!hit) { out.push(`${store} cart does not show option ${k} "${v}"`); continue; }
    // Carts cut long values: "11-in-1 USB C Laptop Hub..." matches when the wanted value starts with it.
    const cut = /(\.\.\.|…)\s*$/.test(hit[1]);
    const shownNorm = normOption(hit[1].replace(/(\.\.\.|…)\s*$/, ""));
    const same = cut ? shownNorm.length >= 3 && normOption(v).startsWith(shownNorm) : shownNorm === normOption(v);
    if (!same) out.push(`Option ${k} "${v}" did not stick, ${store} cart shows "${hit[1]}"`);
  }
  return out;
}

/** True when the store's total equals what the user approved (same currency, same cents). */
export function approvalMatches(total: Money | undefined, approval: Approval): boolean {
  return !!total && total.currency === approval.approvedTotal.currency && total.cents === approval.approvedTotal.cents;
}

export class BotCheckError extends Error {}

/**
 * When a store shows a bot check (captcha, press and hold), wait for Phantom to pass it
 * (Browsa solves many in-session), retry once, else throw a clear error.
 */
export async function passBotCheck(
  ctx: StoreContext, store: string, isBlocked: () => Promise<boolean>,
  opts: { waitMs?: number; retry?: () => Promise<unknown> } = {},
): Promise<void> {
  if (!(await isBlocked())) return;
  ctx.log(`${store}: bot check shown, waiting for Phantom to pass it`);
  for (let round = 0; round < 2; round++) {
    const deadline = Date.now() + (round === 0 ? opts.waitMs ?? 30_000 : 20_000);
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new Error("aborted");
      await ctx.page.waitForTimeout(1500);
      if (!(await isBlocked())) { ctx.log(`${store}: bot check passed`); return; }
    }
    if (round === 0) {
      ctx.log(`${store}: bot check still there, retrying once`);
      await (opts.retry ? opts.retry() : ctx.page.reload({ waitUntil: "domcontentloaded" })).catch(() => undefined);
    }
  }
  throw new BotCheckError(`${store} shows a bot check that did not clear. Try again later, or open the browser with a live link and solve it.`);
}

export function sumLines(lines: CartLine[], currency = "USD"): Money {
  return { cents: lines.reduce((a, l) => a + l.price.cents, 0), currency };
}

/** Click the first visible element among selectors; returns true when one was clicked. */
export async function clickFirstVisible(page: Page, selectors: string[], timeout = 5000): Promise<boolean> {
  for (const s of selectors) {
    const loc = page.locator(s);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout }).catch(() => undefined);
        return true;
      }
    }
  }
  return false;
}

/** Decline a membership or trial offer: only "no thanks" style controls, never "try" or "join". */
export async function declineOffer(page: Page, selectors: string[]): Promise<boolean> {
  if (await clickFirstVisible(page, selectors)) return true;
  const name = /^\s*(no,? thanks?\b.*|not now\b.*|no thank you\b.*|skip\b.*|maybe later\b.*|continue without\b.*|i don.t want\b.*|decline\b.*)$/i;
  for (const role of ["button", "link"] as const) {
    const loc = page.getByRole(role, { name });
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 6); i++) {
      const el = loc.nth(i);
      const label = (await el.innerText().catch(() => "")) || "";
      if (/\b(try|join|start|sign up|free trial)\b/i.test(label) && !/no|not now|skip/i.test(label)) continue;
      if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 5000 }).catch(() => undefined); return true; }
    }
  }
  return false;
}

export function moneyFromNumber(n: unknown, currency = "USD"): Money | undefined {
  if (typeof n === "number" && Number.isFinite(n)) return { cents: Math.round(n * 100), currency };
  if (typeof n === "string") return parseMoney(n, currency);
  return undefined;
}

/**
 * "City, ST 12345" from an address block, never the street line: a text piece that starts with
 * the city, else only the one word before the comma.
 */
export function shortAddress(n: HNode | undefined): string | undefined {
  if (!n) return undefined;
  const stack: (HNode | string)[] = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (typeof x === "string") {
      const m = /^\s*([A-Za-z][A-Za-z .'-]{0,40}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/.exec(decodeEntities(x));
      if (m) return `${m[1].trim()}, ${m[2]} ${m[3]}`;
      continue;
    }
    for (let i = x.children.length - 1; i >= 0; i--) stack.push(x.children[i]);
  }
  const m = /([A-Za-z.'-]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/.exec(textOf(n));
  return m ? `${m[1]}, ${m[2]} ${m[3]}` : undefined;
}

/**
 * AI fallback for a search results page: ask the Browsa task to read the first results as JSON
 * and map them to offers. `productId` reads the id from a result link, `productUrl` builds the
 * canonical product URL, `idHint` tells the task which id to use.
 */
export async function aiSearchFallback(
  ctx: StoreContext,
  o: { store: StoreId; domain: string; url: string; item: ItemRequest; limit: number; idHint: string; productId: (url: string) => string | undefined; productUrl: (id: string) => string },
): Promise<Offer[]> {
  ctx.log(`${o.store}: no results parsed, trying the AI fallback`);
  const schema = {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" }, url: { type: "string" }, id: { type: "string" }, price: { type: "string" },
            stars: { type: "number" }, reviews: { type: "number" }, sponsored: { type: "boolean" }, delivery: { type: "string" },
          },
          required: ["title", "url", "price"],
        },
      },
    },
    required: ["results"],
  };
  type R = { results?: { title: string; url: string; id?: string; price: string; stars?: number; reviews?: number; sponsored?: boolean; delivery?: string }[] };
  const r = await ctx.aiTask<R>(
    `You are on ${o.url}. Read the first ${o.limit} product results for "${o.item.query}" and return them as JSON. ` +
    `Use the product id from the link (${o.idHint}). Mark ads as sponsored. Do not click Add to cart.`,
    { schema, startUrl: o.url, maxSteps: 6 },
  );
  const out: Offer[] = [];
  for (const x of r?.results ?? []) {
    const price = parseMoney(x.price);
    if (!price || !x.title) continue;
    const id = x.id || o.productId(x.url);
    out.push({
      store: o.store, storeDomain: o.domain, itemId: o.item.id, title: x.title, productId: id,
      url: id ? o.productUrl(id) : x.url,
      price, rating: x.stars !== undefined ? { stars: x.stars, count: x.reviews ?? 0 } : undefined,
      deliveryText: x.delivery, deliveryDate: parseDeliveryDate(x.delivery), inStock: true, sponsored: !!x.sponsored,
      subscription: false, raw: { via: "ai" },
    });
  }
  return out;
}

/**
 * If the page shows PerimeterX's "Press & hold" button (`#px-captcha`, Target and Walmart), hold
 * it with real mouse events until the check clears (up to about 20 s). Returns true when a check
 * was found. `name` goes into the log lines.
 */
export async function pressAndHold(ctx: StoreContext, o: { name: string; selector?: string }): Promise<boolean> {
  const page = ctx.page;
  const sel = o.selector ?? "#px-captcha";
  // count() does not wait; boundingBox() would wait up to 30 s for an element that is usually absent.
  const holder = page.locator(sel).first();
  if (!(await page.locator(sel).count().catch(() => 0))) return false;
  // Hold only once the challenge has drawn its button (an iframe inside #px-captcha); holding
  // earlier does not count (measured live: an early hold failed, a hold after the frame passed).
  await page.locator(`${sel} iframe`).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const box = await holder.boundingBox({ timeout: 3000 }).catch(() => null);
  if (!box) return false;
  ctx.log(`${o.name} bot check (press and hold): holding`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 60, y + 25, { steps: 8 });
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.down();
  const t0 = Date.now();
  const startUrl = page.url();
  while (Date.now() - t0 < 20_000) {
    await page.waitForTimeout(500);
    const gone = !(await page.locator(sel).first().isVisible().catch(() => false));
    if (gone || page.url() !== startUrl) break;
  }
  ctx.log(`${o.name} bot check: held ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return true;
}

// ---------------------------------------------------------------------------------------------
// HTML string helpers (eBay, Best Buy): work on raw HTML fragments, so the same parsers run on
// live page.content() and on fixtures.
// ---------------------------------------------------------------------------------------------

const STR_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "-", hellip: "...", reg: "®", trade: "™", copy: "©" };

/** Entity decoding of the string helpers ("&mdash;" -> "-", "&hellip;" -> "..."). */
export function decodeEntitiesAscii(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return STR_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Drop script, style, svg and comments (keeps everything else). */
export function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, "");
}

/** Visible-ish text of an HTML fragment, one entry per text node, trimmed, empties dropped. */
export function textLines(html: string): string[] {
  return decodeEntitiesAscii(stripNoise(html).replace(/<[^>]+>/g, "\n"))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Text of an HTML fragment, one line. */
export function textOfHtml(html: string | undefined): string | undefined {
  return html === undefined ? undefined : clean(textLines(html).join(" "));
}

const STR_VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** The outer HTML of the element whose start tag begins at `start` (balanced by tag name). */
export function elementAt(html: string, start: number): string {
  const open = /^<([a-zA-Z][\w-]*)\b[^>]*>/.exec(html.slice(start, start + 4000));
  if (!open) return "";
  const name = open[1].toLowerCase();
  if (STR_VOID.has(name) || open[0].endsWith("/>")) return open[0];
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = start + open[0].length;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) depth--; else if (!m[0].endsWith("/>")) depth++;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

/** Every element whose start tag contains the attribute text (e.g. `data-test-id="TOTAL"`). */
export function elementsWith(html: string, attrText: string): string[] {
  const out: string[] = [];
  let i = html.indexOf(attrText);
  while (i >= 0) {
    const s = html.lastIndexOf("<", i);
    if (s >= 0 && html.indexOf(">", s) > i) out.push(elementAt(html, s));
    i = html.indexOf(attrText, i + attrText.length);
  }
  return out;
}

export function firstWith(html: string, attrText: string): string | undefined {
  return elementsWith(html, attrText)[0];
}

/** Value of an attribute in the first start tag of a fragment. */
export function attr(tagHtml: string | undefined, name: string): string | undefined {
  if (!tagHtml) return undefined;
  const tag = /^<[^>]*>/.exec(tagHtml)?.[0] ?? tagHtml;
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
  return m ? decodeEntitiesAscii(m[1]) : undefined;
}

/** Parse the JSON object or array that starts at `start` (string-aware brace matching). */
export function readJsonAt(s: string, start: number): unknown {
  const open = s[start];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return undefined; } } }
  }
  return undefined;
}

/** JSON value right after a marker such as `"MSKU":` or `var cartOrderInit = `. */
export function jsonAfterMarker(html: string, marker: string): unknown {
  const i = html.indexOf(marker);
  if (i < 0) return undefined;
  let j = i + marker.length;
  while (j < html.length && /\s/.test(html[j])) j++;
  return readJsonAt(html, j);
}

/** All JSON-LD objects on the page, flattened (arrays and @graph). */
export function jsonLd(html: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      const v = JSON.parse(m[1].trim());
      const push = (x: any) => { if (Array.isArray(x)) x.forEach(push); else if (x && typeof x === "object") { out.push(x); if (x["@graph"]) push(x["@graph"]); } };
      push(v);
    } catch { /* ignore broken blocks */ }
  }
  return out;
}

/** A number or numeric string ("12.5") as money; other strings give undefined. */
export function moneyFromNumeric(v: unknown, currency = "USD"): Money | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? { cents: Math.round(n * 100), currency } : undefined;
}

/** "6 ft" ~ "6FT" ~ "6 Feet"; "Black" ~ "black". */
export function sameOption(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/\bfeet\b|\bfoot\b/g, "ft").replace(/\binch(es)?\b/g, "in").replace(/[^a-z0-9.]/g, "");
  return n(a) === n(b);
}
