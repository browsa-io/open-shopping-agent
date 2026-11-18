// Shared harness for the opt-in live tests of the eBay and Best Buy adapters (OSA_LIVE=1).
// It builds a minimal StoreContext on a fresh Phantom browser (Browsa), runs every stage on a list
// of real products and reports pass counts per stage. It never places an order, never signs in and
// never types personal details: checkout stops on the first sign-in / guest / address step.
//
//   OSA_LIVE=1 BROWSA_API_KEY=... npm test -- test/stores/ebay.live.test.ts
//   OSA_LIVE_PROXY=residential   use Browsa's US residential exit (costs credits per GB)
//   OSA_LIVE_AI=1                allow ctx.aiTask() fallbacks (each capped at 10 credits)
//   OSA_LIVE_OUT=path.json       write the per-product results

import { writeFileSync } from "node:fs";
import { Client } from "browsa";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ItemRequest, Offer } from "../../src/core/types.js";
import type { StoreAdapter, StoreContext } from "../../src/stores/adapter.js";

export const LIVE = process.env.OSA_LIVE === "1";
export type StageName = "search" | "details" | "addToCart" | "readCart" | "checkout" | "clearCart";
export interface ProductRun { query: string; stages: Partial<Record<StageName, { ok: boolean; ms: number; note?: string }>>; offer?: string; option?: Record<string, string> }

const BLOCKED = [
  "*.jpg*", "*.jpeg*", "*.png*", "*.gif*", "*.webp*", "*.avif*", "*.svg*", "*.mp4*", "*.webm*", "*.woff*", "*.woff2*", "*.ttf*",
  "*i.ebayimg.com*", "*pisces.bbystatic.com/image2*", "*doubleclick.net*", "*googlesyndication.com*", "*googleadservices.com*",
  "*google-analytics.com*", "*googletagmanager.com*", "*facebook.net*", "*facebook.com/tr*", "*bing.com*", "*criteo*", "*adsafeprotected.com*",
  "*contentsquare.net*", "*dynatrace.com*", "*tiktok*", "*pinterest*", "*snapchat*", "*quantummetric*", "*clarity.ms*", "*adtrafficquality*",
];

