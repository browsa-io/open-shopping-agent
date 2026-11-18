// Live eBay run (opt-in): OSA_LIVE=1 BROWSA_API_KEY=... npx tsx --test test/stores/ebay.live.test.ts
// Stops at guest checkout's address step. Never places an order, never signs in.
import { test } from "node:test";
import assert from "node:assert/strict";
import adapter from "../../src/stores/ebay.js";
import { LIVE, runProducts } from "./ebay.live-harness.js";

const QUERIES = (process.env.OSA_LIVE_QUERIES ?? "hdmi cable 6 ft|usb c hub|wireless mouse|usb c charger 20w|phone case iphone 15").split("|");

test("ebay live: search, details, add with option, cart, checkout stop", { skip: !LIVE, timeout: 30 * 60_000 }, async () => {
  const runs = await runProducts(adapter, QUERIES, { checkoutEvery: process.env.OSA_LIVE_CHECKOUT_EVERY !== "0" });
  assert.ok(runs.some((r) => r.stages.search?.ok), "at least one search worked");
});
