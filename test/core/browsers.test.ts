import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { BrowserPool, aiTaskText, jobResult, type BrowsaClient } from "../../src/core/browsers.js";
import { LimitError } from "../../src/core/limits.js";

function fakeClient() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }); return undefined; };
  let n = 0;
  const client = {
    createAgent: async (o: Record<string, unknown>) => { rec("createAgent")(o); n++; return { id: `agt_${n}`, status: "running", mode: o.mode ?? "burner", cdp_http: `https://browsa.io/api/v1/cdp/p${n}` }; },
    getAgent: async (id: string) => { rec("getAgent")(id); return { id, status: "running", mode: id === "agt_sess" ? "burner" : "persistent", cdp_http: `https://browsa.io/api/v1/cdp/${id}` }; },
    openSession: async (id: string) => { rec("openSession")(id); return { id, cdp_http: `https://browsa.io/api/v1/cdp/${id}-s` }; },
    destroyAgent: async (id: string) => { rec("destroyAgent")(id); },
    createLiveLink: async (id: string, o: unknown) => { rec("createLiveLink")(id, o); return { live_url: `https://browsa.io/live?agent=${id}#c=x` }; },
    runTask: async (o: Record<string, unknown>) => { rec("runTask")(o); return { id: "job1", status: "completed", finalResult: '{"title":"Walmart"}' }; },
    createSession: async (o: Record<string, unknown>) => { rec("createSession")(o); return { id: "sess1", sessionId: "sess1", status: "queued" }; },
    waitForJob: async (id: string) => { rec("waitForJob")(id); return { id, status: "completed", agentId: "agt_sess" }; },
    runMessage: async (sid: string, task: string, o: unknown) => { rec("runMessage")(sid, task, o); return { id: "job2", status: "completed", finalResult: "plain text" }; },
    stopSession: async (sid: string) => { rec("stopSession")(sid); return {}; },
    credits: async () => ({ balance: 100 }),
    listIdentities: async () => [],
  } as unknown as BrowsaClient;
  return { client, calls, names: () => calls.map((c) => c.fn) };
}

function fakeConnect() {
  const connected: string[] = [];
  const closed: string[] = [];
  const connect = async (cdp: string, key: string): Promise<Browser> => {
    assert.equal(key, "agt_test");
    connected.push(cdp);
    const page = { url: () => "https://www.walmart.com/", isClosed: () => false };
    return { contexts: () => [{ pages: () => [page] }], close: async () => { closed.push(cdp); } } as unknown as Browser;
  };
  return { connect, connected, closed };
}

const fetchLog: string[] = [];
const fakeFetch = (async (url: string, init: RequestInit) => { fetchLog.push(`${init.method} ${url}`); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;

test("burner: create, attach, AI task in a separate browser, destroy", async () => {
  const c = fakeClient(), k = fakeConnect();
  const pool = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: k.connect, mode: "burner", dataDir: await mkdtemp(join(tmpdir(), "osa-b-")) });
  const b = await pool.openStore("walmart");
  assert.equal(b.agentId, "agt_1");
  assert.equal(b.mode, "burner");
  assert.deepEqual(k.connected, ["https://browsa.io/api/v1/cdp/p1"]);
  const created = c.calls.find((x) => x.fn === "createAgent")!.args[0] as Record<string, unknown>;
  assert.match(String(created.initial_url), /^https:\/\/www\.walmart\.com\/#osa-[a-z0-9]+$/, "tagged so a lost browser can be found");
  assert.equal(created.ttl, "1800s");
  const ctx = b.context("walmart.com", { signal: new AbortController().signal });
  const r = await ctx.aiTask<{ title: string }>("Read the page title", { schema: { type: "object" } });
  assert.deepEqual(r, { title: "Walmart" });
  const task = c.calls.find((x) => x.fn === "runTask")!.args[0] as Record<string, unknown>;
  assert.equal(task.agentId, undefined);
  assert.equal(task.llm, "browsa");
  assert.equal(task.maxCredits, 15);
  assert.equal(task.initialUrl, "https://www.walmart.com/");
  assert.match(String(task.task), /never place an order/);
  assert.equal(await ctx.liveLink(), "https://browsa.io/live?agent=agt_1#c=x");
  assert.deepEqual((c.calls.find((x) => x.fn === "createLiveLink")!.args[1] as Record<string, unknown>).scope, "control");
  await b.close();
  await b.close();
  assert.equal(c.names().filter((x) => x === "destroyAgent").length, 1);
});

test("persistent: create once and remember, reuse with a session, AI task on the same profile", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "osa-p-"));
  const c = fakeClient(), k = fakeConnect();
  fetchLog.length = 0;
  const pool = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: k.connect, mode: "auto", dataDir, fetch: fakeFetch });
  assert.equal(await pool.modeFor("amazon"), "burner", "auto without a saved profile is a burner");

  const pp = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: k.connect, mode: "persistent", dataDir, fetch: fakeFetch });
  const b = await pp.openStore("amazon");
  const created = c.calls.find((x) => x.fn === "createAgent")!.args[0] as Record<string, unknown>;
  assert.equal(created.mode, "persistent");
  assert.equal(created.persona, "osa-amazon");
  const saved = JSON.parse(await readFile(join(dataDir, "agents.json"), "utf8"));
  assert.equal(saved.amazon.agentId, b.agentId);
  await b.close();
  assert.ok(fetchLog.includes(`DELETE https://browsa.io/v1/agents/${b.agentId}/sessions`));
  assert.ok(!c.names().includes("destroyAgent"), "a saved profile is never destroyed");

  // Next run ("auto" now finds the profile): a session on it, not a new identity.
  assert.equal(await pool.modeFor("amazon"), "persistent");
  const b2 = await pool.openStore("amazon");
  assert.equal(b2.agentId, b.agentId);
  assert.equal(c.names().filter((x) => x === "createAgent").length, 1);
  assert.equal(c.names().filter((x) => x === "openSession").length, 1);

  const ctx = b2.context("amazon.com", { signal: new AbortController().signal });
  await ctx.aiTask("Read the cart");
  const task = c.calls.filter((x) => x.fn === "runTask").at(-1)!.args[0] as Record<string, unknown>;
  assert.equal(task.agentId, b.agentId);
  assert.equal(c.names().filter((x) => x === "openSession").length, 2, "attached again after the task");
  assert.equal(k.connected.length, 3);
  await b2.close();
});

