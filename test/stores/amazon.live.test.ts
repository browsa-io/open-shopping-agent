// Opt-in live test: OSA_LIVE=1 BROWSA_API_KEY=... npm test -- test/stores/amazon.live.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import adapter from "../../src/stores/amazon.js";
import { LIVE, runLive } from "./amazon-live-harness.js";

test("amazon live: search, details, cart, checkout up to sign-in", { skip: !LIVE && "set OSA_LIVE=1 and BROWSA_API_KEY", timeout: 25 * 60_000 }, async () => {
  const s = await runLive(adapter, "amazon", "amazon.com");
  assert.ok(s.stats.search.pass >= 3, "search works on most products");
});