export async function openStore(store: StoreAdapter): Promise<{ ctx: StoreContext; close: () => Promise<void>; renew: () => Promise<boolean>; client: Client; agentId: string }> {
  const apiKey = process.env.BROWSA_API_KEY;
  if (!apiKey) throw new Error("BROWSA_API_KEY is required for live tests");
  const client = new Client({ apiKey, timeoutMs: 120_000 });
  const proxy = process.env.OSA_LIVE_PROXY ? { network: process.env.OSA_LIVE_PROXY, country: "us" } : undefined;
  let agent: Record<string, any> | undefined;
  for (let tries = 0; !agent; tries++) {
    try { agent = await client.createAgent({ ttl: "20m", ...(proxy ? { proxy } : {}) } as any); }
    catch (e: any) {
      // The workspace's browser slots are shared; wait for one (up to 15 minutes).
      // A network error gets the same short wait (nothing is charged when no browser starts).
      if ((e?.status !== 429 && e?.status !== undefined) || tries >= 30) throw e;
      console.log(`  ${e?.status === 429 ? "browser slots busy" : `create failed (${e?.message})`}, waiting ${e.retryAfter ?? 30}s`);
      await new Promise((r) => setTimeout(r, (e.retryAfter ?? 30) * 1000));
    }
  }
  const agentId = String(agent.id ?? agent.agent_id);
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(String(agent.cdp_http), { headers: { "X-API-Key": apiKey }, timeout: 60_000 });
    const context = browser.contexts()[0] ?? await browser.newContext();
    let crashed = false;
    const setup = async (p: Page) => {
      // Save bandwidth (the residential exit is billed per GB): block images, media, fonts and ad or
      // analytics hosts inside the browser. Playwright's route() would send every request over the
      // network to this process and back, which stalls heavy pages, so it is not used.
      if (process.env.OSA_LIVE_BLOCK !== "0") {
        const cdp = await context.newCDPSession(p);
        await cdp.send("Network.enable");
        await cdp.send("Network.setBlockedURLs", { urls: BLOCKED });
      }
      p.setDefaultTimeout(30_000);
      p.on("crash", () => { crashed = true; console.log("  page crashed"); });
      return p;
    };
    const page: Page = await setup(context.pages()[0] ?? await context.newPage());
    const ac = new AbortController();
    let aiCalls = 0;
    const ctx: StoreContext = {
      store: store.id,
      domain: store.domains[0],
      zip: process.env.OSA_LIVE_ZIP ?? "10001",
      page,
      agentId,
      async aiTask<T>(task: string, opts?: { schema?: object; maxSteps?: number; startUrl?: string }): Promise<T> {
        if (process.env.OSA_LIVE_AI !== "1") throw new Error("AI fallback disabled in this live run");
        if (++aiCalls > 2) throw new Error("AI fallback cap reached for this run");
        // A burner cannot take agent_id ("sessions can only be opened on persistent agents"): a
        // standalone task in its own browser, starting at the current page (its cart is separate).
        const job = await client.runTask({ task, llm: "browsa", maxCredits: 10, maxSteps: opts?.maxSteps, initialUrl: opts?.startUrl ?? ctx.page.url() });
        const text = (job as any).finalResult ?? "";
        try { return JSON.parse(String(text).replace(/^```(json)?|```$/g, "")) as T; } catch { return { text } as T; }
      },
      async liveLink() {
        const l = await client.createLiveLink(agentId, { scope: "control", ttlSeconds: 900 });
        return l.live_url;
      },
      log: (m: string) => console.log(`  [${store.id}] ${m}`),
      signal: ac.signal,
      /** A crashed tab stays dead; open a fresh one in the same browser (same cookies and cart). */
      async newPage() {
        crashed = false;
        const old = ctx.page;
        ctx.page = await setup(await context.newPage());
        await old.close().catch(() => {});
        return ctx.page;
      },
    };
    return {
      ctx, client, agentId,
      /** Between products: replace a tab that crashed outside an adapter call. */
      renew: async () => {
        if (!crashed && !ctx.page.isClosed()) return false;
        await ctx.newPage();
        return true;
      },
      close: async () => {
        ac.abort();
        await browser?.close().catch(() => {});
        await client.destroyAgent(agentId).catch((e: Error) => console.log(`destroy ${agentId}: ${e.message}`));
      },
    };
  } catch (e) {
    await browser?.close().catch(() => {});
    await client.destroyAgent(agentId).catch(() => {});
    throw e;
  }
}

async function stage<T>(run: ProductRun, name: StageName, fn: () => Promise<{ ok: boolean; note?: string; value?: T }>): Promise<T | undefined> {
  const t = Date.now();
  try {
    const r = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("stage took over 4 minutes")), 240_000))]);
    run.stages[name] = { ok: r.ok, ms: Date.now() - t, note: r.note };
    console.log(`  ${r.ok ? "PASS" : "FAIL"} ${name} (${Date.now() - t} ms)${r.note ? `: ${r.note}` : ""}`);
    return r.value;
  } catch (e) {
    const note = (e as Error).message.split("\n")[0].slice(0, 240);
    run.stages[name] = { ok: false, ms: Date.now() - t, note };
    console.log(`  FAIL ${name}: ${note}`);
    return undefined;
  }
}

