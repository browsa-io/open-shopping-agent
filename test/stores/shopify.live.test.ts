// Live Shopify test (opt-in): OSA_LIVE=1 BROWSA_API_KEY=agt_...
// Real Shopify stores, two products each: search, product, add to cart (with options), read cart,
// checkout summary (stops at contact/address), clear cart. Plus non-Shopify domains that must fail
// with a clear error. Never types contact, address or card details; never orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shopify } from "../../src/stores/shopify.js";
import { LIVE, openLiveBrowser, Scoreboard } from "./shopify.live-harness.js";
import type { Offer } from "../../src/core/types.js";

const STORES: { domain: string; products: { query: string; options?: Record<string, string> }[] }[] = [
  { domain: "allbirds.com", products: [{ query: "wool runner", options: { Size: "10" } }, { query: "socks" }] },
  { domain: "deathwishcoffee.com", products: [{ query: "medium roast", options: { Type: "Whole Bean" } }, { query: "mug" }] },
  { domain: "brooklinen.com", products: [{ query: "pillowcase" }, { query: "bath towel" }] },
  { domain: "kith.com", products: [{ query: "hoodie", options: { Size: "M" } }, { query: "cap" }] },
  { domain: "tentree.com", products: [{ query: "t-shirt", options: { Size: "M" } }, { query: "beanie" }] },
];
const NOT_SHOPIFY = ["gymshark.com", "ruggable.com", "target.com"];

test("Shopify live: several real stores", { skip: !LIVE, timeout: 25 * 60_000 }, async () => {
  const lb = await openLiveBrowser({ proxy: process.env.OSA_LIVE_SHOPIFY_PROXY, ttl: "30m" });
  const board = new Scoreboard();
  let cost: { credits?: number; proxyBytes?: number } = {};
  try {
    for (const s of STORES) {
      const ctx = lb.ctxFor("shopify", s.domain);
      let added = 0;
      for (const [i, p] of s.products.entries()) {
        const offers = await board.run(s.domain, p.query, "search", () => shopify.search(ctx, { id: `item-${i}`, query: p.query, description: p.query, quantity: 1 }, 6),
          (o) => (o.length < 1 ? "no offers" : o.some((x) => !x.price.cents || !x.raw?.handle) ? "offer without price or handle" : undefined));
        const pick: Offer | undefined = offers?.find((o) => o.inStock) ?? offers?.[0];
        if (!pick) continue;
        const det = await board.run(s.domain, p.query, "product", () => shopify.details!(ctx, pick), (d) => (!d.productId ? "no variant id" : undefined));
        if (det) console.log(`    ${det.title.slice(0, 50)} ${det.price.cents / 100} ${det.price.currency} variants=${JSON.stringify(det.variants ?? {}).slice(0, 80)} rating=${det.rating?.stars ?? "-"}/${det.rating?.count ?? "-"} sub=${det.raw?.hasSellingPlans}`);
        const cart = await board.run(s.domain, p.query, "cart", () => shopify.addToCart(ctx, det ?? pick, 1, p.options), (c) => {
          if (!c.lines.length) return "cart empty";
          if (c.warnings.length) return c.warnings.join("; ");
          if (p.options) {
            const ok = c.lines.some((l) => Object.entries(p.options!).every(([k, v]) => Object.entries(l.options ?? {}).some(([lk, lv]) => lk.toLowerCase() === k.toLowerCase() && lv.toLowerCase() === v.toLowerCase())));
            if (!ok) return `options ${JSON.stringify(p.options)} not on any line: ${JSON.stringify(c.lines.map((l) => l.options))}`;
          }
          return undefined;
        });
        if (cart) added++;
        await board.run(s.domain, p.query, "readCart", () => shopify.readCart(ctx), (c) => (c.lines.length < added ? `cart has ${c.lines.length} lines, expected ${added}` : c.subtotal?.currency !== "USD" ? `currency ${c.subtotal?.currency}` : undefined));
      }
      const review = await board.run(s.domain, "cart", "checkout", () => shopify.reviewCheckout(ctx),
        (r) => (!r.total.cents ? "no total" : !r.needsUser ? "expected needsUser" : !r.needsUser.liveUrl ? "no live link" : undefined));
      if (review) console.log(`    review subtotal ${review.subtotal ? review.subtotal.cents / 100 : "?"} total ${review.total.cents / 100} ${review.total.currency} needsUser=${review.needsUser?.reason}`);
      await board.run(s.domain, "cart", "clearCart", () => shopify.clearCart!(ctx).then(() => shopify.readCart(ctx)), (c) => (c.lines.length ? "cart not empty" : undefined));
    }
    for (const d of NOT_SHOPIFY) {
      const ctx = lb.ctxFor("shopify", d);
      await board.run(d, "detect", "search", async () => {
        try { await shopify.search(ctx, { id: "x", query: "shirt", description: "", quantity: 1 }, 3); return "no error"; } catch (e) { return (e as Error).message; }
      }, (msg) => (/not a Shopify online store/.test(msg) ? undefined : `unexpected: ${msg}`));
    }
  } finally {
    cost = await lb.close();
    console.log(board.summary());
    console.log(`browser credits=${cost.credits} proxyMB=${cost.proxyBytes ? Math.round(cost.proxyBytes / 1e6) : 0} aiTasks=${lb.stats.aiTasks} aiCredits=${lb.stats.aiCredits}`);
    if (process.env.OSA_LIVE_VERBOSE) console.log(lb.stats.logs.join("\n"));
    board.save({ store: "shopify", cost, ai: lb.stats });
  }
  assert.ok(board.results.some((r) => r.ok), "at least one stage passed");
});
