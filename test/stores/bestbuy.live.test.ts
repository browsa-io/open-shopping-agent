// Live Best Buy run (opt-in): OSA_LIVE=1 BROWSA_API_KEY=... OSA_LIVE_PROXY=residential npx tsx --test test/stores/bestbuy.live.test.ts
// Best Buy's bot wall refuses product pages from non-US datacenter exits, so use a US exit.
// Stops on the sign-in / guest page. Never places an order, never signs in.
import { test } from "node:test";
import assert from "node:assert/strict";
import adapter from "../../src/stores/bestbuy.js";
import { LIVE, runProducts } from "./ebay.live-harness.js";

const QUERIES = (process.env.OSA_LIVE_QUERIES ?? "wireless mouse|usb c hub|hdmi cable 6 ft|usb c charger|laptop sleeve 14 inch").split("|");

test("bestbuy live: search, details, add with option, cart, checkout stop", { skip: !LIVE, timeout: 30 * 60_000 }, async () => {
  const runs = await runProducts(adapter, QUERIES, { checkoutEvery: process.env.OSA_LIVE_CHECKOUT_EVERY !== "0" });
  assert.ok(runs.some((r) => r.stages.search?.ok), "at least one search worked");
});