test("burner: AI tasks are standalone; a task that must act on this browser fails free", async () => {
  const c = fakeClient(), k = fakeConnect();
  const pool = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: k.connect, mode: "burner", aiMaxCredits: 7, dataDir: await mkdtemp(join(tmpdir(), "osa-b2-")) });
  const b = await pool.openStore("walmart");
  const ctx = b.context("walmart.com", { signal: new AbortController().signal });
  await assert.rejects(ctx.aiTask("Add this item to the cart", { sameBrowser: true }), /cannot act on this fresh browser/);
  assert.equal(c.names().includes("runTask"), false, "no task, no credits");
  await ctx.aiTask("Read the results", { startUrl: "https://www.walmart.com/search?q=hub" });
  const task = c.calls.find((x) => x.fn === "runTask")!.args[0] as Record<string, unknown>;
  assert.equal(task.agentId, undefined, "no agent_id on a burner (Browsa refuses it)");
  assert.equal(task.initialUrl, "https://www.walmart.com/search?q=hub");
  assert.equal(task.maxCredits, 7);
  assert.equal(task.llm, "browsa");
  await b.close();
});

test("options given as undefined keep the defaults (AI tasks always get a numeric cap)", async () => {
  const c = fakeClient(), k = fakeConnect();
  const pool = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: k.connect, mode: "burner", aiMaxCredits: undefined, aiLlm: undefined, dataDir: await mkdtemp(join(tmpdir(), "osa-u-")) });
  const b = await pool.openStore("walmart");
  await b.context("walmart.com", { signal: new AbortController().signal }).aiTask("Read the page");
  const task = c.calls.find((x) => x.fn === "runTask")!.args[0] as Record<string, unknown>;
  assert.equal(task.maxCredits, 15);
  assert.equal(task.llm, "browsa");
  await b.close();
});

test("the credit meter refuses a non-numeric cost instead of disabling its checks", async () => {
  const { CreditMeter } = await import("../../src/core/limits.js");
  const m = new CreditMeter(undefined, 20);
  await m.begin();
  await assert.rejects(m.spend(Number.NaN, "AI task"), /no valid credit cap/);
  assert.equal(await m.spend(15, "AI task"), 15);
  await assert.rejects(m.spend(15, "another AI task"), /5 of its 20 left/);
});

test("session: AI tasks run as follow-up messages on the same browser", async () => {
  const c = fakeClient(), k = fakeConnect();
  const pool = new BrowserPool({ apiKey: "agt_test", client: c.client, connect: k.connect, mode: "session", dataDir: await mkdtemp(join(tmpdir(), "osa-s-")) });
  const b = await pool.openStore("target");
  assert.equal(b.agentId, "agt_sess");
  const ctx = b.context("target.com", { signal: new AbortController().signal });
  assert.equal(await ctx.aiTask("say hi"), "plain text");
  assert.equal(c.calls.find((x) => x.fn === "runMessage")!.args[0], "sess1");
  assert.equal(k.connected.length, 1, "no reconnect");
  await b.close();
  assert.ok(c.names().includes("stopSession"));
});

test("spend refusal stops before anything is created", async () => {
  const c = fakeClient(), k = fakeConnect();
  const pool = new BrowserPool({
    apiKey: "agt_test", client: c.client, connect: k.connect, mode: "persistent", dataDir: await mkdtemp(join(tmpdir(), "osa-r-")),
    spend: (n) => { if (n > 40) throw new LimitError("credits", `needs ${n}`); },
  });
  await assert.rejects(pool.openStore("ebay"), /needs 50/);
  assert.ok(!c.names().includes("createAgent"));
});

test("jobResult and aiTaskText", () => {
  assert.deepEqual(jobResult({ status: "completed", finalResult: '```json\n{"a":1}\n```' }), { a: 1 });
  assert.equal(jobResult({ status: "completed", finalResult: "done" }), "done");
  assert.throws(() => jobResult({ status: "failed", errorCode: "MAX_CREDITS_REACHED", errorMessage: "cap" }), /MAX_CREDITS_REACHED/);
  assert.match(aiTaskText("x", { type: "object" }), /matches this JSON schema/);
});
