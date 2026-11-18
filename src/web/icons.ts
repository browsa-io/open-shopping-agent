// Store icons for the web app: each store's own site icon (favicon or apple-touch-icon), fetched once
// by this server and kept in <osa home>/icons/. The browser only ever asks this server, so there is
// no CORS or mixed-content trouble and no third-party icon service sees which stores you use. No
// logo file ships with the code: the marks belong to the stores.
//
// Safety: https only, public hosts only (names that resolve to private, loopback or link-local
// addresses are refused, on every redirect too), a size cap, and the bytes must be an image (PNG,
// ICO, GIF, JPEG, WebP or SVG by their first bytes). SVG is served with a sandboxing CSP.

import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { StoreId } from "../core/types.js";

export const ICON_MAX_BYTES = 256 * 1024;
const PAGE_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const MAX_TRIES = 4;
/** A good icon is kept 30 days; after that it is fetched again (the old one is served if that fails). */
const FRESH_MS = 30 * 24 * 3600_000;
/** A host with no usable icon is asked again after an hour (offline, a bot wall). */
const RETRY_MS = 3600_000;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** Each built-in store's home host, plus icon URLs known to work for it (tried first). */
export const STORE_HOSTS: Record<Exclude<StoreId, "shopify">, { host: string; known: string[] }> = {
  amazon: { host: "www.amazon.com", known: ["https://www.amazon.com/favicon.ico"] },
  walmart: { host: "www.walmart.com", known: ["https://www.walmart.com/apple-touch-icon.png"] },
  ebay: { host: "www.ebay.com", known: ["https://www.ebay.com/apple-touch-icon.png"] },
  bestbuy: { host: "www.bestbuy.com", known: ["https://www.bestbuy.com/favicon.ico"] },
  target: { host: "www.target.com", known: ["https://www.target.com/favicon.ico"] },
};
/** The "Shopify" choice with no shop named (Settings, the store picker). */
const SHOPIFY_HOME = { host: "www.shopify.com", known: ["https://www.shopify.com/favicon.ico"] };

export type IconType = "image/png" | "image/x-icon" | "image/gif" | "image/jpeg" | "image/webp" | "image/avif" | "image/svg+xml";

export interface Icon {
  type: IconType;
  body: Buffer;
}

export class IconError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The image type from the first bytes, or null when it is not an image this app shows. */
export function sniffImage(b: Buffer): IconType | null {
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0 && b.length >= 6 && b.readUInt16LE(4) > 0) return "image/x-icon";
  if (b.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("latin1", 8, 12))) return "image/avif";
  const head = b.toString("utf8", 0, Math.min(b.length, 1024)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A public DNS name for a shop ("shop.example.com"), lowercased, or null. IPs and local names are refused. */
export function cleanHost(input: string): string | null {
  let h = String(input || "").trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/\.$/, "");
  if (h.includes("@") || h.includes(":") || isIP(h)) return null;
  if (!HOST_RE.test(h)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet|test|invalid|example|onion)$/.test(h)) return null;
  return h;
}

/** True for addresses a server must never be sent to by a web page (private, loopback, link-local...). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

export type Lookup = (host: string) => Promise<string[]>;
const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/** Icon links from a page's <head>, best first: the smallest one at least 40 px, then larger, then smaller. */
export function iconLinks(html: string, base: string): string[] {
  const head = html.slice(0, PAGE_MAX_BYTES);
  const found: { url: string; size: number }[] = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel) || /mask-icon/.test(rel)) continue;
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const raw = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").replace(/&amp;/g, "&").trim();
    if (!raw || raw.startsWith("data:")) continue;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const sizes = /\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? "";
    let size = Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/gi)].map((s) => Number(s[1])));
    if (!size) size = /\.svg(\?|$)/i.test(url.pathname) || /any/i.test(sizes) ? 64 : rel.includes("apple-touch") ? 180 : /\.ico(\?|$)/i.test(url.pathname) ? 32 : 32;
    // Shopify's CDN scales on request: ask for 64 px instead of a 32 px favicon.
    if (/\/cdn\/shop\//.test(url.pathname) && url.searchParams.has("width")) {
      url.searchParams.set("width", "64");
      url.searchParams.set("height", "64");
      size = 64;
    }
    found.push({ url: url.href, size });
  }
  const rank = (s: number) => (s >= 40 ? s : 10_000 - s);
  return [...new Set(found.sort((a, b) => rank(a.size) - rank(b.size)).map((f) => f.url))];
}

interface Meta {
  host: string;
  type?: IconType;
  source?: string;
  fetchedAt?: number;
  failedAt?: number;
}

export interface IconCacheOptions {
  fetch?: typeof fetch;
  lookup?: Lookup;
  now?: () => number;
}

/** Fetches each host's icon once and keeps it on disk. One fetch per host at a time. */
export class IconCache {
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: Lookup;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<Icon | null>>();
  /** Fetches made, for tests and the log. */
  fetches = 0;

