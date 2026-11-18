// Local settings in .osa/config.json (mode 0600). Keys stay on the server: the web app only ever
// receives masked keys, and an empty key field on save means "keep the current key".

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Money, StoreId } from "../core/types.js";
import { STORE_IDS, maskKey } from "./format.js";
import { proxyDisplay, proxyFromText } from "../core/browsers.js";
import { cdpDisplay, maskProxyText, parseProviderId, parseProxy, PROVIDER_CHOICES, PROVIDER_TABLE, type ProviderId } from "../core/providers/index.js";

/** Settings added with browser providers and bring-your-own keys (see byokPublic). */
export interface ByokConfig {
  /** Browser provider: "auto" (default), "browsa", "local" or "cdp". OSA_BROWSER wins. */
  browser?: ProviderId | "auto";
  /** A DevTools browser URL for the cdp provider. OSA_CDP_URL wins. Shown as host only. */
  cdpUrl?: string;
  /** Your own proxy per store. OSA_PROXY_<STORE> wins. */
  storeProxies?: Partial<Record<StoreId, string>>;
  /** A small pool of your proxies, rotated per store and run. OSA_PROXIES wins. */
  proxyPool?: string[];
  /** OpenAI-compatible base URL of your own model (OpenRouter, a local server). OSA_LLM_BASE_URL wins. */
  llmBaseUrl?: string;
}

export interface OsaConfig extends ByokConfig {
  browsaApiKey?: string;
  llm?: string;              // "browsa" (hosted, default) or a provider/model name
  llmApiKey?: string;
  zip?: string;
  budget?: Money;
  allowedStores?: StoreId[];
  shopifyDomains?: string[];
  /** "burner": a fresh Phantom browser per run (default). "persistent": a saved profile per store. */
  browserMode?: BrowserChoice;
  /** The user's own proxy for every store ("http://user:pass@host:port"). OSA_PROXY wins. Free on Browsa. */
  proxy?: string;
}

export type BrowserChoice = "burner" | "persistent";

export const BROWSER_CHOICES: { value: BrowserChoice; label: string }[] = [
  { value: "burner", label: "Fresh browser per run (about 1 credit)" },
  { value: "persistent", label: "Saved store profiles (keeps logins and carts, 50 credits a month per store)" },
];

export interface PublicConfig {
  browsaApiKey: string;      // masked
  hasBrowsaApiKey: boolean;
  llm: string;
  llmApiKey: string;         // masked
  hasLlmApiKey: boolean;
  zip: string;
  budget?: Money;
  allowedStores: StoreId[];
  shopifyDomains: string[];
  browserMode: BrowserChoice;
  proxy: string;             // "host:port" only, never the user name or password
  hasProxy: boolean;
  /** Added with browser providers and bring-your-own keys. */
  byok: ByokPublic;
}

export function osaHome(): string {
  return resolve(process.env.OSA_HOME || process.env.OSA_DIR || join(process.cwd(), ".osa"));
}

export const DEFAULT_STORES: StoreId[] = ["amazon", "walmart", "ebay", "bestbuy", "target"];

export class ConfigStore {
  readonly file: string;
  constructor(home = osaHome()) {
    this.file = join(home, "config.json");
  }

  async read(): Promise<OsaConfig> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as OsaConfig;
    } catch {
      return {};
    }
  }

  /** Settings with env overrides (BROWSA_API_KEY, OSA_LLM, OSA_LLM_API_KEY win over the file). */
  async effective(): Promise<OsaConfig> {
    const c = await this.read();
    return {
      ...c,
      browsaApiKey: process.env.BROWSA_API_KEY || c.browsaApiKey,
      llm: process.env.OSA_LLM || c.llm,
      llmApiKey: process.env.OSA_LLM_API_KEY || c.llmApiKey,
      proxy: process.env.OSA_PROXY || c.proxy,
      browser: (process.env.OSA_BROWSER as OsaConfig["browser"]) || c.browser,
      cdpUrl: process.env.OSA_CDP_URL || c.cdpUrl,
      llmBaseUrl: process.env.OSA_LLM_BASE_URL || c.llmBaseUrl,
    };
  }

  async publicView(): Promise<PublicConfig> {
    return toPublic(await this.effective());
  }

  async update(patch: unknown): Promise<OsaConfig> {
    const cur = await this.read();
    const next = { ...cur, ...sanitize(patch, cur), ...sanitizeByok(patch, cur) };
    await mkdir(join(this.file, ".."), { recursive: true });
    await writeFile(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    await chmod(this.file, 0o600).catch(() => {});
    return next;
  }
}

