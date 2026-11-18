// Browser providers and bring-your-own keys, offline: provider selection, proxy parsing, rotation and
// precedence, key masking, AI fallback routing, and how the engine degrades on a browser without
// Browsa's capabilities. The real local Chrome and CDP checks are in providers-chrome.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { ShoppingAgent } from "../../src/core/engine.js";
import type { ItemRequest, Offer, RunEvent, StoreId } from "../../src/core/types.js";
import type { StoreContext } from "../../src/stores/adapter.js";
import { BotCheckError, needsUser, passBotCheck } from "../../src/stores/util.js";
import {
  BrowsaProvider, CapabilityMissing, NON_BROWSA_EXIT_WARNING, ProxyPlan, browsaTaskLlm, buildProviderBrowser, chooseProvider,
  isBotBlock, localCapabilities, maskProxyText, parseCdpHeaders, parsePoolText, parseProviderId, parseProxy, proxyLabel,
  proxySettingsFrom, scrub, testProxy, toBrowsaProxy, toPlaywrightProxy, CdpProvider, findChrome,
  type BrowserProvider, type ProviderBrowser,
} from "../../src/core/providers/index.js";
import { BrowserPool } from "../../src/core/browsers.js";
import { FakeAdapter, offer } from "./fake-adapter.js";
import { byokPublic, sanitizeByok } from "../../src/web/config.js";
import { testModelKey, testProxyFromSettings } from "../../src/web/byok-api.js";

// ---------------------------------------------------------------------------------------------
// selection

test("provider selection: flag > OSA_BROWSER > settings > browsa with a key > cdp with a URL > local", () => {
  assert.equal(chooseProvider({ hasBrowsaKey: true, env: {} }).id, "browsa");
  assert.equal(chooseProvider({ hasBrowsaKey: false, env: {} }).id, "local");
  assert.equal(chooseProvider({ hasBrowsaKey: false, env: { OSA_CDP_URL: "ws://x:9222" } }).id, "cdp");
  assert.equal(chooseProvider({ hasBrowsaKey: true, env: {}, setting: "local" }).id, "local");
  assert.equal(chooseProvider({ hasBrowsaKey: true, env: { OSA_BROWSER: "cdp" }, setting: "local" }).id, "cdp");
  assert.deepEqual(chooseProvider({ hasBrowsaKey: false, env: { OSA_BROWSER: "cdp" }, flag: "browsa" }), { id: "browsa", why: "flag" });
  assert.equal(chooseProvider({ hasBrowsaKey: true, env: {}, setting: "auto" }).id, "browsa");
  assert.equal(parseProviderId("Chrome"), "local");
  assert.equal(parseProviderId("auto"), undefined);
  assert.throws(() => parseProviderId("firefox", "--browser"), /--browser must be one of browsa, local, cdp/);
});

test("local provider finds a browser: OSA_CHROME_PATH first, else a known install path", () => {
  assert.equal(findChrome({ OSA_CHROME_PATH: "/opt/my/chrome" }, () => false), "/opt/my/chrome");
  assert.equal(findChrome({}, () => false), undefined);
  const first = findChrome({}, () => true);
  assert.ok(first && /chrome|edge|chromium|brave/i.test(first));
});

test("cdp provider: needs a ws or http URL; headers are JSON", () => {
  assert.throws(() => new CdpProvider({ env: {} }), /OSA_CDP_URL is not set/);
  assert.throws(() => new CdpProvider({ url: "localhost:9222", env: {} }), /must start with ws/);
  const p = new CdpProvider({ url: "wss://cloud.example/connect?token=secret", env: {} });
  assert.deepEqual(p.capabilities, { liveLink: "none", aiFallback: false, captchaSolving: false, residentialExit: false, savedProfiles: false, fingerprint: "standard" });
  assert.deepEqual(parseCdpHeaders('{"X-API-Key":"k","N":1}'), { "X-API-Key": "k", N: "1" });
  assert.throws(() => parseCdpHeaders("[1]"), /JSON object/);
});

// ---------------------------------------------------------------------------------------------
// proxies

