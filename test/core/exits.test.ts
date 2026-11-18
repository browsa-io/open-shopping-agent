// Exit per store (browsers.ts): own proxy, Browsa's residential US exit, or the default with a warning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { BrowserPool, exitWarningText, proxyDisplay, proxyFromText, type BrowsaClient } from "../../src/core/browsers.js";
import { ShoppingAgent } from "../../src/core/engine.js";
import type { RunEvent } from "../../src/core/types.js";
import { FakeAdapter, offer } from "./fake-adapter.js";

interface FakeOpts { network?: { enabled: boolean; tiers: { network: string; countries: string[] }[] } | "missing" | "error"; refuseNetwork?: boolean }

function fakeClient(o: FakeOpts = {}) {
  const calls: { fn: string; args: Record<string, any> }[] = [];
  let n = 0;
  const client: Record<string, unknown> = {
    createAgent: async (a: Record<string, any>) => {
      calls.push({ fn: "createAgent", args: a });
      if (o.refuseNetwork && a.proxy?.network) throw new Error("HTTP 403: proxy network not enabled for this account");
      n++;
      return { id: `agt_${n}`, status: "running", mode: a.mode ?? "burner", cdp_http: `https://browsa.io/api/v1/cdp/p${n}` };
    },
    getAgent: async (id: string) => ({ id, status: "running", mode: "persistent", cdp_http: `https://browsa.io/api/v1/cdp/${id}` }),
    openSession: async (id: string) => ({ id, cdp_http: `https://browsa.io/api/v1/cdp/${id}-s` }),
    destroyAgent: async (id: string) => { calls.push({ fn: "destroyAgent", args: { id } }); },
    createLiveLink: async () => ({ live_url: "https://browsa.io/live#x" }),
    runTask: async (t: Record<string, any>) => { calls.push({ fn: "runTask", args: t }); return { id: "j", status: "completed", finalResult: "{\"ok\":true}" }; },
    createSession: async () => ({ id: "s", sessionId: "s", status: "queued" }),
    waitForJob: async (id: string) => ({ id, status: "completed", agentId: "agt_s" }),
    runMessage: async () => ({ id: "m", status: "completed", finalResult: "x" }),
    stopSession: async () => ({}),
    credits: async () => ({ balance: 100 }),
    listIdentities: async () => [],
  };
  if (o.network !== "missing") {
    client.proxyNetwork = async () => {
      if (o.network === "error") throw new Error("HTTP 500");
      return { raw: {}, ...(o.network ?? { enabled: true, tiers: [{ network: "datacenter", countries: ["de"] }, { network: "residential", countries: ["us", "gb"] }] }) };
    };
  }
  return { client: client as unknown as BrowsaClient, calls };
}

const connect = async (): Promise<Browser> => {
  const page = { url: () => "https://www.amazon.com/s?k=hub", isClosed: () => false };
  return { contexts: () => [{ pages: () => [page] }], close: async () => {} } as unknown as Browser;
};

async function pool(o: FakeOpts, extra: Partial<ConstructorParameters<typeof BrowserPool>[0]> = {}) {
  const c = fakeClient(o);
  const logs: string[] = [];
  const p = new BrowserPool({
    apiKey: "agt_test", client: c.client, connect, mode: "burner", dataDir: await mkdtemp(join(tmpdir(), "osa-x-")),
    log: (s, m) => logs.push(`${s}: ${m}`), ...extra,
  });
  return { p, ...c, logs };
}

test("proxyFromText and proxyDisplay", () => {
  assert.equal(proxyFromText(""), undefined);
  assert.equal(proxyFromText(undefined), undefined);
  assert.deepEqual(proxyFromText("http://u:p@1.2.3.4:8080"), { server: "http://u:p@1.2.3.4:8080" });
  assert.deepEqual(proxyFromText("socks5://proxy.example.com:1080/"), { server: "socks5://proxy.example.com:1080" });
  assert.deepEqual(proxyFromText("host.example:3128"), { server: "host.example:3128" });
  assert.deepEqual(proxyFromText('{"type":"http","host":"h","port":1}'), { type: "http", host: "h", port: 1 });
  assert.throws(() => proxyFromText("not a proxy"), /OSA_PROXY must look like/);
  assert.equal(proxyDisplay({ server: "http://user:secret@1.2.3.4:8080" }), "1.2.3.4:8080");
  assert.equal(proxyDisplay({ host: "h", port: 1 }), "h:1");
});

