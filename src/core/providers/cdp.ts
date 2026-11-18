// The CDP provider: any browser that speaks the Chrome DevTools Protocol, at OSA_CDP_URL (ws:// or
// http://). Your own remote Chrome, or another cloud browser provider. Optional headers as JSON in
// OSA_CDP_HEADERS (an API key header, for example). Each store gets its own tab; closing the store
// closes that tab and disconnects. The remote browser's own proxy applies (OSA_PROXY is not used).
// No captcha solving, no live link, no US home-internet exit; AI fallback only with your own key.

import { chromium, type Browser } from "playwright-core";
import type { StoreId } from "../types.js";
import type { LLMConfig, JSONRequest } from "../llm.js";
import { buildProviderBrowser } from "./context.js";
import { PROVIDER_LABELS, type BrowserCapabilities, type BrowserProvider, type OpenOptions, type ProviderBrowser } from "./types.js";

export interface CdpProviderOptions {
  url?: string;                                  // default OSA_CDP_URL
  headers?: Record<string, string>;              // default JSON of OSA_CDP_HEADERS
  llm?: LLMConfig;
  aiMaxSteps?: number;
  complete?: (cfg: LLMConfig, req: JSONRequest) => Promise<unknown>;
  connect?: (url: string, headers: Record<string, string>) => Promise<Browser>;
  env?: Record<string, string | undefined>;
  /** True when the user set their own proxies: told once that the remote browser's proxy applies. */
  userProxies?: boolean;
}

export function parseCdpHeaders(text: string | undefined): Record<string, string> {
  const t = text?.trim();
  if (!t) return {};
  let o: unknown;
  try { o = JSON.parse(t); } catch { throw new Error('OSA_CDP_HEADERS must be a JSON object, like {"X-API-Key":"..."}'); }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("OSA_CDP_HEADERS must be a JSON object");
  return Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** "host:port" of a CDP URL for logs, never its query string (tokens often live there). */
export function cdpDisplay(url: string): string {
  try { const u = new URL(url); return u.host; } catch { return "the CDP browser"; }
}

export class CdpProvider implements BrowserProvider {
  readonly id = "cdp" as const;
  readonly label = PROVIDER_LABELS.cdp;
  readonly capabilities: BrowserCapabilities;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private told = false;

  constructor(private readonly o: CdpProviderOptions = {}) {
    const env = o.env ?? process.env;
    this.url = (o.url ?? env.OSA_CDP_URL ?? "").trim();
    if (!this.url) throw new Error("OSA_CDP_URL is not set: give the ws:// or http:// address of a browser that speaks the DevTools protocol");
    if (!/^(wss?|https?):\/\//i.test(this.url)) throw new Error("OSA_CDP_URL must start with ws://, wss://, http:// or https://");
    this.headers = o.headers ?? parseCdpHeaders(env.OSA_CDP_HEADERS);
    this.capabilities = { liveLink: "none", aiFallback: !!o.llm, captchaSolving: false, residentialExit: false, savedProfiles: false, fingerprint: "standard" };
  }

  async open(store: StoreId, opts: OpenOptions = {}): Promise<ProviderBrowser> {
    if (this.o.userProxies && !this.told) {
      this.told = true;
      opts.log?.("your proxies are not used with a CDP browser: the remote browser's own proxy applies (set it at your provider)");
    }
    let browser: Browser;
    try {
      browser = await (this.o.connect ?? ((u, h) => chromium.connectOverCDP(u, { headers: h, timeout: 60_000 })))(this.url, this.headers);
    } catch (e) {
      throw new Error(`could not connect to the CDP browser at ${cdpDisplay(this.url)}: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)}`);
    }
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    opts.log?.(`connected to the CDP browser at ${cdpDisplay(this.url)}`);
    return buildProviderBrowser({
      store, provider: "cdp", capabilities: this.capabilities, agentId: `cdp-${store}`, page, context: ctx,
      llm: this.o.llm, aiMaxSteps: this.o.aiMaxSteps, complete: this.o.complete, log: opts.log,
      close: async (p) => {
        await p.close().catch(() => {});
        await browser.close().catch(() => {}); // a CDP connection: this disconnects, the remote browser keeps running
      },
    });
  }
}