  constructor(readonly dir: string, opts: IconCacheOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.lookup = opts.lookup ?? defaultLookup;
    this.now = opts.now ?? Date.now;
  }

  /** The icon for a built-in store, or for a Shopify shop when `domain` is given. */
  async forStore(store: string, domain?: string): Promise<Icon | null> {
    if (store === "shopify") {
      if (!domain) return this.get(SHOPIFY_HOME.host, SHOPIFY_HOME.known);
      const host = cleanHost(domain);
      if (!host) throw new IconError(400, "Not a shop domain");
      return this.get(host, []);
    }
    const s = STORE_HOSTS[store as keyof typeof STORE_HOSTS];
    if (!s) throw new IconError(400, "Unknown store");
    return this.get(s.host, s.known);
  }

  get(host: string, known: string[] = []): Promise<Icon | null> {
    const run = this.inflight.get(host);
    if (run) return run;
    const p = this.load(host, known).finally(() => this.inflight.delete(host));
    this.inflight.set(host, p);
    return p;
  }

  private files(host: string) {
    const key = host.replace(/[^a-z0-9.-]/g, "_");
    return { meta: join(this.dir, `${key}.json`), body: join(this.dir, `${key}.img`) };
  }

  private async load(host: string, known: string[]): Promise<Icon | null> {
    const f = this.files(host);
    const meta = await readFile(f.meta, "utf8").then((t) => JSON.parse(t) as Meta).catch(() => null);
    let cached: Icon | null = null;
    if (meta?.type && typeof meta.fetchedAt === "number") {
      const body = await readFile(f.body).catch(() => null);
      if (body && sniffImage(body) === meta.type) {
        cached = { type: meta.type, body };
        if (this.now() - meta.fetchedAt < FRESH_MS) return cached;
      }
    } else if (typeof meta?.failedAt === "number" && this.now() - meta.failedAt < RETRY_MS) {
      return null;
    }
    const got = await this.discover(host, known).catch(() => null);
    await mkdir(this.dir, { recursive: true });
    if (got) {
      await writeAtomic(f.body, got.icon.body);
      await writeAtomic(f.meta, JSON.stringify({ host, type: got.icon.type, source: got.url, fetchedAt: this.now() } satisfies Meta));
      return got.icon;
    }
    if (cached) return cached; // stale beats nothing
    await writeAtomic(f.meta, JSON.stringify({ host, failedAt: this.now() } satisfies Meta));
    return null;
  }

  /** Known URLs first, then the page head's icon links, then /apple-touch-icon.png and /favicon.ico. */
  private async discover(host: string, known: string[]): Promise<{ icon: Icon; url: string } | null> {
    const tried = new Set<string>();
    const tryAll = async (urls: string[]) => {
      for (const u of urls) {
        if (tried.has(u) || tried.size >= MAX_TRIES) continue;
        tried.add(u);
        const icon = await this.fetchIcon(u).catch(() => null);
        if (icon) return { icon, url: u };
      }
      return null;
    };
    const first = await tryAll(known);
    if (first) return first;
    const home = `https://${host}/`;
    const page = await this.fetchBytes(home, PAGE_MAX_BYTES, "text/html,application/xhtml+xml").catch(() => null);
    const links = page ? iconLinks(page.body.toString("utf8"), page.url) : [];
    return tryAll([...links.slice(0, 2), `https://${host}/apple-touch-icon.png`, `https://${host}/favicon.ico`]);
  }

  private async fetchIcon(url: string): Promise<Icon | null> {
    const { body } = await this.fetchBytes(url, ICON_MAX_BYTES, "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8");
    const type = sniffImage(body);
    return type ? { type, body } : null;
  }

  /** GET with redirects checked by hand (each hop must be https and public), a timeout and a byte cap. */
  private async fetchBytes(start: string, max: number, accept: string): Promise<{ body: Buffer; url: string }> {
    let url = new URL(start);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this.checkUrl(url);
      this.fetches++;
      const res = await this.fetchImpl(url.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new Error("redirect without a location");
        url = new URL(loc, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > max) {
        await res.body?.cancel().catch(() => {});
        throw new Error("too large");
      }
      return { body: await readCapped(res, max), url: url.href };
    }
    throw new Error("too many redirects");
  }

  private async checkUrl(url: URL) {
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("not a plain https URL");
    const host = cleanHost(url.hostname);
    if (!host) throw new Error("not a public host");
    const addrs = await this.lookup(host);
    if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error("host resolves to a private address");
  }
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      // A page is only read for its head, so a long page is cut; an icon over the cap is refused.
      if (max === PAGE_MAX_BYTES) break;
      throw new Error("too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Headers for an icon response: cached a day in the browser, SVG sandboxed. */
export function iconHeaders(icon: Icon): Record<string, string> {
  return {
    "Content-Type": icon.type,
    "Cache-Control": "private, max-age=86400",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Content-Length": String(icon.body.length),
  };
}
