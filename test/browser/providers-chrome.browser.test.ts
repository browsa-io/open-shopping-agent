// The browser suite (npm run test:browser): the local and CDP providers on a real Chrome installed
// on this computer, against a local test page (no network, no store). Not part of `npm test`.
// Skipped when no Chrome, Edge or Chromium is found; with OSA_REQUIRE_CHROME=1 (CI) that is a failure.
//
// Nothing here can hang: every launch has its own timeout, every test has a timeout, and cleanup
// closes the browser with a deadline and then kills its process.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CdpProvider, CapabilityMissing, LocalProvider, findChrome, runLocalAgent, type LoopAction } from "../../src/core/providers/index.js";
import type { JSONRequest } from "../../src/core/llm.js";

import type { Browser } from "playwright-core";

const CHROME = findChrome();
const skip = CHROME ? false : "no local Chrome, Edge or Chromium found";

if (!CHROME && process.env.OSA_REQUIRE_CHROME === "1") {
  test("a Chrome, Edge or Chromium is installed (OSA_REQUIRE_CHROME=1)", () => {
    assert.fail("OSA_REQUIRE_CHROME=1 but no Chrome, Edge or Chromium was found; set OSA_CHROME_PATH");
  });
}

const LAUNCH_MS = 30_000;
const TEST_MS = 90_000;
const launched = new Set<Browser>();
const cleanups = new Set<() => Promise<unknown>>();

/** Resolve with the promise, or give up after `ms` (never rejects, never hangs). */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>((r) => { t = setTimeout(r, ms, undefined); }),
  ]).finally(() => clearTimeout(t));
}

/** Launch headless Chrome with a launch timeout; it is closed (then killed) by shut(). */
async function launch(args: string[] = []): Promise<Browser> {
  const b = await chromium.launch({ executablePath: CHROME!, headless: true, args, timeout: LAUNCH_MS });
  launched.add(b);
  return b;
}

/** Close a launched browser within 5 s. */
async function shut(b: Browser | undefined): Promise<void> {
  if (!b) return;
  launched.delete(b);
  await within(b.close(), 5000);
}

// Whatever a failed or timed-out test left behind is closed here, so the run always ends.
after(async () => {
  await Promise.all([...cleanups].map((c) => within(c(), 5000)));
  await Promise.all([...launched].map((b) => shut(b)));
});

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

test("local provider: launches your Chrome headless, opens the store page, keeps a profile per store", { skip, timeout: TEST_MS }, async () => {
  const { url, server } = await serve();
  const dataDir = await mkdtemp(join(tmpdir(), "osa-local-"));
  const prov = new LocalProvider({ dataDir, headless: true });
  cleanups.add(() => prov.closeAll());
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
    await within(prov.closeAll(), 10_000);
    server.close();
  }
});

test("local AI fallback loop: your model reads the snapshot, picks a quantity, adds to cart; never places the order", { skip, timeout: TEST_MS }, async () => {
  const { url, server } = await serve();
  const dataDir = await mkdtemp(join(tmpdir(), "osa-loop-"));
  const model = scripted([
    { action: "select", role: "combobox", name: "Quantity", value: "2" },
    { action: "click", role: "button", name: "Place order" },
    { action: "click", role: "button", name: "Add to cart" },
    { action: "done", result: { added: true } },
  ]);
  const prov = new LocalProvider({ dataDir, headless: true, llm, complete: model.complete });
  cleanups.add(() => prov.closeAll());
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
    await within(prov.closeAll(), 10_000);
    server.close();
  }
});

test("local AI fallback loop stops at its step budget", { skip, timeout: TEST_MS }, async () => {
  const { url, server } = await serve();
  let browser: Browser | undefined;
  // The loop itself is stopped after 30 s, well inside the test's own timeout.
  const stop = AbortSignal.timeout(30_000);
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.goto(url, { timeout: 15_000 });
    const model = scripted(Array.from({ length: 10 }, () => ({ action: "scroll", direction: "down" }) as LoopAction));
    await assert.rejects(runLocalAgent(page, "loop forever", { llm, complete: model.complete, maxSteps: 3, signal: stop }), /did not finish in 3 steps/);
    assert.equal(model.seen.length, 3);
  } finally {
    await shut(browser);
    server.close();
  }
});

test("local AI fallback loop stops at once when the model API fails (no more of your calls)", { skip, timeout: TEST_MS }, async () => {
  // Seen live on 2026-11-18: an API that answered 429 got 7 more calls in 3 s, one per step.
  const { url, server } = await serve();
  let browser: Browser | undefined;
  try {
    browser = await launch();
    const page = await browser.newPage();
    await page.goto(url, { timeout: 15_000 });
    let calls = 0;
    const complete = async () => { calls++; throw new Error("openai: HTTP 429: rate limited"); };
    await assert.rejects(runLocalAgent(page, "add to cart", { llm, complete, maxSteps: 8 }), /model API failed: openai: HTTP 429/);
    assert.equal(calls, 1);
    let bad = 0;
    const garbled = async () => { bad++; throw new Error("the model answer had no JSON object"); };
    await assert.rejects(runLocalAgent(page, "add to cart", { llm, complete: garbled, maxSteps: 3 }), /did not finish in 3 steps/);
    assert.equal(bad, 3, "a bad answer is still retried");
  } finally {
    await shut(browser);
    server.close();
  }
});

test("cdp provider: connects to the same local Chrome's DevTools endpoint and drives a tab", { skip, timeout: TEST_MS }, async () => {
  const { url, server } = await serve();
  const port = 9300 + Math.floor(Math.random() * 500);
  let browser: Browser | undefined;
  try {
    browser = await launch([`--remote-debugging-port=${port}`]);
    const prov = new CdpProvider({ url: `http://127.0.0.1:${port}`, env: {} });
    const sb = await prov.open("ebay");
    const ctx = sb.context("ebay.com", { signal: new AbortController().signal });
    await ctx.page.goto(url);
    assert.equal(await ctx.page.locator("h1").textContent(), "USB-C cable 6 ft");
    assert.match(await ctx.liveLink(), /provider's own viewer/);
    await sb.close();
    assert.equal(browser.isConnected(), true); // closing the store only disconnects
  } finally {
    await shut(browser);
    server.close();
  }
});
