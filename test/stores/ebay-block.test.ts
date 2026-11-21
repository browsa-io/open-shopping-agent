// 0.2.1: eBay refusing the search page (its error page, HTTP 403) is a block. The adapter used to
// swallow it and return no offers, which the CLI printed as "Nothing found". Runs on a fake page.

import assert from "node:assert/strict";
import { test } from "node:test";
import adapter, { isRefusal } from "../../src/stores/ebay.js";
import type { StoreContext } from "../../src/stores/adapter.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoppingAgent } from "../../src/core/engine.js";
import type { RunEvent } from "../../src/core/types.js";
import { FakeAdapter, fakeBrowsers } from "../core/fake-adapter.js";
import { friendlyError } from "../../web/lib/wording.js";

const ERROR_PAGE = "<html><head><title>Error Page | eBay</title></head><body><p>SORRY Something went wrong on our end</p></body></html>";
const EMPTY_RESULTS = "<html><head><title>usb c cable for sale | eBay</title></head><body><ul class=\"srp-results\"></ul></body></html>";

function fakeCtx(html: string, title: string, status: number): StoreContext & { logs: string[]; aiCalls: number } {
  const logs: string[] = [];
  const page: any = {
    url: () => "about:blank",
    isClosed: () => false,
    goto: async () => ({ status: () => status }),
    content: async () => html,
    title: async () => title,
    waitForTimeout: async () => {},
    waitForNavigation: async () => null,
    evaluate: async () => undefined,
    context: () => ({ cookies: async () => [], addCookies: async () => {} }),
    locator: () => ({ first: () => ({ isVisible: async () => false, count: async () => 0 }), count: async () => 0 }),
  };
  const ctx: any = {
    store: "ebay", domain: "ebay.com", page, agentId: "agt_test", logs, aiCalls: 0,
    aiTask: async () => { ctx.aiCalls++; throw new Error("no AI in unit tests"); },
    liveLink: async () => "x",
    newPage: async () => page,
    log: (m: string) => logs.push(m),
    signal: new AbortController().signal,
  };
  return ctx;
}

const item = { id: "item-1", query: "usb c cable", description: "usb c cable", quantity: 1 };

test("isRefusal: what counts as eBay refusing the browser", () => {
  assert.equal(isRefusal(new Error("eBay refused the page twice (Error Page | eBay, status 403) at https://www.ebay.com/sch/i.html")), true);
  assert.equal(isRefusal(new Error("page.goto: Timeout 45000ms exceeded")), false);
});

test("ebay search: a refused page (403) throws the block instead of returning no offers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const ctx = fakeCtx(ERROR_PAGE, "Error Page | eBay", 403);
  (ctx.page as any).waitForTimeout = async (ms: number) => { t.mock.timers.tick(Math.max(1, ms || 0)); };
  await assert.rejects(adapter.search(ctx, item, 8), /eBay refused the page twice \(Error Page \| eBay, status 403\)/);
  assert.equal(ctx.aiCalls, 1, "the AI fallback still gets its one try first");
});

test("ebay search: a results page with no listings is still \"nothing found\" (no error)", async () => {
  const ctx = fakeCtx(EMPTY_RESULTS, "usb c cable for sale | eBay", 200);
  assert.deepEqual(await adapter.search(ctx, item, 8), []);
});

test("engine: the refused search is a store failure at search (a block), not an empty result", async () => {
  class Refusing extends FakeAdapter {
    override async search(): Promise<never> {
      throw new Error("eBay refused the page twice (Error Page | eBay, status 403) at https://www.ebay.com/sch/i.html?_nkw=usb");
    }
  }
  const events: RunEvent[] = [];
  const dataDir = await mkdtemp(join(tmpdir(), "osa-ebay-block-"));
  const agent = new ShoppingAgent({ llm: false, dataDir, adapters: { ebay: new Refusing("ebay", { catalog: {} }) }, openBrowser: fakeBrowsers().open, watchLinks: false });
  const run = await agent.run("a usb-c cable on ebay", { onEvent: (e) => events.push(e), until: "picks" });
  const failed = events.find((e): e is Extract<RunEvent, { type: "store_failed" }> => e.type === "store_failed");
  assert.ok(failed, `a store_failed event (got ${events.map((e) => e.type).join(", ")})`);
  assert.equal(failed.stage, "search");
  assert.equal(friendlyError(failed.error, failed.stage, failed.store).title, "Blocked at search (403)");
  assert.equal(run.summary().failures.length, 1);
  assert.equal(events.filter((e) => e.type === "offers").length, 0);
});
