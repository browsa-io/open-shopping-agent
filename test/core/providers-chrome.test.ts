// The local and CDP providers on a real Chrome installed on this computer, against a local test
// page (no network). Skipped when no Chrome, Edge or Chromium is found.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CdpProvider, CapabilityMissing, LocalProvider, findChrome, runLocalAgent, type LoopAction } from "../../src/core/providers/index.js";
import type { JSONRequest } from "../../src/core/llm.js";

const CHROME = findChrome();
const skip = CHROME ? false : "no local Chrome, Edge or Chromium found";

const PAGE = `<!doctype html><html><head><title>Test shop</title></head><body>
<h1>USB-C cable 6 ft</h1><p id="price">$9.99</p>
<label>Quantity <select id="qty" aria-label="Quantity"><option>1</option><option>2</option><option>3</option></select></label>
<button id="add" onclick="document.getElementById('cart').textContent='Cart: ' + document.getElementById('qty').value + ' item(s)'">Add to cart</button>
<button onclick="document.body.dataset.ordered='yes'">Place order</button>
<p id="cart">Cart: empty</p>
</body></html>`;

async function serve(): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number };
  return { url: `http://127.0.0.1:${a.port}/`, server };
}

/** A scripted model: returns the next action each turn and records what it was shown. */
function scripted(actions: LoopAction[]) {
  const seen: string[] = [];
  return {
    seen,
    complete: async (_cfg: unknown, req: JSONRequest) => { seen.push(req.user); return actions.shift() ?? { action: "done", result: null }; },
  };
}

const llm = { provider: "anthropic" as const, model: "fake", apiKey: "sk-fake" };

test("local provider: launches your Chrome headless, opens the store page, keeps a profile per store", { skip, timeout: 120_000 }, async () => {
  const { url, server } = await serve();
  const dataDir = await mkdtemp(join(tmpdir(), "osa-local-"));
  const prov = new LocalProvider({ dataDir, headless: true });
  assert.equal(prov.capabilities.liveLink, "none");
  assert.equal(prov.capabilities.captchaSolving, false);
  try {
    const sb = await prov.open("walmart");
    const ctx = sb.context("walmart.com", { signal: new AbortController().signal });
    await ctx.page.goto(url);
    assert.equal(await ctx.page.title(), "Test shop");
    await assert.rejects(ctx.aiTask("read it"), (e: unknown) => e instanceof CapabilityMissing);
    const fresh = await ctx.newPage();
    assert.equal(fresh, ctx.page);
    // A second run on the same store shares the browser (new tab) instead of fighting over the profile.
    const again = await prov.open("walmart");
    await again.close();
    assert.equal(sb.page.isClosed(), false);
    await sb.close();
    assert.ok(existsSync(join(dataDir, "browsers", "walmart")));
  } finally {
    await prov.closeAll();
    server.close();
  }
});

test("local AI fallback loop: your model reads the snapshot, picks a quantity, adds to cart; never places the order", { skip, timeout: 120_000 }, async () => {
  const { url, server } = await serve();
  const dataDir = await mkdtemp(join(tmpdir(), "osa-loop-"));
  const model = scripted([
    { action: "select", role: "combobox", name: "Quantity", value: "2" },
    { action: "click", role: "button", name: "Place order" },
    { action: "click", role: "button", name: "Add to cart" },
    { action: "done", result: { added: true } },
  ]);
  const prov = new LocalProvider({ dataDir, headless: true, llm, complete: model.complete });
  assert.equal(prov.capabilities.aiFallback, true);
  try {
    const sb = await prov.open("shopify");
    const ctx = sb.context("shop.test", { signal: new AbortController().signal });
    const r = await ctx.aiTask<{ added: boolean }>("Add 2 of this cable to the cart", { startUrl: url, schema: { type: "object" } });
    assert.deepEqual(r, { added: true });
    assert.equal(await ctx.page.locator("#cart").textContent(), "Cart: 2 item(s)");
    assert.equal(await ctx.page.evaluate(() => document.body.dataset.ordered ?? "no"), "no");
    assert.match(model.seen[0], /button "Add to cart"/); // the ARIA snapshot reached the model
    assert.match(model.seen[2], /refused: the agent never places orders/);
    await sb.close();
  } finally {
    await prov.closeAll();
    server.close();
  }
});

test("local AI fallback loop stops at its step budget", { skip, timeout: 60_000 }, async () => {
  const { url, server } = await serve();
  const browser = await chromium.launch({ executablePath: CHROME!, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const model = scripted(Array.from({ length: 10 }, () => ({ action: "scroll", direction: "down" }) as LoopAction));
    await assert.rejects(runLocalAgent(page, "loop forever", { llm, complete: model.complete, maxSteps: 3 }), /did not finish in 3 steps/);
    assert.equal(model.seen.length, 3);
  } finally {
    await browser.close();
    server.close();
  }
});

test("local AI fallback loop stops at once when the model API fails (no more of your calls)", { skip, timeout: 60_000 }, async () => {
  // Seen live on 2026-11-18: an API that answered 429 got 7 more calls in 3 s, one per step.
  const { url, server } = await serve();
  const browser = await chromium.launch({ executablePath: CHROME!, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    let calls = 0;
    const complete = async () => { calls++; throw new Error("openai: HTTP 429: rate limited"); };
    await assert.rejects(runLocalAgent(page, "add to cart", { llm, complete, maxSteps: 8 }), /model API failed: openai: HTTP 429/);
    assert.equal(calls, 1);
    let bad = 0;
    const garbled = async () => { bad++; throw new Error("the model answer had no JSON object"); };
    await assert.rejects(runLocalAgent(page, "add to cart", { llm, complete: garbled, maxSteps: 3 }), /did not finish in 3 steps/);
    assert.equal(bad, 3, "a bad answer is still retried");
  } finally {
    await browser.close();
    server.close();
  }
});

test("cdp provider: connects to the same local Chrome's DevTools endpoint and drives a tab", { skip, timeout: 120_000 }, async () => {
  const { url, server } = await serve();
  const port = 9300 + Math.floor(Math.random() * 500);
  const browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: [`--remote-debugging-port=${port}`] });
  try {
    const prov = new CdpProvider({ url: `http://127.0.0.1:${port}`, env: {} });
    const sb = await prov.open("ebay");
    const ctx = sb.context("ebay.com", { signal: new AbortController().signal });
    await ctx.page.goto(url);
    assert.equal(await ctx.page.locator("h1").textContent(), "USB-C cable 6 ft");
    assert.match(await ctx.liveLink(), /provider's own viewer/);
    await sb.close();
    assert.equal(browser.isConnected(), true); // closing the store only disconnects
  } finally {
    await browser.close();
    server.close();
  }
});