test("proxy parsing: http, https, socks5 with auth, host:port, host:port:user:pass", () => {
  assert.deepEqual(parseProxy("http://u:p%40ss@1.2.3.4:8080"), { scheme: "http", host: "1.2.3.4", port: 8080, username: "u", password: "p@ss" });
  assert.deepEqual(parseProxy("socks5://user:pw@proxy.example:1080"), { scheme: "socks5", host: "proxy.example", port: 1080, username: "user", password: "pw" });
  assert.deepEqual(parseProxy("https://proxy.example:443"), { scheme: "https", host: "proxy.example", port: 443 });
  assert.deepEqual(parseProxy("10.0.0.1:3128"), { scheme: "http", host: "10.0.0.1", port: 3128 });
  assert.deepEqual(parseProxy("gate.example:7000:alice:s3cret"), { scheme: "http", host: "gate.example", port: 7000, username: "alice", password: "s3cret" });
  assert.throws(() => parseProxy("ftp://x:21"), /not supported/);
  assert.throws(() => parseProxy("not a proxy"), /must look like/);
  try { parseProxy("http://u:topsecret@host"); } catch (e) { assert.ok(!(e as Error).message.includes("topsecret")); }
});

test("proxies are shown as host:port only, never with the password", () => {
  const p = parseProxy("socks5://alice:s3cret@gate.example:1080");
  assert.equal(proxyLabel(p), "gate.example:1080");
  assert.equal(maskProxyText("socks5://alice:s3cret@gate.example:1080"), "socks5://gate.example:1080 (with login)");
  assert.equal(scrub("auth failed for alice:s3cret", p), "auth failed for ***:***");
  assert.deepEqual(toPlaywrightProxy(p), { server: "socks5://gate.example:1080", username: "alice", password: "s3cret" });
  assert.deepEqual(toBrowsaProxy(p), { type: "socks5", host: "gate.example", port: 1080, username: "alice", password: "s3cret" });
});

test("proxy settings from the environment: one for all, per store, and a pool from a list or a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osa-proxy-"));
  const file = join(dir, "p.txt");
  await writeFile(file, "# my pool\n1.1.1.1:8000\nhttp://u:p@2.2.2.2:8000 # second\n");
  assert.deepEqual(parsePoolText(`@${file}`), ["1.1.1.1:8000", "http://u:p@2.2.2.2:8000"]);
  const s = proxySettingsFrom({ OSA_PROXY: "9.9.9.9:1", OSA_PROXY_AMAZON: "8.8.8.8:2", OSA_PROXIES: "a.example:1,b.example:2" }, { perStore: { target: "7.7.7.7:3" } });
  assert.deepEqual(s, { all: "9.9.9.9:1", perStore: { target: "7.7.7.7:3", amazon: "8.8.8.8:2" }, pool: ["a.example:1", "b.example:2"] });
});

test("proxy precedence: the store's own, then the one for all, then the pool", async () => {
  const plan = new ProxyPlan({ all: "9.9.9.9:1", perStore: { amazon: "8.8.8.8:2" }, pool: ["a.example:1"] }, { check: async () => true });
  assert.equal(proxyLabel(await plan.forStore("amazon")), "8.8.8.8:2");
  assert.equal(proxyLabel(await plan.forStore("walmart")), "9.9.9.9:1");
  const poolOnly = new ProxyPlan({ perStore: { amazon: "8.8.8.8:2" }, pool: ["a.example:1"] }, { check: async () => true });
  assert.equal(proxyLabel(await poolOnly.forStore("walmart")), "a.example:1");
  assert.equal(await new ProxyPlan({}).forStore("ebay"), undefined);
});

