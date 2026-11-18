// Live test harness for the Target and Shopify live tests (OSA_LIVE=1). Builds a minimal
// StoreContext on a fresh Browsa browser (Phantom) and destroys it afterwards.
//
//   BROWSA_API_KEY=agt_...       a key of the workspace that pays (required)
//   OSA_LIVE_PROXY=residential   optional built-in exit for the browser ("residential" or "datacenter")
//   OSA_LIVE_COUNTRY=us          country of that exit (default us)
//   OSA_LIVE_OUT=path.json       optional: write the per-stage results there
//
// Never places an order, never signs in, never types card or address details.

import { writeFileSync } from "node:fs";
import { Client } from "browsa";
import { chromium, type Browser } from "playwright-core";
import type { StoreContext } from "../../src/stores/adapter.js";
import type { StoreId } from "../../src/core/types.js";

export const LIVE = process.env.OSA_LIVE === "1" && !!process.env.BROWSA_API_KEY;

export interface LiveStats { aiTasks: number; aiCredits: number; logs: string[] }

export interface LiveBrowser {
  client: Client;
  agentId: string;
  browser: Browser;
  ctxFor(store: StoreId, domain: string, zip?: string): StoreContext;
  stats: LiveStats;
  close(): Promise<{ credits?: number; proxyBytes?: number }>;
}

export async function openLiveBrowser(opts: { proxy?: string; country?: string; ttl?: string } = {}): Promise<LiveBrowser> {
  const apiKey = process.env.BROWSA_API_KEY!;
  const client = new Client({ apiKey, timeoutMs: 120_000 });
  const proxyNet = opts.proxy ?? process.env.OSA_LIVE_PROXY;
  let agent: Record<string, any> | undefined;
  // The workspace has a fixed number of browser slots; wait for one (up to 10 minutes).
  for (let i = 0; !agent; i++) {
    try {
      agent = await client.createAgent({
        ttl: opts.ttl ?? "20m",
        ...(proxyNet ? { proxy: { network: proxyNet, country: opts.country ?? process.env.OSA_LIVE_COUNTRY ?? "us" } as never } : {}),
      });
    } catch (e) {
      if ((e as { status?: number }).status !== 429 || i >= 20) throw e;
      console.log("  all browser slots busy; waiting 30 s");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  const agentId: string = agent.agent_id ?? agent.id;
  console.log(`  browser ${agentId}${proxyNet ? ` (${proxyNet} exit)` : ""}`);
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(agent.cdp_http, { headers: { "X-API-Key": apiKey }, timeout: 60_000 });
  } catch (e) {
    await client.destroyAgent(agentId).catch(() => {});
    throw e;
  }
  const context = browser.contexts()[0] ?? await browser.newContext();
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(30_000);
  const stats: LiveStats = { aiTasks: 0, aiCredits: 0, logs: [] };
  return {
    client, agentId, browser, stats,
    ctxFor(store, domain, zip) {
      const ctx: StoreContext = {
        store, domain, zip, page, agentId,
        async aiTask<T>(task: string, o?: { schema?: object; maxSteps?: number; startUrl?: string }): Promise<T> {
          stats.aiTasks++;
          // A burner cannot take agent_id: a standalone task in its own browser (separate cart).
          const job = await client.runTask({ task: `${task}\nAnswer with JSON only.`, llm: "browsa", maxCredits: 10, maxSteps: o?.maxSteps ?? 10, initialUrl: o?.startUrl ?? ctx.page.url() });
          stats.aiCredits += job.creditsCharged ?? 0;
          stats.logs.push(`[${store}] aiTask ${job.id} ${job.status}${job.errorMessage ? `: ${job.errorMessage}` : ""}`);
          console.log(`  aiTask ${job.id} ${job.status}${job.errorMessage ? `: ${job.errorMessage.slice(0, 200)}` : ""}`);
          const text = job.finalResult ?? "";
          const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
          try { return (m ? JSON.parse(m[0]) : {}) as T; } catch { return {} as T; }
        },
        async liveLink() { return (await client.createLiveLink(agentId, { scope: "control", ttlSeconds: 600 })).live_url; },
        log(m: string) { stats.logs.push(`[${store}] ${m}`); if (process.env.OSA_LIVE_VERBOSE) console.log(`  log: ${m}`); },
        signal: new AbortController().signal,
        async newPage() {
          const old = ctx.page;
          ctx.page = await context.newPage();
          ctx.page.setDefaultTimeout(30_000);
          await old.close().catch(() => {});
          return ctx.page;
        },
      };
      return ctx;
    },
    async close() {
      let credits: number | undefined;
      let proxyBytes: number | undefined;
      await browser.close().catch(() => {});
      await client.destroyAgent(agentId).catch(() => {});
      // Net charge = charged minus the refund of unused reserved time (the refund lands after destroy).
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const a = await client.getAgent(agentId);
          proxyBytes = a.proxy_bytes ?? proxyBytes;
          if (typeof a.credits_charged === "number") credits = a.credits_charged - (a.credits_refunded ?? 0);
          if (a.credits_refunded) break;
        } catch { /* ignore */ }
      }
      return { credits, proxyBytes };
    },
  };
}

export type StageName = "search" | "product" | "options" | "cart" | "readCart" | "clearCart" | "checkout";
export interface StageResult { store: string; product: string; stage: StageName; ok: boolean; ms: number; note?: string }

export class Scoreboard {
  results: StageResult[] = [];
  async run<T>(store: string, product: string, stage: StageName, fn: () => Promise<T>, check?: (v: T) => string | undefined): Promise<T | undefined> {
    const t0 = Date.now();
    try {
      const v = await fn();
      const problem = check?.(v);
      this.results.push({ store, product, stage, ok: !problem, ms: Date.now() - t0, note: problem });
      console.log(`  ${problem ? "FAIL" : "ok  "} ${store} ${stage} ${product}${problem ? `: ${problem}` : ""} (${Date.now() - t0} ms)`);
      return v;
    } catch (e) {
      const note = (e as Error).message.slice(0, 300);
      this.results.push({ store, product, stage, ok: false, ms: Date.now() - t0, note });
      console.log(`  FAIL ${store} ${stage} ${product}: ${note} (${Date.now() - t0} ms)`);
      return undefined;
    }
  }
  summary(): string {
    const rows = new Map<string, { ok: number; n: number }>();
    for (const r of this.results) {
      const k = `${r.store} ${r.stage}`;
      const x = rows.get(k) ?? { ok: 0, n: 0 };
      x.n++; if (r.ok) x.ok++;
      rows.set(k, x);
    }
    return [...rows.entries()].map(([k, v]) => `${k}: ${v.ok}/${v.n}`).join("\n");
  }
  save(extra: Record<string, unknown>) {
    if (process.env.OSA_LIVE_OUT) writeFileSync(process.env.OSA_LIVE_OUT, JSON.stringify({ ...extra, results: this.results }, null, 1));
  }
}
