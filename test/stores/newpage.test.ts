// ctx.newPage(): adapters replace a crashed, closed or frozen tab instead of failing the store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import type { StoreContext } from "../../src/stores/adapter.js";
import type { StoreId } from "../../src/core/types.js";
import ebay from "../../src/stores/ebay.js";
import bestbuy from "../../src/stores/bestbuy.js";
import { target } from "../../src/stores/target.js";
import { evalWithRenew, isDeadPageError } from "../../src/stores/util.js";
import { BrowserPool, type BrowsaClient } from "../../src/core/browsers.js";

const fx = (store: string, name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${store}/${name}`, import.meta.url)), "utf8");

interface FakePage { page: Page; gotos: string[] }

/** A page that serves `html` for every URL, or crashes on goto/evaluate. */
function fakePage(o: { html?: string; url?: string; crash?: boolean; freeze?: boolean; evaluate?: (fn: unknown, arg: unknown) => unknown }): FakePage {
  const gotos: string[] = [];
  let url = o.url ?? "about:blank";
  let closed = false;
  const page = {
    url: () => url,
    isClosed: () => closed,
    close: async () => { closed = true; },
    goto: async (u: string) => {
      gotos.push(u);
      if (o.crash) throw new Error("page.goto: Target crashed");
      url = u;
      return { status: () => 200 };
    },
    content: async () => { if (o.crash) throw new Error("page.content: Target crashed"); return o.html ?? ""; },
    title: async () => "Page",
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    evaluate: (fn: unknown, arg: unknown) => {
      if (o.freeze) return new Promise(() => {});
      if (o.crash) return Promise.reject(new Error("page.evaluate: Target crashed"));
      return Promise.resolve(o.evaluate ? o.evaluate(fn, arg) : 1);
    },
    locator: () => ({ first: () => ({ isVisible: async () => false, count: async () => 0 }), count: async () => 0 }),
    mouse: { wheel: async () => {} },
  } as unknown as Page;
  return { page, gotos };
}

function ctxFor(store: StoreId, domain: string, first: FakePage, next: FakePage): StoreContext & { logs: string[]; renewed: number } {
  const ctx = {
    store, domain, page: first.page, agentId: "agt_t", signal: new AbortController().signal, logs: [] as string[], renewed: 0,
    log(m: string) { ctx.logs.push(m); },
    aiTask: async () => { throw new Error("no AI in unit tests"); },
    liveLink: async () => "https://browsa.io/live#x",
    async newPage() { ctx.renewed++; await ctx.page.close(); ctx.page = next.page; return next.page; },
  };
  return ctx as unknown as StoreContext & { logs: string[]; renewed: number };
}

test("isDeadPageError tells a dead tab from a page error", () => {
  assert.ok(isDeadPageError(new Error("page.goto: Target crashed")));
  assert.ok(isDeadPageError(new Error("page.content: Target page, context or browser has been closed")));
  assert.ok(isDeadPageError(new Error("the target.com page stopped answering (no reply in 30 s)")));
  assert.ok(!isDeadPageError(new Error("net::ERR_HTTP2_PROTOCOL_ERROR")));
  assert.ok(!isDeadPageError(new Error("Execution context was destroyed, most likely because of a navigation")));
});

test("eBay: a crashed tab is replaced and the cart is read on the fresh one", async () => {
  const dead = fakePage({ crash: true, url: "https://www.ebay.com/" });
  const fresh = fakePage({ html: fx("ebay", "cart.html") });
  const ctx = ctxFor("ebay", "ebay.com", dead, fresh);
  const cart = await ebay.readCart(ctx);
  assert.equal(ctx.renewed, 1);
  assert.ok(cart.lines.length > 0);
  assert.deepEqual(fresh.gotos, ["https://cart.ebay.com/"]);
  assert.ok(ctx.logs.some((l) => /opening a fresh tab/.test(l)));
});

test("eBay: a tab closed earlier is replaced before loading", async () => {
  const closed = fakePage({ html: "" });
  await closed.page.close();
  const fresh = fakePage({ html: fx("ebay", "cart.html") });
  const ctx = ctxFor("ebay", "ebay.com", closed, fresh);
  await ebay.readCart(ctx);
  assert.equal(ctx.renewed, 1);
  assert.equal(closed.gotos.length, 0);
});

test("Best Buy: a crashed tab is replaced once; a second crash fails the step", async () => {
  const fresh = fakePage({ html: fx("bestbuy", "cart.html") });
  const ctx = ctxFor("bestbuy", "bestbuy.com", fakePage({ crash: true }), fresh);
  const cart = await bestbuy.readCart(ctx);
  assert.equal(ctx.renewed, 1);
  assert.ok(cart.lines.length > 0);
  const ctx2 = ctxFor("bestbuy", "bestbuy.com", fakePage({ crash: true }), fakePage({ crash: true }));
  await assert.rejects(bestbuy.readCart(ctx2), /Target crashed/);
  assert.equal(ctx2.renewed, 1);
});

test("Target: a crashed tab is replaced, goes back to target.com and the cart API answers", async () => {
  const cartJson = fx("target", "cart.json");
  const dead = fakePage({ crash: true, url: "https://www.target.com/cart" });
  const fresh = fakePage({
    evaluate: (_fn, arg) => (Array.isArray(arg) ? { status: 200, body: cartJson } : "Target home"),
  });
  const ctx = ctxFor("target", "target.com", dead, fresh);
  const cart = await target.readCart(ctx);
  assert.equal(ctx.renewed, 1);
  assert.equal(fresh.gotos[0], "https://www.target.com/cart");
  assert.ok(cart.lines.length > 0);
});

test("evalWithRenew: a frozen tab gets one fresh tab, then the error stands", async () => {
  const ok = fakePage({ evaluate: () => 42, url: "https://shop.example/" });
  const ctx = ctxFor("shopify", "shop.example", fakePage({ freeze: true, url: "https://shop.example/p" }), ok);
  const reopened: string[] = [];
  assert.equal(await evalWithRenew(ctx, () => 1, undefined, { ms: 30, reopen: async (u) => { reopened.push(u); } }), 42);
  assert.deepEqual(reopened, ["https://shop.example/p"]);
  const ctx2 = ctxFor("shopify", "shop.example", fakePage({ freeze: true }), fakePage({ freeze: true }));
  await assert.rejects(evalWithRenew(ctx2, () => 1, undefined, { ms: 30, reopen: async () => {} }), /stopped answering/);
  // A page error (not a dead tab) is not retried.
  const ctx3 = ctxFor("shopify", "shop.example", fakePage({ evaluate: () => { throw new Error("boom"); } }), ok);
  await assert.rejects(evalWithRenew(ctx3, () => 1, undefined, { ms: 30, reopen: async () => {} }), /boom/);
  assert.equal(ctx3.renewed, 0);
});

test("engine browser: ctx.newPage opens a page in the same context, closes the old one and swaps ctx.page", async () => {
  const pages: { url: () => string; isClosed: () => boolean; close: () => Promise<void>; id: number }[] = [];
  const mk = () => { let c = false; const p = { id: pages.length, url: () => "about:blank", isClosed: () => c, close: async () => { c = true; } }; pages.push(p); return p; };
  mk();
  const bctx = { pages: () => pages.filter((p) => !p.isClosed()), newPage: async () => mk() };
  const browser = { contexts: () => [bctx], close: async () => {}, isConnected: () => true } as unknown as Browser;
  const client = {
    createAgent: async () => ({ id: "agt_1", cdp_http: "https://browsa.io/cdp/1" }),
    destroyAgent: async () => {}, createLiveLink: async () => ({ live_url: "x" }), credits: async () => ({}),
  } as unknown as BrowsaClient;
  const pool = new BrowserPool({ apiKey: "agt_test", client, connect: async () => browser, mode: "burner", dataDir: await mkdtemp(join(tmpdir(), "osa-np-")) });
  const b = await pool.openStore("ebay");
  const ctx = b.context("ebay.com", { signal: new AbortController().signal });
  const other = b.context("ebay.com", { signal: new AbortController().signal });
  const first = ctx.page as unknown as { id: number; isClosed: () => boolean };
  const p = await ctx.newPage();
  assert.equal((p as unknown as { id: number }).id, 1);
  assert.equal(first.isClosed(), true);
  assert.equal(ctx.page, p);
  assert.equal(other.page, p, "every context of the store's browser sees the new tab");
  assert.equal(b.page, p);
  await b.close();
  await assert.rejects(ctx.newPage(), /closed/);
});