export function toPublic(c: OsaConfig): PublicConfig {
  return {
    browsaApiKey: maskKey(c.browsaApiKey),
    hasBrowsaApiKey: !!c.browsaApiKey,
    llm: c.llm || "browsa",
    llmApiKey: maskKey(c.llmApiKey),
    hasLlmApiKey: !!c.llmApiKey,
    zip: c.zip || "",
    budget: c.budget,
    allowedStores: c.allowedStores?.length ? c.allowedStores : DEFAULT_STORES,
    shopifyDomains: c.shopifyDomains ?? [],
    browserMode: c.browserMode === "persistent" ? "persistent" : "burner",
    proxy: c.proxy ? safeProxyDisplay(c.proxy) : "",
    hasProxy: !!c.proxy,
    byok: byokPublic(c),
  };
}

export interface ByokPublic {
  browser: ProviderId | "auto";
  choices: typeof PROVIDER_CHOICES;
  table: typeof PROVIDER_TABLE;
  cdpUrl: string;              // host only
  hasCdpUrl: boolean;
  storeProxies: Partial<Record<StoreId, string>>; // "scheme://host:port" only
  proxyPool: string[];         // "scheme://host:port" only
  llmBaseUrl: string;
}

/** The provider and bring-your-own-key settings as the web app sees them: never a password or token. */
export function byokPublic(c: OsaConfig): ByokPublic {
  let browser: ProviderId | "auto" = "auto";
  try { browser = parseProviderId(c.browser) ?? "auto"; } catch { /* a bad env value: show auto */ }
  return {
    browser,
    choices: PROVIDER_CHOICES,
    table: PROVIDER_TABLE,
    cdpUrl: c.cdpUrl ? cdpDisplay(c.cdpUrl) : "",
    hasCdpUrl: !!c.cdpUrl,
    storeProxies: Object.fromEntries(Object.entries(c.storeProxies ?? {}).filter(([, v]) => v).map(([k, v]) => [k, maskProxyText(v)])),
    proxyPool: (c.proxyPool ?? []).map((p) => maskProxyText(p)),
    llmBaseUrl: c.llmBaseUrl ? safeBase(c.llmBaseUrl) : "",
  };
}