/** Pick an option that is not the default, so the option code path runs. */
function pickOption(offer: Offer): Record<string, string> | undefined {
  const v = offer.variants;
  if (!v) return undefined;
  // eBay lists the buyable combinations; take one that is not the first.
  const combos = offer.raw?.variationCombos as Record<string, string>[] | undefined;
  if (combos?.length) return combos[1] ?? combos[0];
  const skus = (offer.raw?.variationSkus ?? {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [name, values] of Object.entries(v)) {
    if (!values.length) continue;
    out[name] = values.find((x) => skus[`${name}:${x}`] && skus[`${name}:${x}`] !== offer.productId) ?? values[1] ?? values[0];
    // Best Buy: every option value is its own SKU, so one dimension is enough to test the switch.
    if (offer.store === "bestbuy") break;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function runProducts(adapter: StoreAdapter, queries: string[], opts: { checkoutEvery?: boolean } = {}): Promise<ProductRun[]> {
  const runs: ProductRun[] = [];
  const { ctx, close, renew } = await openStore(adapter);
  try {
    for (const [i, query] of queries.entries()) {
      if (await renew()) console.log("  opened a new tab after a crash");
      console.log(`\n${adapter.name}: "${query}"`);
      const run: ProductRun = { query, stages: {} };
      runs.push(run);
      const item: ItemRequest = { id: `item-${i + 1}`, query, description: query, quantity: 1 };
      const offers = await stage<Offer[]>(run, "search", async () => {
        const o = await adapter.search(ctx, item, 8);
        const good = o.filter((x) => x.price.cents > 0 && x.title && x.productId);
        return { ok: good.length >= 3, note: `${o.length} offers; first: ${o[0] ? `${o[0].title.slice(0, 50)} ${o[0].price.cents / 100}` : "none"}`, value: o };
      });
      if (!offers?.length) continue;
      const pickFrom = offers.filter((o) => o.inStock && !o.sponsored);
      const chosen = pickFrom.find((o) => o.raw?.priceRange) ?? pickFrom[0] ?? offers[0];
      const detailed = await stage<Offer>(run, "details", async () => {
        const d = await adapter.details!(ctx, chosen);
        const ok = d.price.cents > 0 && !!d.title && (adapter.id !== "ebay" || (d.raw?.buyItNow === true && !!d.seller));
        return { ok, note: `${d.title.slice(0, 50)} ${d.price.cents / 100} ${d.condition ?? "?"} stock=${d.inStock} variants=${JSON.stringify(d.variants ?? {}).slice(0, 80)} delivery=${d.deliveryText ?? "?"}`, value: d };
      });
      if (!detailed) continue;
      run.offer = `${detailed.productId} ${detailed.title.slice(0, 60)}`;
      const option = pickOption(detailed);
      run.option = option;
      const cart = await stage(run, "addToCart", async () => {
        const c = await adapter.addToCart(ctx, detailed, 1, option);
        const line = c.lines.find((l) => l.productId === detailed.productId) ?? c.lines[c.lines.length - 1];
        return { ok: !!line && c.warnings.length === 0, note: `${c.lines.length} lines; option ${JSON.stringify(option ?? {})}; cart shows ${JSON.stringify(line?.options ?? {})}${c.warnings.length ? `; warnings: ${c.warnings.join("; ")}` : ""}`, value: c };
      });
      await stage(run, "readCart", async () => {
        const c = await adapter.readCart(ctx);
        const ok = c.lines.length >= 1 && c.lines.every((l) => l.price.cents > 0 && l.quantity >= 1);
        return { ok, note: `${c.lines.length} lines, subtotal ${c.subtotal ? c.subtotal.cents / 100 : "?"}` };
      });
      if (cart && (opts.checkoutEvery || i === queries.length - 1)) {
        await stage(run, "checkout", async () => {
          const r = await adapter.reviewCheckout(ctx);
          const ok = !!r.needsUser && ["sign_in", "address", "payment"].includes(r.needsUser.reason) && !!r.needsUser.liveUrl && r.total.cents > 0;
          return { ok, note: `total ${r.total.cents / 100}, needsUser ${r.needsUser?.reason ?? "none"}, live link ${r.needsUser?.liveUrl ? "yes" : "no"}` };
        });
      }
      await stage(run, "clearCart", async () => {
        await adapter.clearCart!(ctx);
        const c = await adapter.readCart(ctx);
        return { ok: c.lines.length === 0, note: `${c.lines.length} lines left` };
      });
    }
  } finally {
    await close();
  }
  const names: StageName[] = ["search", "details", "addToCart", "readCart", "checkout", "clearCart"];
  console.log(`\n${adapter.name} pass counts:`);
  for (const n of names) {
    const tried = runs.filter((r) => r.stages[n]);
    console.log(`  ${n.padEnd(10)} ${tried.filter((r) => r.stages[n]!.ok).length}/${tried.length}`);
  }
  if (process.env.OSA_LIVE_OUT) writeFileSync(process.env.OSA_LIVE_OUT, JSON.stringify(runs, null, 1));
  return runs;
}
