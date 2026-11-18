// Live test harness for the Amazon and Walmart adapters (opt-in: OSA_LIVE=1 and BROWSA_API_KEY).
// Builds a minimal StoreContext on a fresh Phantom browser, runs real searches, adds to cart,
// reads the cart back and opens checkout up to the sign-in page. It never signs in, never types
// an address or card, never places an order. Every browser it creates is destroyed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "browsa";
import { chromium, type Browser } from "playwright-core";
import type { Cart, ItemRequest, Offer, StoreId } from "../../src/core/types.js";
import type { StoreAdapter, StoreContext } from "../../src/stores/adapter.js";

export const LIVE = process.env.OSA_LIVE === "1" && !!process.env.BROWSA_API_KEY;

export interface LiveProduct { query: string; quantity?: number }

export const PRODUCTS: LiveProduct[] = [
  { query: "usb c hub" },
  { query: "hdmi cable 6 ft", quantity: 2 },
  { query: "laptop stand" },
  { query: "wireless mouse" },
  { query: "aa batteries" },
];

type Stage = "search" | "details" | "addToCart" | "options" | "readCart" | "checkout" | "clearCart";
export interface StageStats { pass: number; fail: number; notes: string[] }

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

/** Errors from the test's own connection (local network, CDP socket), not from the store or adapter. */
export function isInfraError(e: unknown): boolean {
  return /has been closed|Target closed|browser has disconnected|network error|fetch failed|ECONNRESET|socket hang up|WebSocket/i.test(String((e as Error)?.message ?? e));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function liveContext(store: StoreId, domain: string) {
  const key = process.env.BROWSA_API_KEY!;
  const client = new Client({ apiKey: key, ...(process.env.BROWSA_BASE_URL ? { baseUrl: process.env.BROWSA_BASE_URL } : {}) });
  // The workspace has a few browser slots shared by every live test: wait for one.
  let agent: Record<string, any> | undefined;
  for (let attempt = 0; !agent; attempt++) {
    try { agent = await client.createAgent({ ttl: "20m" }); } catch (e) {
      const err = e as { status?: number; retryAfter?: number };
      if (!(err.status === 429 || isInfraError(e)) || attempt >= 40) throw e;
      console.log(`[${store}] no free browser slot (or network), retrying in ${err.retryAfter ?? 30}s`);
      await sleep((err.retryAfter ?? 30) * 1000);
    }
  }
  const agentId: string = agent.id ?? agent.agent_id;
  const cdp: string = agent.cdp_http;
  console.log(`[${store}] created browser ${agentId}`);
  let browser: Browser | undefined;
  const ai = { calls: 0, credits: 0, max: Number(process.env.OSA_LIVE_MAX_AI ?? 0) };
  const logs: string[] = [];
  const destroy = async () => {
    for (let i = 0; i < 6; i++) {
      try { await client.destroyAgent(agentId); console.log(`[${store}] destroyed browser ${agentId}`); return; } catch (e) {
        if (/not found|404/i.test(String((e as Error).message))) return;
        console.log(`[${store}] destroy failed (${(e as Error).message}), retrying`);
        await sleep(5000);
      }
    }
    console.log(`[${store}] COULD NOT DESTROY ${agentId}`);
  };
  const attach = async () => {
    for (let i = 0; i < 5; i++) {
      try {
        browser = await chromium.connectOverCDP(cdp, { headers: { "X-API-Key": key }, timeout: 30_000 });
        const bctx = browser.contexts()[0] ?? await browser.newContext();
        return bctx.pages()[0] ?? await bctx.newPage();
      } catch (e) {
        console.log(`[${store}] attach failed (${(e as Error).message.slice(0, 80)}), retrying`);
        await sleep(5000);
      }
    }
    await destroy();
    throw new Error("could not attach to the browser");
  };
  const ctx: StoreContext = {
    store, domain, page: await attach(), agentId, zip: process.env.OSA_ZIP, signal: new AbortController().signal,
    log: (m) => { logs.push(m); console.log(`[${store}] ${m}`); },
    async aiTask<T>(task: string, opts?: { schema?: object; maxSteps?: number; startUrl?: string }): Promise<T> {
      if (ai.calls >= ai.max) throw new Error("live test AI budget used up");
      ai.calls++;
      const text = opts?.schema ? `${task}\nReturn only JSON that matches this JSON schema: ${JSON.stringify(opts.schema)}` : task;
      // A burner cannot take agent_id ("sessions can only be opened on persistent agents"): the
      // task runs in its own browser, starting at the current page; its cart is separate.
      const job = await client.runTask({
        task: text, llm: "browsa", maxCredits: 10, maxSteps: opts?.maxSteps ?? 10,
        initialUrl: opts?.startUrl ?? ctx.page.url(), timeoutMs: 300_000,
      });
      ai.credits += job.creditsCharged ?? 0;
      console.log(`[${store}] AI task ${job.id}: ${job.status}, ${job.creditsCharged ?? "?"} credits`);
      const out = job.finalResult ?? "";
      try { return JSON.parse(stripFences(out)) as T; } catch { return out as unknown as T; }
    },
    async liveLink() {
      const l = await client.createLiveLink(agentId, { scope: "control", ttlSeconds: 600 });
      return l.live_url;
    },
    async newPage() {
      const bctx = browser!.contexts()[0] ?? await browser!.newContext();
      const old = ctx.page;
      ctx.page = await bctx.newPage();
      await old.close().catch(() => {});
      return ctx.page;
    },
  };
  /** Re-attach Playwright after the CDP socket dropped (the browser itself keeps running). */
  const reattach = async () => {
    await Promise.race([browser?.close().catch(() => undefined), sleep(3000)]);
    ctx.page = await attach();
    console.log(`[${store}] re-attached to ${agentId}`);
  };
  const close = async () => {
    await Promise.race([browser?.close().catch(() => undefined), sleep(4000)]);
    await destroy();
  };
  return { ctx, close, reattach, client, agentId, ai, logs };
}

/** Pick an option value other than the default, to prove options are chosen and verified. */
function otherOption(offer: Offer): Record<string, string> | undefined {
  const selected = (offer.raw?.selectedOptions ?? {}) as Record<string, string>;
  const choices = (offer.raw?.variantChoices ?? []) as { id: string; values: Record<string, string>; available?: boolean }[];
  for (const [dim, values] of Object.entries(offer.variants ?? {})) {
    if (values.length < 2) continue;
    const alt = values.find((v) => v !== selected[dim] && choices.some((c) => c.values[dim] === v && c.available !== false));
    if (alt) {
      // Keep the other dimensions as they are so a matching variant exists.
      const wanted: Record<string, string> = { ...selected, [dim]: alt };
      if (choices.some((c) => Object.entries(wanted).every(([k, v]) => c.values[k] === v))) return wanted;
      return { [dim]: alt };
    }
  }
  return undefined;
}

class InfraError extends Error {}

export async function runLive(adapter: StoreAdapter, store: StoreId, domain: string) {
  const stats: Record<Stage, StageStats> = {
    search: { pass: 0, fail: 0, notes: [] }, details: { pass: 0, fail: 0, notes: [] }, addToCart: { pass: 0, fail: 0, notes: [] },
    options: { pass: 0, fail: 0, notes: [] }, readCart: { pass: 0, fail: 0, notes: [] }, checkout: { pass: 0, fail: 0, notes: [] },
    clearCart: { pass: 0, fail: 0, notes: [] },
  };
  const started = Date.now();
  const live = await liveContext(store, domain);
  const { ctx } = live;
  const debugDir = process.env.OSA_LIVE_DEBUG;
  const records: unknown[] = [];
  const infra: string[] = [];
  const out = process.env.OSA_LIVE_OUT ?? path.join(os.tmpdir(), `osa-live-${store}-${Date.now()}.json`);
  const summarize = () => ({
    store, startedAt: new Date(started).toISOString(), minutes: Math.round((Date.now() - started) / 6000) / 10, agentId: live.agentId,
    aiCalls: live.ai.calls, aiCredits: live.ai.credits, infraErrors: infra,
    stages: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, `${v.pass}/${v.pass + v.fail}`])),
    stats, records,
  });
  // Destroy the browser even when the run is interrupted.
  const onSignal = () => { console.log(`[${store}] interrupted, destroying the browser`); live.close().finally(() => process.exit(130)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  /** One product, all stages. Results are kept in `pending` and only counted when no infra error hit. */
  async function product(i: number, p: LiveProduct, pending: [Stage, boolean, string][], rec: Record<string, unknown>) {
    const ok = (s: Stage, note = "") => { pending.push([s, true, note]); console.log(`[${store}] ok ${s}${note ? `: ${note}` : ""}`); };
    const bad = (s: Stage, note: string) => {
      pending.push([s, false, note]); console.log(`[${store}] FAIL ${s}: ${note}`);
      if (debugDir) {
        const base = path.join(debugDir, `${store}-${s}-${Date.now()}`);
        ctx.page.content().then((h) => fs.writeFileSync(`${base}.html`, h)).catch(() => undefined);
        ctx.page.screenshot({ path: `${base}.png` }).catch(() => undefined);
      }
    };
    const guard = (e: unknown) => { if (isInfraError(e)) throw new InfraError((e as Error).message); return (e as Error).message; };
    const item: ItemRequest = { id: `item-${i + 1}`, query: p.query, description: p.query, quantity: p.quantity ?? 1 };
    let offers: Offer[] = [];
    try {
      offers = await adapter.search(ctx, item, 20);
      const priced = offers.filter((o) => o.price.cents > 0 && o.productId);
      rec.search = {
        count: offers.length, sponsored: offers.filter((o) => o.sponsored).length, withRating: offers.filter((o) => o.rating).length,
        withDelivery: offers.filter((o) => o.deliveryText).length, withDate: offers.filter((o) => o.deliveryDate).length,
        sns: offers.filter((o) => o.subscribeAndSaveAvailable).length, top: offers.slice(0, 3).map((o) => ({ id: o.productId, cents: o.price.cents, sp: o.sponsored, t: o.title.slice(0, 40) })),
      };
      if (priced.length >= 3) ok("search", `${p.query}: ${JSON.stringify({ ...(rec.search as object), top: undefined })}`);
      else { bad("search", `${p.query}: only ${priced.length} priced offers`); return; }
    } catch (e) { bad("search", `${p.query}: ${guard(e)}`); return; }
    let offer = offers.find((o) => o.inStock && !o.sponsored && !o.subscribeAndSaveAvailable) ?? offers[0];
    try {
      const d = await adapter.details!(ctx, offer);
      rec.details = { id: d.productId, title: d.title.slice(0, 60), price: d.price.cents, searchPrice: offer.price.cents, seller: d.seller, delivery: d.deliveryText, date: d.deliveryDate, shipping: d.shipping?.cents, variants: d.variants };
      if (d.price.cents > 0 && d.title) ok("details", `${d.productId} $${d.price.cents / 100} seller=${d.seller ?? "?"} variants=${Object.keys(d.variants ?? {}).join("/") || "none"}`);
      else bad("details", `${offer.productId}: no price/title`);
      offer = d;
    } catch (e) { bad("details", `${offer.productId}: ${guard(e)}`); }
    const options = otherOption(offer);
    const qty = p.quantity ?? 1;
    let cart: Cart | undefined;
    try {
      cart = await adapter.addToCart(ctx, offer, qty, options);
      const line = cart.lines.find((l) => l.productId && (l.productId === offer.productId || (options && cart!.lines.length === 1)));
      rec.add = { options, qty, lines: cart.lines.map((l) => ({ id: l.productId, q: l.quantity, cents: l.price.cents, options: l.options })), warnings: cart.warnings };
      if (line && line.quantity === qty) ok("addToCart", `${line.productId} x${line.quantity} warnings=${JSON.stringify(cart.warnings)}`);
      else bad("addToCart", `${offer.productId} x${qty}: cart ${JSON.stringify(rec.add)}`);
      if (options) {
        const optWarn = cart.warnings.filter((w) => /option|did not stick|instead of/i.test(w));
        if (cart.lines.length && !optWarn.length) ok("options", `${JSON.stringify(options)} -> ${JSON.stringify(cart.lines.map((l) => l.options))}`);
        else bad("options", `${JSON.stringify(options)}: ${optWarn.join("; ") || "no line"}`);
      }
    } catch (e) { const m = guard(e); bad("addToCart", `${offer.productId}: ${m}`); if (options) bad("options", `${JSON.stringify(options)}: ${m}`); }
    try {
      const c2 = await adapter.readCart(ctx);
      if (c2.lines.length >= 1 && c2.subtotal && c2.subtotal.cents > 0) ok("readCart", `${c2.lines.length} lines, subtotal $${c2.subtotal.cents / 100}`);
      else bad("readCart", `lines=${c2.lines.length} subtotal=${JSON.stringify(c2.subtotal)}`);
    } catch (e) { bad("readCart", guard(e)); }
    try {
      const r = await adapter.reviewCheckout(ctx);
      rec.checkout = { needsUser: r.needsUser?.reason, total: r.total.cents, live: !!r.needsUser?.liveUrl, url: ctx.page.url().split("?")[0] };
      if (r.needsUser?.reason === "sign_in" && r.needsUser.liveUrl) ok("checkout", `sign_in with live link, total $${r.total.cents / 100}`);
      else bad("checkout", JSON.stringify(rec.checkout));
    } catch (e) { bad("checkout", guard(e)); }
    try {
      await adapter.clearCart!(ctx);
      const c3 = await adapter.readCart(ctx);
      if (c3.lines.length === 0) ok("clearCart"); else bad("clearCart", `${c3.lines.length} lines left`);
    } catch (e) { bad("clearCart", guard(e)); }
  }

  try {
    for (const [i, p] of PRODUCTS.entries()) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const pending: [Stage, boolean, string][] = [];
        const rec: Record<string, unknown> = { query: p.query, attempt };
        try {
          await product(i, p, pending, rec);
          records.push(rec);
          for (const [s, pass, note] of pending) { if (pass) stats[s].pass++; else stats[s].fail++; stats[s].notes.push(`${pass ? "ok" : "FAIL"}: ${note}`); }
          break;
        } catch (e) {
          if (!(e instanceof InfraError)) throw e;
          infra.push(`${p.query}: ${e.message.slice(0, 120)}`);
          console.log(`[${store}] connection problem (${e.message.slice(0, 80)}); re-attaching and redoing "${p.query}"`);
          await sleep(10_000);
          await live.reattach().catch((x: Error) => console.log(`[${store}] re-attach failed: ${x.message}`));
        }
      }
      fs.writeFileSync(out, JSON.stringify(summarize(), null, 2));
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await live.close();
  }
  const summary = summarize();
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`[${store}] summary ${JSON.stringify(summary.stages)} (written to ${out})`);
  return summary;
}
