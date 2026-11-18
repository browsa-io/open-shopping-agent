// Live Target test (opt-in): OSA_LIVE=1 BROWSA_API_KEY=agt_... OSA_LIVE_PROXY=residential
// Target serves US visitors only, so the browser needs a US exit.
// Stages per product: search, product details, add to cart (Shipping), read cart; then clear the
// cart and stop at checkout's sign-in. Never signs in, never orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { target } from "../../src/stores/target.js";
import { LIVE, openLiveBrowser, Scoreboard } from "./shopify.live-harness.js";
import type { Offer } from "../../src/core/types.js";

const PRODUCTS: { query: string; options?: Record<string, string> }[] = [
  { query: "usb c hub" },
  { query: "paper towels" },
  { query: "crayola crayons 24 count" },
  { query: "hanes mens crew neck t-shirt", options: { Size: "L" } },
  { query: "mens crew socks", options: { Color: "Black" } },
];

test("Target live: search, details, cart, checkout stop", { skip: !LIVE, timeout: 20 * 60_000 }, async () => {
  const lb = await openLiveBrowser({ proxy: process.env.OSA_LIVE_PROXY ?? "residential", ttl: "25m" });
  const board = new Scoreboard();
  let cost: { credits?: number; proxyBytes?: number } = {};
  try {
    const ctx = lb.ctxFor("target", "target.com");
    let added = 0;
    for (const [i, p] of PRODUCTS.entries()) {
      const offers = await board.run("target", p.query, "search", () => target.search(ctx, { id: `item-${i}`, query: p.query, description: p.query, quantity: 1 }, 8),
        (o) => (o.length < 3 ? `only ${o.length} offers` : o.some((x) => !x.productId || !x.price.cents) ? "offer without TCIN or price" : undefined));
      const pick: Offer | undefined = offers?.find((o) => !o.sponsored && o.inStock) ?? offers?.[0];
      if (!pick) continue;
      console.log(`    picked ${pick.productId} ${pick.title.slice(0, 60)} ${pick.price.cents / 100} rating=${pick.rating?.stars ?? "-"}/${pick.rating?.count ?? "-"} ${pick.deliveryText ?? ""} sponsoredInResults=${offers!.filter((o) => o.sponsored).length}`);
      const det = await board.run("target", p.query, "product", () => target.details!(ctx, pick),
        (d) => (!d.price.cents ? "no price" : p.options && !d.variants ? "no variants" : undefined));
      const cart = await board.run("target", p.query, "cart", () => target.addToCart(ctx, det ?? pick, 1, p.options), (c) => {
        if (c.warnings.length) return c.warnings.join("; ");
        // With options the adapter may switch to another child TCIN; find the line by its options.
        const line = p.options
          ? c.lines.find((l) => Object.entries(p.options!).every(([k, v]) => l.options?.[k] === v))
          : c.lines.find((l) => l.productId === pick.productId);
        if (!line) return `line not in cart (${JSON.stringify(c.lines.map((l) => [l.productId, l.options]))})`;
        if (line.options?.fulfillment !== "Shipping") return `line is not set to shipping (${JSON.stringify(line.options)})`;
        return undefined;
      });
      if (cart) added++;
      await board.run("target", p.query, "readCart", () => target.readCart(ctx), (c) => (c.lines.reduce((n, l) => n + l.quantity, 0) < added ? `cart has ${c.lines.length} lines, expected ${added}` : undefined));
    }
    const review = await board.run("target", "cart", "checkout", () => target.reviewCheckout(ctx),
      (r) => (!r.total.cents ? "no total" : r.needsUser?.reason !== "sign_in" ? `expected sign-in, got ${r.needsUser?.reason ?? "none"}` : !r.needsUser.liveUrl ? "no live link" : undefined));
    if (review) console.log(`    review total ${review.total.cents / 100} shipping ${review.shipping ? review.shipping.cents / 100 : "?"} tax ${review.tax ? review.tax.cents / 100 : "?"} needsUser=${review.needsUser?.reason}`);
    await board.run("target", "cart", "clearCart", () => target.clearCart!(ctx).then(() => target.readCart(ctx)), (c) => (c.lines.length ? "cart not empty" : undefined));
  } finally {
    cost = await lb.close();
    console.log(board.summary());
    console.log(`browser credits=${cost.credits} proxyMB=${cost.proxyBytes ? Math.round(cost.proxyBytes / 1e6) : 0} aiTasks=${lb.stats.aiTasks} aiCredits=${lb.stats.aiCredits}`);
    if (process.env.OSA_LIVE_VERBOSE) console.log(lb.stats.logs.join("\n"));
    board.save({ store: "target", cost, ai: lb.stats });
  }
  assert.ok(board.results.some((r) => r.ok), "at least one stage passed");
});
