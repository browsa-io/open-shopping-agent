// Shared adapter helpers in src/stores/util.ts (moved from amazon.ts, ebay.ts and target.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { StoreContext } from "../../src/stores/adapter.js";
import {
  aiSearchFallback, decodeEntities, decodeEntitiesAscii, elementsWith, gotoRetry, jsonAfter, jsonAfterMarker, moneyFromNumber, moneyFromNumeric,
  parseHtml, pressAndHold, qs, textOf, textOfHtml,
} from "../../src/stores/util.js";
import * as amazon from "../../src/stores/amazon.js";
import * as ebay from "../../src/stores/ebay.js";

function ctxWith(page: Partial<Page>, aiResult?: unknown): StoreContext & { logs: string[]; tasks: { task: string; opts: unknown }[] } {
  const logs: string[] = [];
  const tasks: { task: string; opts: unknown }[] = [];
  return {
    store: "amazon", domain: "amazon.com", page: page as Page, agentId: "agt_x", signal: new AbortController().signal,
    log: (m: string) => logs.push(m), logs, tasks,
    aiTask: (async (task: string, opts: unknown) => { tasks.push({ task, opts }); return aiResult; }) as StoreContext["aiTask"],
    liveLink: async () => "https://browsa.io/live#x",
    newPage: async () => page as Page,
  } as StoreContext & { logs: string[]; tasks: { task: string; opts: unknown }[] };
}

test("util: both HTML helper families keep their own behaviour", () => {
  assert.equal(decodeEntities("a &mdash; b&hellip;"), "a — b…");
  assert.equal(decodeEntitiesAscii("a &mdash; b&hellip;"), "a - b...");
  assert.equal(textOf(qs(parseHtml("<p>Hi &amp; <b>you</b></p>"), "p")), "Hi & you");
  assert.equal(textOfHtml("<p>Hi &amp; <b>you</b></p>"), "Hi & you");
  assert.deepEqual(jsonAfter(`x "k" : {"a":1}`, `"k"`), { a: 1 });
  assert.deepEqual(jsonAfterMarker(`var c = {"b":[1]};`, "var c = "), { b: [1] });
  assert.equal(elementsWith(`<div data-x="1"><span>a</span></div>`, `data-x="1"`)[0], `<div data-x="1"><span>a</span></div>`);
  assert.deepEqual(moneyFromNumber("$1,299.99"), { cents: 129999, currency: "USD" });
  assert.equal(moneyFromNumeric("$12"), undefined);
  assert.deepEqual(moneyFromNumeric("12.5"), { cents: 1250, currency: "USD" });
});

test("util: adapters no longer export the moved helpers", () => {
  for (const n of ["parseHtml", "pickVariant", "passBotCheck", "approvalMatches", "aiSearchFallback", "shortAddress"]) assert.equal((amazon as Record<string, unknown>)[n], undefined, `amazon.${n}`);
  for (const n of ["textLines", "elementsWith", "jsonLd", "sameOption", "decodeEntities"]) assert.equal((ebay as Record<string, unknown>)[n], undefined, `ebay.${n}`);
});

test("util: aiSearchFallback maps the task's results to offers", async () => {
  const ctx = ctxWith({}, { results: [
    { title: "Hub A", url: "https://www.walmart.com/ip/hub-a/123456789", price: "$19.99", stars: 4.5, reviews: 10, delivery: "Arrives tomorrow" },
    { title: "No price", url: "https://x", price: "n/a" },
  ] });
  const offers = await aiSearchFallback(ctx, {
    store: "walmart", domain: "walmart.com", url: "https://www.walmart.com/search?q=hub", limit: 5,
    item: { id: "item-1", query: "hub", description: "hub", quantity: 1 }, idHint: "the number after /ip/",
    productId: (u) => u?.match(/\/ip\/(?:[^/]+\/)?(\d+)/)?.[1], productUrl: (id) => `https://www.walmart.com/ip/${id}`,
  });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].productId, "123456789");
  assert.equal(offers[0].url, "https://www.walmart.com/ip/123456789");
  assert.deepEqual(offers[0].price, { cents: 1999, currency: "USD" });
  assert.equal(offers[0].raw?.via, "ai");
  assert.match(ctx.tasks[0].task, /the number after \/ip\//);
});

test("util: gotoRetry retries a failed proxy tunnel and one timeout, not other errors", async () => {
  const mk = (errors: string[]) => {
    const tries: string[] = [];
    const page = {
      goto: async (u: string) => { tries.push(u); const e = errors.shift(); if (e) throw new Error(e); return null; },
      waitForTimeout: async () => {},
    } as unknown as Page;
    return { ctx: ctxWith(page), tries };
  };
  const a = mk(["page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://x", "page.goto: net::ERR_TUNNEL_CONNECTION_FAILED"]);
  await gotoRetry(a.ctx, "https://x");
  assert.equal(a.tries.length, 3);
  assert.ok(a.ctx.logs.some((l) => /ERR_TUNNEL_CONNECTION_FAILED; trying again/.test(l)));
  const b = mk(["page.goto: Timeout 45000ms exceeded.", "page.goto: Timeout 45000ms exceeded."]);
  await assert.rejects(gotoRetry(b.ctx, "https://x"), /Timeout/);
  assert.equal(b.tries.length, 2, "one retry after a timeout");
  const c = mk(["page.goto: net::ERR_NAME_NOT_RESOLVED"]);
  await assert.rejects(gotoRetry(c.ctx, "https://x"), /NAME_NOT_RESOLVED/);
  assert.equal(c.tries.length, 1);
});

test("util: pressAndHold does nothing without the check on the page", async () => {
  const page = { locator: () => ({ first: () => ({}), count: async () => 0 }) } as unknown as Page;
  assert.equal(await pressAndHold(ctxWith(page), { name: "Target" }), false);
});
