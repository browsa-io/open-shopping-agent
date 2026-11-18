// Local settings in .osa/config.json (mode 0600). Keys stay on the server: the web app only ever
// receives masked keys, and an empty key field on save means "keep the current key".

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Money, StoreId } from "../core/types.js";
import { STORE_IDS, maskKey } from "./format.js";
import { proxyDisplay, proxyFromText } from "../core/browsers.js";

export interface OsaConfig {
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
    };
  }

  async publicView(): Promise<PublicConfig> {
    return toPublic(await this.effective());
  }

  async update(patch: unknown): Promise<OsaConfig> {
    const cur = await this.read();
    const next = { ...cur, ...sanitize(patch, cur) };
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
  };
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