function safeBase(u: string): string {
  try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname}`; } catch { return "set"; }
}

const masked = (v: unknown) => typeof v === "string" && (v.includes("•") || v.includes("(with login)"));

/** The provider and BYOK part of the settings form. Masked values keep what is stored. */
export function sanitizeByok(input: unknown, cur: OsaConfig): Partial<OsaConfig> {
  const i = (input ?? {}) as Record<string, unknown>;
  const out: Partial<OsaConfig> = {};
  if ("browser" in i) {
    const id = parseProviderId(typeof i.browser === "string" ? i.browser : undefined);
    out.browser = id ?? undefined;
  }
  if ("cdpUrl" in i) {
    const v = typeof i.cdpUrl === "string" ? i.cdpUrl.trim() : "";
    if (i.cdpUrl === null || !v) out.cdpUrl = undefined;
    else if (v === cdpDisplay(cur.cdpUrl ?? "") || masked(v)) out.cdpUrl = cur.cdpUrl;
    else if (!/^(wss?|https?):\/\/[^\s]+$/i.test(v)) throw new Error("The CDP URL must start with ws://, wss://, http:// or https://");
    else out.cdpUrl = v.slice(0, 1000);
  }
  if ("storeProxies" in i) {
    // Per store: empty or missing keeps the saved proxy, null or "none" removes it.
    const src = (i.storeProxies ?? {}) as Record<string, unknown>;
    const next: Partial<Record<StoreId, string>> = {};
    for (const s of STORE_IDS) {
      const v = src[s];
      if (v === null || (typeof v === "string" && v.trim().toLowerCase() === "none")) continue;
      if (typeof v !== "string" || !v.trim()) { if (cur.storeProxies?.[s]) next[s] = cur.storeProxies[s]; continue; }
      if (masked(v) || v === maskProxyText(cur.storeProxies?.[s])) { if (cur.storeProxies?.[s]) next[s] = cur.storeProxies[s]; continue; }
      parseProxy(v); // throws a readable error
      next[s] = v.trim().slice(0, 400);
    }
    out.storeProxies = Object.keys(next).length ? next : undefined;
  }
  if ("proxyPool" in i) {
    const list = Array.isArray(i.proxyPool) ? i.proxyPool : typeof i.proxyPool === "string" ? i.proxyPool.split(/[\n,]+/) : [];
    const curMasked = new Map((cur.proxyPool ?? []).map((p) => [maskProxyText(p), p]));
    const next: string[] = [];
    for (const raw of list) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const v = raw.trim();
      const kept = curMasked.get(v);
      if (kept) { next.push(kept); continue; }
      parseProxy(v);
      next.push(v.slice(0, 400));
    }
    out.proxyPool = next.length ? next.slice(0, 50) : undefined;
  }
  if ("llmBaseUrl" in i) {
    const v = typeof i.llmBaseUrl === "string" ? i.llmBaseUrl.trim() : "";
    if (!v) out.llmBaseUrl = undefined;
    else if (v === safeBase(cur.llmBaseUrl ?? "")) out.llmBaseUrl = cur.llmBaseUrl;
    else if (!/^https?:\/\/[^\s]+$/i.test(v)) throw new Error("The model base URL must start with http:// or https://");
    else out.llmBaseUrl = v.slice(0, 400);
  }
  return out;
}

function safeProxyDisplay(text: string): string {
  try { return proxyDisplay(proxyFromText(text)) ?? "set"; } catch { return "set"; }
}

/** Accepts the settings form body. Empty or masked key strings keep the stored key; "clear" via null. */
function sanitize(input: unknown, cur: OsaConfig): Partial<OsaConfig> {
  const i = (input ?? {}) as Record<string, unknown>;
  const out: Partial<OsaConfig> = {};
  const key = (v: unknown, prev: string | undefined) => {
    if (v === null) return undefined;
    if (typeof v !== "string") return prev;
    const t = v.trim();
    if (!t || t.includes("•")) return prev;
    return t.slice(0, 400);
  };
  if ("browsaApiKey" in i) out.browsaApiKey = key(i.browsaApiKey, cur.browsaApiKey);
  if ("llmApiKey" in i) out.llmApiKey = key(i.llmApiKey, cur.llmApiKey);
  if (typeof i.llm === "string") out.llm = i.llm.trim().slice(0, 100) || undefined;
  if (typeof i.zip === "string") {
    const z = i.zip.trim();
    if (z && !/^\d{5}(-\d{4})?$/.test(z)) throw new Error("ZIP must be 5 digits");
    out.zip = z || undefined;
  }
  if ("budget" in i) {
    const b = i.budget as Money | null | number | string;
    if (b === null || b === "" || b === undefined) out.budget = undefined;
    else if (typeof b === "object" && Number.isInteger(b.cents) && b.cents > 0) out.budget = { cents: b.cents, currency: "USD" };
    else {
      const n = parseFloat(String(b).replace(/[$,]/g, ""));
      if (!Number.isFinite(n) || n <= 0) throw new Error("Budget must be a positive amount");
      out.budget = { cents: Math.round(n * 100), currency: "USD" };
    }
  }
  if (Array.isArray(i.allowedStores)) {
    const s = i.allowedStores.filter((x): x is StoreId => STORE_IDS.includes(x as StoreId));
    if (!s.length) throw new Error("Pick at least one store");
    out.allowedStores = [...new Set(s)];
  }
  if ("proxy" in i) {
    if (i.proxy === null || i.proxy === "") out.proxy = undefined;
    else if (typeof i.proxy === "string" && i.proxy.trim() && !i.proxy.includes("•")) {
      const t = i.proxy.trim().slice(0, 400);
      proxyFromText(t); // throws a readable error for a bad value
      out.proxy = t;
    }
  }
  if ("browserMode" in i) {
    if (i.browserMode !== "burner" && i.browserMode !== "persistent") throw new Error("browserMode must be burner or persistent");
    out.browserMode = i.browserMode;
  }
  if (Array.isArray(i.shopifyDomains)) {
    out.shopifyDomains = i.shopifyDomains
      .filter((d): d is string => typeof d === "string")
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
      .slice(0, 10);
  }
  return out;
}