test("residential US exit for Amazon, Target and Best Buy; Walmart, eBay, Shopify stay on the default", async () => {
  const { p, calls } = await pool({});
  assert.equal((await p.exitFor("amazon")).exit.kind, "residential_us");
  assert.equal((await p.exitFor("target")).exit.kind, "residential_us");
  assert.equal((await p.exitFor("bestbuy")).exit.kind, "residential_us");
  for (const s of ["walmart", "ebay", "shopify"] as const) assert.equal((await p.exitFor(s)).exit.kind, "default");
  assert.equal(await p.exitWarning(["amazon", "walmart", "target"]), undefined);

  const b = await p.openStore("amazon");
  assert.equal(b.exit?.kind, "residential_us");
  assert.equal(b.exit?.label, "Browsa residential (US)");
  assert.deepEqual(calls.find((c) => c.fn === "createAgent")!.args.proxy, { network: "residential", country: "us" });
  // The AI fallback of a fresh browser is a standalone task on the same exit, without agent_id.
  await b.context("amazon.com", { signal: new AbortController().signal }).aiTask("read the page");
  const task = calls.find((c) => c.fn === "runTask")!.args;
  assert.equal(task.agentId, undefined);
  assert.equal(task.agent_id, undefined);
  assert.equal(task.initialUrl, "https://www.amazon.com/s?k=hub");
  assert.equal(task.llm, "browsa");
  assert.equal(task.maxCredits, 15);
  assert.deepEqual(task.proxy, { network: "residential", country: "us" });
  await b.close();

  const w = await p.openStore("walmart");
  assert.equal(w.exit?.kind, "default");
  assert.equal(calls.filter((c) => c.fn === "createAgent")[1].args.proxy, undefined);
  await w.close();
});

test("data saver: residential-exit browsers block images, video, fonts and ads on every tab", async () => {
  const sent: { page: number; method: string; params?: Record<string, unknown> }[] = [];
  let onPage: ((p: unknown) => void) | undefined;
  const mkBrowser = () => {
    const pages = [{ id: 0, url: () => "about:blank", isClosed: () => false }];
    const bctx = {
      pages: () => pages,
      newCDPSession: async (p: { id: number }) => ({ send: async (method: string, params?: Record<string, unknown>) => { sent.push({ page: p.id, method, params }); } }),
      on: (ev: string, fn: (p: unknown) => void) => { if (ev === "page") onPage = fn; },
    };
    return { contexts: () => [bctx], close: async () => {} } as unknown as Browser;
  };
  const c = fakeClient();
  const logs: string[] = [];
  const p = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: async () => mkBrowser(), mode: "burner", dataDir: await mkdtemp(join(tmpdir(), "osa-ds-")), log: (_s, m) => logs.push(m) });
  const amazon = await p.openStore("amazon");
  const blocked = sent.find((s) => s.method === "Network.setBlockedURLs")!;
  assert.ok((blocked.params!.urls as string[]).includes("*.jpg*"));
  assert.ok(logs.some((l) => /data saver on/.test(l)));
  onPage?.({ id: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(sent.some((s) => s.page === 1 && s.method === "Network.setBlockedURLs"), "a new tab gets it too");
  await amazon.close();
  sent.length = 0;
  const walmart = await p.openStore("walmart");
  assert.equal(sent.length, 0, "the default exit is not billed per GB: pages load in full");
  await walmart.close();
  const never = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: async () => mkBrowser(), mode: "burner", saveData: "never", dataDir: await mkdtemp(join(tmpdir(), "osa-ds2-")) });
  await (await never.openStore("target")).close();
  assert.equal(sent.length, 0);
});

test("busy browser slots (429): wait for a free slot, never fall back to another exit", async () => {
  const c = fakeClient();
  let busy = 2;
  const real = (c.client as unknown as Record<string, (a: unknown) => Promise<unknown>>).createAgent;
  (c.client as unknown as Record<string, unknown>).createAgent = async (a: Record<string, unknown>) => {
    if (busy-- > 0) throw Object.assign(new Error("HTTP 429: too many running agents"), { status: 429, retryAfter: 0.001 });
    return real(a);
  };
  const logs: string[] = [];
  const p = new BrowserPool({ apiKey: "agt_test", client: c.client, connect, mode: "burner", slotWaitMs: 60_000, log: (_s, m) => logs.push(m), dataDir: await mkdtemp(join(tmpdir(), "osa-sl-")) });
  const t0 = Date.now();
  const b = await Promise.race([p.openStore("amazon"), new Promise<never>((_, r) => setTimeout(() => r(new Error("slow")), 20_000))]);
  assert.equal(b.exit?.kind, "residential_us", "a busy slot is not a refused exit");
  assert.ok(logs.some((l) => /all browser slots are in use/.test(l)));
  assert.equal(p.slotsShort, true);
  assert.ok(Date.now() - t0 >= 1_900, "waited between tries");
  await b.close();
  const q = new BrowserPool({ apiKey: "agt_test", client: c.client, connect, mode: "burner", slotWaitMs: 0, dataDir: await mkdtemp(join(tmpdir(), "osa-sl2-")) });
  busy = 5;
  await assert.rejects(q.openStore("walmart"), /429/);
});

