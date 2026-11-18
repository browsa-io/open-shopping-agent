// Live check of Browsa's in-session press-and-hold solve through the real adapters: one fresh
// Phantom browser at a time on Browsa's residential US exit runs read-only searches until the
// store shows its HUMAN "Press & hold" check, then stops. Every browser is destroyed.
//
//   OSA_LIVE=1 BROWSA_API_KEY=agt_... npx tsx test/stores/presshold.live-harness.ts walmart [browsers] [searches]
//   OSA_LIVE=1 BROWSA_API_KEY=agt_... npx tsx test/stores/presshold.live-harness.ts target
//
// Not run by `npm test`. Never adds to a cart, signs in or checks out. No AI fallback (it throws).

import { LIVE, openLiveBrowser } from "./shopify.live-harness.js";
import walmart from "../../src/stores/walmart.js";
import target from "../../src/stores/target.js";

const QUERIES = ["usb c cable", "paper towels", "aa batteries", "dish soap", "phone charger", "socks"];

async function main(): Promise<void> {
  if (!LIVE) { console.log("skipped: set OSA_LIVE=1 and BROWSA_API_KEY"); return; }
  const store = (process.argv[2] ?? "walmart") as "walmart" | "target";
  const adapter = store === "target" ? target : walmart;
  const browsers = Number(process.argv[3] ?? (store === "target" ? 1 : 3));
  const searches = Number(process.argv[4] ?? 3);
  let q = 0;
  for (let b = 1; b <= browsers; b++) {
    const live = await openLiveBrowser({ proxy: "residential", country: "us", ttl: "15m" });
    const t0 = Date.now();
    let seen = false;
    try {
      const ctx = live.ctxFor(store, `${store}.com`);
      ctx.aiTask = async () => { throw new Error("AI fallback is off in this check"); };
      const log = ctx.log;
      ctx.log = (m: string) => { log(m); console.log(`  note: ${m}`); if (/showed|bot check|press/i.test(m)) seen = true; };
      for (let s = 0; s < searches && !seen; s++) {
        const query = QUERIES[q++ % QUERIES.length];
        const t = Date.now();
        try {
          const offers = await adapter.search(ctx, { id: `i${s}`, query, description: query, quantity: 1 }, 5);
          console.log(`  browser ${b} search "${query}": ${offers.length} offers in ${Math.round((Date.now() - t) / 1000)} s`);
        } catch (e) {
          console.log(`  browser ${b} search "${query}" failed in ${Math.round((Date.now() - t) / 1000)} s: ${(e as Error).message.slice(0, 240)}`);
          const handoff = (e as { handoff?: { reason: string; liveUrl?: string } }).handoff;
          if (handoff) console.log(`  hand-off: ${handoff.reason}, live link ${handoff.liveUrl ? "made" : "missing"}`);
        }
      }
    } finally {
      const r = await live.close();
      console.log(`browser ${b} destroyed after ${Math.round((Date.now() - t0) / 1000)} s (credits ${r.credits ?? "?"}, proxy bytes ${r.proxyBytes ?? "?"})`);
    }
    if (seen) break;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