test("proxy pool rotates per store, starts elsewhere each run, and skips one that fails the quick check", async () => {
  const pool = ["a.example:1", "b.example:2", "c.example:3"];
  const checked: string[] = [];
  const plan = new ProxyPlan({ pool }, { start: 0, check: async (p) => { checked.push(p.host); return p.host !== "b.example"; } });
  assert.equal(proxyLabel(await plan.forStore("amazon")), "a.example:1");
  assert.equal(proxyLabel(await plan.forStore("walmart")), "c.example:3"); // b failed the check
  assert.equal(proxyLabel(await plan.forStore("amazon")), "a.example:1"); // a store keeps its proxy in the run
  assert.equal(proxyLabel(await plan.forStore("ebay")), "a.example:1");   // b is skipped from now on
  assert.deepEqual(checked, ["a.example", "b.example", "c.example", "a.example"]);
  const next = new ProxyPlan({ pool }, { start: 1, check: async () => true });
  assert.equal(proxyLabel(await next.forStore("amazon")), "b.example:2");
  const dead = new ProxyPlan({ pool }, { check: async () => false });
  await assert.rejects(dead.forStore("amazon"), /every proxy in the pool failed/);
});

test("test proxy: exit IP and country; errors never show the password", async () => {
  const ok = await testProxy("http://u:pw@1.2.3.4:8080", { get: async () => '{"ip":"203.0.113.9","country":"US"}' });
  assert.equal(ok.ok, true);
  assert.equal(ok.ip, "203.0.113.9");
  assert.equal(ok.country, "US");
  assert.equal(ok.proxy, "1.2.3.4:8080");
  const bad = await testProxy("http://u:pw-secret@1.2.3.4:8080", { get: async () => { throw new Error("407 for u:pw-secret"); } });
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes("pw-secret"));
  const saved = await testProxyFromSettings({ store: "amazon" }, { storeProxies: { amazon: "5.5.5.5:1" } }, { test: async (t) => ({ ok: true, proxy: t }) });
  assert.equal(saved.proxy, "5.5.5.5:1");
});

test("settings: provider, CDP URL, per-store proxies and pool are stored, shown masked, kept when masked", () => {
  const cur = { storeProxies: { amazon: "http://a:secret@1.1.1.1:80" }, proxyPool: ["socks5://b:secret2@2.2.2.2:1080"], cdpUrl: "wss://cdp.example/x?token=tok" };
  const pub = byokPublic(cur);
  const text = JSON.stringify(pub);
  assert.ok(!text.includes("secret") && !text.includes("tok"));
  assert.equal(pub.cdpUrl, "cdp.example");
  assert.equal(pub.storeProxies.amazon, "http://1.1.1.1:80 (with login)");
  const next = sanitizeByok({ browser: "local", storeProxies: { amazon: pub.storeProxies.amazon, walmart: "3.3.3.3:3", target: "" }, proxyPool: pub.proxyPool.join("\n") + "\n4.4.4.4:4", cdpUrl: "" }, cur);
  assert.equal(next.browser, "local");
  assert.deepEqual(next.storeProxies, { amazon: "http://a:secret@1.1.1.1:80", walmart: "3.3.3.3:3" });
  assert.deepEqual(next.proxyPool, ["socks5://b:secret2@2.2.2.2:1080", "4.4.4.4:4"]);
  assert.equal(sanitizeByok({ storeProxies: { amazon: "none" } }, cur).storeProxies, undefined);
  assert.throws(() => sanitizeByok({ storeProxies: { amazon: "bad proxy" } }, cur), /must look like/);
  assert.throws(() => sanitizeByok({ browser: "firefox" }, cur), /must be one of/);
});

// ---------------------------------------------------------------------------------------------
// bring your own model key

test("AI fallback routing on Browsa: your key when given, else the hosted tier", () => {
  const anthropic = { provider: "anthropic" as const, model: "claude-sonnet-5-5", apiKey: "sk-ant-x" };
  assert.deepEqual(browsaTaskLlm({ llm: anthropic, env: {} }), { aiLlm: "anthropic:claude-sonnet-5-5", aiLlmApiKey: "sk-ant-x", source: "own" });
  const router = { provider: "openai" as const, model: "anthropic/claude-sonnet-5.5", apiKey: "sk-or", baseUrl: "https://openrouter.ai/api/v1" };
  assert.deepEqual(browsaTaskLlm({ llm: router, env: {} }), { aiLlm: "openai:anthropic/claude-sonnet-5.5", aiLlmApiKey: "sk-or", aiLlmBaseUrl: "https://openrouter.ai/api/v1", source: "own" });
  assert.deepEqual(browsaTaskLlm({ env: {} }), { aiLlm: "browsa", source: "hosted" });
  assert.deepEqual(browsaTaskLlm({ llm: anthropic, env: { OSA_AI_LLM: "browsa-smart" } }), { aiLlm: "browsa-smart", source: "hosted" });
  assert.equal(browsaTaskLlm({ env: { OSA_AI_LLM_KEY_ID: "lk_1" } }).aiLlmKeyId, "lk_1");
});