test("a residential exit that cannot reach the store is replaced by the default exit", async () => {
  const c = fakeClient();
  const logs: string[] = [];
  let made = 0;
  const conn = async (): Promise<Browser> => {
    const tunnelBroken = made++ === 0;
    const page = {
      url: () => "about:blank", isClosed: () => false,
      goto: async () => { if (tunnelBroken) throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.amazon.com/"); return null; },
    };
    return { contexts: () => [{ pages: () => [page] }], close: async () => {} } as unknown as Browser;
  };
  const p = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: conn, mode: "burner", log: (_s, m) => logs.push(m), dataDir: await mkdtemp(join(tmpdir(), "osa-tf-")) });
  const b = await p.openStore("amazon");
  assert.equal(b.exit?.kind, "default");
  const created = c.calls.filter((x) => x.fn === "createAgent");
  assert.deepEqual(created.map((x) => x.args.proxy), [{ network: "residential", country: "us" }, undefined]);
  assert.deepEqual(c.calls.filter((x) => x.fn === "destroyAgent").map((x) => x.args.id), ["agt_1"], "the broken browser is destroyed");
  assert.ok(logs.some((l) => /cannot reach www.amazon.com \(net::ERR_TUNNEL_CONNECTION_FAILED\)/.test(l)));
  assert.ok(logs.some((l) => /Amazon may block Browsa's default exit/.test(l)));
  await b.close();
});

test("a create that fails with a gateway timeout but left a browser on Browsa: that browser is stopped", async () => {
  const c = fakeClient();
  let leaked = "";
  (c.client as unknown as Record<string, unknown>).createAgent = async (a: Record<string, any>) => {
    c.calls.push({ fn: "createAgent", args: a });
    if (a.proxy?.network) { leaked = a.initial_url; throw Object.assign(new Error("HTTP 504: gateway timeout"), { status: 504 }); }
    return { id: "agt_ok", status: "running", cdp_http: "https://browsa.io/api/v1/cdp/ok" };
  };
  const listed: string[] = [];
  const fetch = (async (url: string) => {
    listed.push(url);
    return new Response(JSON.stringify({ agents: [
      { id: "agt_leak", status: "queued", options: { initial_url: leaked } },
      { id: "agt_other", status: "running", options: { initial_url: "https://www.target.com/#osa-someoneelse" } },
    ] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const logs: string[] = [];
  const p = new BrowserPool({ apiKey: "agt_test", client: c.client, connect, mode: "burner", fetch, log: (_s, m) => logs.push(m), dataDir: await mkdtemp(join(tmpdir(), "osa-or-")) });
  const b = await p.openStore("target");
  assert.equal(b.exit?.kind, "default", "falls back after the failed residential create");
  assert.deepEqual(c.calls.filter((x) => x.fn === "destroyAgent").map((x) => x.args.id), ["agt_leak"], "only the browser with our tag");
  assert.ok(listed[0].endsWith("/v1/agents?limit=50"));
  assert.ok(logs.some((l) => /stopped browser agt_leak/.test(l)));
  await b.close();
});

test("the user's own proxy is used for every store", async () => {
  const own = { server: "http://u:p@9.9.9.9:8000" };
  const { p, calls } = await pool({}, { proxy: own });
  for (const s of ["amazon", "walmart", "ebay"] as const) {
    const b = await p.openStore(s);
    assert.equal(b.exit?.kind, "own");
    assert.equal(b.exit?.label, "your proxy");
    await b.close();
  }
  assert.deepEqual(calls.filter((c) => c.fn === "createAgent").map((c) => c.args.proxy), [own, own, own]);
  assert.equal(await p.exitWarning(["amazon", "target"]), undefined);
});

test("no US network: default exit and a warning naming the stores that may block", async () => {
  for (const network of ["missing", "error", { enabled: true, tiers: [{ network: "residential", countries: ["de"] }] }, { enabled: false, tiers: [] }] as const) {
    const { p, calls } = await pool({ network: network as FakeOpts["network"] });
    assert.equal((await p.exitFor("amazon")).exit.kind, "default");
    const w = await p.exitWarning(["amazon", "walmart", "bestbuy", "ebay"]);
    assert.equal(w, exitWarningText(["amazon", "bestbuy"]));
    assert.match(w!, /^Amazon and Best Buy may block Browsa's default exit/);
    assert.match(w!, /OSA_PROXY/);
    const b = await p.openStore("amazon");
    assert.equal(b.exit?.kind, "default");
    assert.equal(calls.find((c) => c.fn === "createAgent")!.args.proxy, undefined);
    await b.close();
  }
});

test("usExit: false keeps the default exit", async () => {
  const { p } = await pool({}, { usExit: false });
  assert.equal((await p.exitFor("amazon")).exit.kind, "default");
});

test("Browsa refusing the residential exit falls back to the default exit with a warning", async () => {
  const { p, calls, logs } = await pool({ refuseNetwork: true });
  const b = await p.openStore("target");
  assert.equal(b.exit?.kind, "default");
  const made = calls.filter((c) => c.fn === "createAgent");
  assert.equal(made.length, 2);
  assert.deepEqual(made[0].args.proxy, { network: "residential", country: "us" });
  assert.equal(made[1].args.proxy, undefined);
  assert.ok(logs.some((l) => /refused the residential US exit/.test(l)));
  assert.ok(logs.some((l) => /Target may block Browsa's default exit/.test(l)));
  await b.close();
});

test("an own proxy that Browsa refuses fails the store (never silently dropped)", async () => {
  const c = fakeClient();
  (c.client as unknown as Record<string, unknown>).createAgent = async () => { throw new Error("proxy unreachable"); };
  const p = new BrowserPool({ apiKey: "agt_test", client: c.client, connect, mode: "burner", proxy: { server: "h:1" }, dataDir: await mkdtemp(join(tmpdir(), "osa-x-")) });
  await assert.rejects(p.openStore("amazon"), /proxy unreachable/);
});

test("a saved profile remembers its exit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-xp-"));
  const fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch;
  const c = fakeClient();
  const p = new BrowserPool({ apiKey: "agt_test", client: c.client, connect, mode: "persistent", dataDir, fetch });
  const b = await p.openStore("bestbuy");
  assert.equal(b.exit?.kind, "residential_us");
  await b.close();
  const saved = JSON.parse(await readFile(join(dataDir, "agents.json"), "utf8"));
  assert.equal(saved.bestbuy.exit, "residential_us");
  const p2 = new BrowserPool({ apiKey: "agt_test", client: fakeClient({ network: "missing" }).client, connect, mode: "persistent", dataDir, fetch });
  const b2 = await p2.openStore("bestbuy");
  assert.equal(b2.exit?.kind, "residential_us", "the profile keeps the exit it was made with");
  assert.equal(await p2.exitWarning(["bestbuy"]), undefined);
  await b2.close();
});

test("engine: store_started carries the exit and the run logs the exit warning", async () => {
  const c = fakeClient({ network: "missing" });
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({
    llm: false, client: c.client, apiKey: "agt_test", watchLinks: false, screenshots: false, history: false, browserMode: "burner",
    dataDir: await mkdtemp(join(tmpdir(), "osa-xe-")),
    adapters: { amazon: new FakeAdapter("amazon", { catalog: { hub: [offer("amazon", "USB-C hub", 30)] } }) },
  });
  // Attach with the fake connect: the engine builds its pool, so patch the pool factory.
  const make = agent.makePool.bind(agent);
  agent.makePool = (spend, log) => {
    const pl = make(spend, log)!;
    (pl as unknown as { o: { connect: typeof connect } }).o.connect = connect;
    return pl;
  };
  const run = await agent.run("a usb-c hub on amazon", { onEvent: (e) => events.push(e), until: "picks" });
  const started = events.find((e) => e.type === "store_started");
  assert.ok(started && started.type === "store_started");
  assert.equal(started.exit, "Browsa default");
  assert.ok(events.some((e) => e.type === "log" && /Amazon may block Browsa's default exit/.test(e.message)));
  await run.close();
});

test("engine: with browser slots short, a fresh browser stops after its search and reopens for the cart", async () => {
  const c = fakeClient({ network: "missing" });
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({
    llm: false, client: c.client, apiKey: "agt_test", watchLinks: false, screenshots: false, history: false, browserMode: "burner",
    dataDir: await mkdtemp(join(tmpdir(), "osa-xs-")),
    adapters: { walmart: new FakeAdapter("walmart", { catalog: { hub: [offer("walmart", "USB-C hub", 30)] } }) },
  });
  const make = agent.makePool.bind(agent);
  agent.makePool = (spend, log) => {
    const pl = make(spend, log)!;
    (pl as unknown as { o: { connect: typeof connect } }).o.connect = connect;
    pl.slotsShort = true;
    return pl;
  };
  const run = await agent.run("a usb-c hub on walmart", { onEvent: (e) => events.push(e), until: "cart" });
  assert.ok(events.some((e) => e.type === "log" && /slots are short; stopped this browser after the search/.test(e.message)));
  assert.equal(run.carts.size, 1, "the cart was filled in a fresh browser");
  assert.equal(c.calls.filter((x) => x.fn === "createAgent").length, 2);
  await run.close();
  assert.equal(c.calls.filter((x) => x.fn === "destroyAgent").length, 2);
});