test("the Browsa AI fallback task carries your key, base URL or saved key id; hosted carries none", async () => {
  const tasks: Record<string, unknown>[] = [];
  const client = {
    createAgent: async () => ({ id: "agt_1", cdp_http: "http://cdp" }),
    destroyAgent: async () => ({}),
    runTask: async (o: Record<string, unknown>) => { tasks.push(o); return { id: "job", status: "completed", finalResult: '{"ok":1}' }; },
  } as never;
  const page = { url: () => "https://www.walmart.com/", isClosed: () => false, goto: async () => null } as unknown as Page;
  const browser = { contexts: () => [{ pages: () => [page], newCDPSession: undefined, on: () => {} }], close: async () => {}, isConnected: () => true };
  const open = async (aiLlm: string, more: Record<string, string> = {}) => {
    const pool = new BrowserPool({ apiKey: "agt_x", client, mode: "burner", aiLlm, ...more, connect: async () => browser as never, dataDir: await mkdtemp(join(tmpdir(), "osa-pool-")) });
    const sb = await pool.openStore("walmart");
    await sb.context("walmart.com", { signal: new AbortController().signal }).aiTask("read it");
  };
  await open("anthropic:claude-sonnet-5-5", { aiLlmApiKey: "sk-ant" });
  await open("openai:some/model", { aiLlmApiKey: "sk-or", aiLlmBaseUrl: "https://openrouter.ai/api/v1" });
  await open("anthropic:claude-sonnet-5-5", { aiLlmKeyId: "lk_9" });
  await open("browsa", { aiLlmApiKey: "ignored" });
  assert.equal(tasks[0].llm, "anthropic:claude-sonnet-5-5");
  assert.equal(tasks[0].llmApiKey, "sk-ant");
  assert.equal(tasks[1].llmBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(tasks[2].llmKeyId, "lk_9");
  assert.equal(tasks[2].llmApiKey, undefined);
  assert.equal(tasks[3].llm, "browsa");
  assert.equal(tasks[3].llmApiKey, undefined);
});

test("the engine routes the Browsa fallback through your key when you have one", () => {
  const own = new ShoppingAgent({ apiKey: "agt_x", llm: { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-own" } });
  assert.equal(own.browsaFallback().aiLlmApiKey, "sk-ant-own");
  assert.match(own.fallbackText("browsa"), /anthropic:claude-sonnet-5-5 with your own key/);
  const hosted = new ShoppingAgent({ apiKey: "agt_x", llm: false });
  assert.equal(hosted.browsaFallback().aiLlm, "browsa");
  assert.match(hosted.fallbackText("local"), /AI fallback is off/);
});

test("test key: asks the model a tiny question; errors never show the key", async () => {
  const ok = await testModelKey({ llm: "anthropic", llmApiKey: "sk-ant-123" }, {}, { complete: (async () => ({ ok: true })) as never });
  assert.equal(ok.ok, true);
  assert.match(ok.model ?? "", /^anthropic:/);
  const bad = await testModelKey({ llm: "openai", llmApiKey: "sk-bad-999" }, {}, { complete: (async () => { throw new Error("HTTP 401 for sk-bad-999"); }) as never });
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes("sk-bad-999"));
  const none = await testModelKey({ llm: "browsa" }, {}, { complete: (async () => ({ ok: true })) as never });
  assert.equal(none.ok, false);
});

// ---------------------------------------------------------------------------------------------
// degradation on a browser without Browsa's capabilities

function fakePage(url = "https://www.walmart.com/"): Page {
  let fronted = 0;
  return {
    url: () => url, isClosed: () => false, close: async () => {}, bringToFront: async () => { fronted++; },
    waitForTimeout: async () => {}, title: async () => "", get fronted() { return fronted; },
  } as unknown as Page;
}

function fakeProvider(id: "local" | "cdp", opts: { headless?: boolean } = {}): BrowserProvider & { opened: StoreId[]; closed: number } {
  const caps = id === "local" ? localCapabilities(!!opts.headless) : { liveLink: "none" as const, aiFallback: false, captchaSolving: false, residentialExit: false, savedProfiles: false, fingerprint: "standard" as const };
  const p = {
    id, label: id === "local" ? "your Chrome" : "your CDP browser", capabilities: caps, opened: [] as StoreId[], closed: 0,
    async open(store: StoreId): Promise<ProviderBrowser> {
      p.opened.push(store);
      const page = fakePage(`https://www.${store}.com/`);
      return buildProviderBrowser({
        store, provider: id, capabilities: caps, agentId: `${id}-${store}`, page, context: { newPage: async () => fakePage() } as unknown as BrowserContext,
        close: async () => { p.closed++; },
      });
    },
  };
  return p;
}

class BlockedAdapter extends FakeAdapter {
  async search(): Promise<Offer[]> { throw new BotCheckError("Amazon shows a bot check that did not clear on this browser."); }
}

class AiAdapter extends FakeAdapter {
  aiError?: unknown;
  async search(ctx: StoreContext, item: ItemRequest, limit: number): Promise<Offer[]> {
    try { await ctx.aiTask("read the results"); } catch (e) { this.aiError = e; }
    return super.search(ctx, item, limit);
  }
}

test("engine on your Chrome: browser event, one exit warning, bot wall -> needs_user + hint, no AI fallback, no credits", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-prov-"));
  const prov = fakeProvider("local");
  const walmart = new AiAdapter("walmart", { catalog: { cable: [offer("walmart", "USB-C cable 6ft", 8.5)] } });
  const amazon = new BlockedAdapter("amazon", { catalog: {} });
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir, browser: prov, adapters: { walmart, amazon } });
  const run = await agent.run("usb-c cable on amazon or walmart", { onEvent: (e) => events.push(e), until: "picks" });
  const b = events.find((e) => e.type === "browser");
  assert.ok(b && b.type === "browser" && b.label === "your Chrome" && b.capabilities.liveLink === "window" && !b.capabilities.captchaSolving);
  assert.equal(events.filter((e) => e.type === "log" && e.message === NON_BROWSA_EXIT_WARNING).length, 1);
  const nu = events.find((e) => e.type === "needs_user" && e.store === "amazon");
  assert.ok(nu && nu.type === "needs_user" && nu.needs.reason === "captcha_handoff");
  assert.equal(nu.needs.message, "This store showed a bot check. Solve it in the browser window, or run with Browsa to pass it automatically.");
  const f = events.find((e) => e.type === "store_failed" && e.store === "amazon");
  assert.ok(f && f.type === "store_failed" && f.hint === "Amazon blocked this browser. Browsa's Phantom passes it: browsa.io");
  assert.ok(walmart.aiError instanceof CapabilityMissing);
  assert.equal((walmart.aiError as CapabilityMissing).capability, "aiFallback");
  assert.equal(run.picks.length, 1);
  assert.equal(run.summary().creditsUsed, undefined);
  assert.ok(events.some((e) => e.type === "log" && /AI fallback is off/.test(e.message)));
  assert.deepEqual(prov.opened.sort(), ["amazon", "walmart"]);
  assert.equal(prov.closed, 2);
});

test("engine on a CDP browser: the bot-check hand-off points at the provider's viewer", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-prov-"));
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir, browser: fakeProvider("cdp"), adapters: { amazon: new BlockedAdapter("amazon", { catalog: {} }) } });
  await agent.run("usb-c cable on amazon", { onEvent: (e) => events.push(e), until: "picks" });
  const nu = events.find((e) => e.type === "needs_user");
  assert.ok(nu && nu.type === "needs_user" && /remote browser/.test(nu.needs.message) && /run with Browsa/.test(nu.needs.message));
});

test("a non-bot failure on your Chrome stays a plain failure (no hint, no hand-off)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-prov-"));
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir, browser: fakeProvider("local"), adapters: { walmart: new FakeAdapter("walmart", { catalog: {}, failSearch: true }) } });
  await agent.run("usb-c cable on walmart", { onEvent: (e) => events.push(e), until: "picks" });
  assert.ok(!events.some((e) => e.type === "needs_user"));
  const f = events.find((e) => e.type === "store_failed");
  assert.ok(f && f.type === "store_failed" && !f.hint);
  assert.ok(!events.some((e) => e.type === "log" && e.message === NON_BROWSA_EXIT_WARNING)); // no blocky store
});

test("liveLink on your Chrome says where to take over; needsUser puts it in the message", async () => {
  const sb = await fakeProvider("local").open("walmart");
  const ctx = sb.context("walmart.com", { signal: new AbortController().signal });
  assert.equal(await ctx.liveLink(), "Take over in the browser window on this computer.");
  assert.equal((ctx.page as unknown as { fronted: number }).fronted, 1);
  const n = await needsUser(ctx, "sign_in", "Walmart asks you to sign in.");
  assert.deepEqual(n, { reason: "sign_in", message: "Walmart asks you to sign in. Take over in the browser window on this computer.", liveUrl: undefined });
  const headless = await fakeProvider("local", { headless: true }).open("walmart");
  assert.match(await headless.context("walmart.com", { signal: new AbortController().signal }).liveLink(), /headless/);
  const cdp = await fakeProvider("cdp").open("walmart");
  assert.match(await cdp.context("walmart.com", { signal: new AbortController().signal }).liveLink(), /provider's own viewer/);
});

test("a bot check on a browser that does not solve them waits for the person, then fails as a bot block", async () => {
  process.env.OSA_HANDOFF_WAIT_MS = "30";
  try {
    const sb = await fakeProvider("local").open("walmart");
    const logs: string[] = [];
    const ctx = sb.context("walmart.com", { signal: new AbortController().signal, log: (m) => logs.push(m) });
    let checks = 0;
    await passBotCheck(ctx, "Walmart", async () => ++checks < 3); // the person solves it
    assert.ok(logs.some((l) => /Solve it in the browser window/.test(l)));
    const err = await passBotCheck(ctx, "Walmart", async () => true).catch((e) => e);
    assert.ok(err instanceof BotCheckError);
    assert.ok(isBotBlock(err));
  } finally {
    delete process.env.OSA_HANDOFF_WAIT_MS;
  }
});

test("isBotBlock: bot checks, captchas, 403/429 and resets; not ordinary errors", () => {
  for (const m of ["Amazon shows a bot check", "captcha", "HTTP 429", "net::ERR_HTTP2_PROTOCOL_ERROR at https://www.bestbuy.com", "Access Denied", "Pardon Our Interruption"]) assert.ok(isBotBlock(new Error(m)), m);
  for (const m of ["search page changed", "timed out after 30s", "no results"]) assert.ok(!isBotBlock(new Error(m)), m);
});

test("BrowsaProvider wraps the pool and adds Browsa's capabilities", async () => {
  const opened: string[] = [];
  const pool = {
    openStore: async (store: StoreId, domain: string) => { opened.push(`${store}:${domain}`); return { store, agentId: "agt_1", mode: "burner", page: fakePage(), context: () => ({}) as StoreContext, close: async () => {} }; },
    closeAll: async () => {},
  };
  const p = new BrowsaProvider(pool as never);
  const sb = await p.open("shopify", { domain: "satechi.net" });
  assert.equal(sb.provider, "browsa");
  assert.equal(sb.capabilities.captchaSolving, true);
  assert.equal(sb.capabilities.liveLink, "remote");
  assert.deepEqual(opened, ["shopify:satechi.net"]);
});
