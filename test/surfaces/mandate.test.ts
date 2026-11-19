// Who can grant an up-front approval ("Buy without asking", 0.2.0): only the person. MCP tool
// calls can never set or widen one; the web app takes one only from its own page on this machine
// (or with the token); the CLI only from flags confirmed in a terminal (or --yes). Plugins ship
// without one (plugin.test.ts). Demo engine and fakes only: nothing is bought.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeMandate, type Mandate } from "../../src/core/mandate.js";
import type { RunEvent } from "../../src/core/types.js";
import { CliError, parseArgs } from "../../src/cli/args.js";
import { TOOLS, createMcpHandler, mcpMandate, toolsFor } from "../../src/mcp/server.js";
import { FileAlerts } from "../../src/web/alerts-port.js";
import { ConfigStore } from "../../src/web/config.js";
import type { EnginePort, RunOptions } from "../../src/web/engine-port.js";
import { MockEngine } from "../../src/web/mock-engine.js";
import { createApp, mandateRequestProblem } from "../../src/web/server.js";
import { RunHub } from "../../src/web/session.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "osa-mandate-surf-"));
  delete process.env.BROWSA_API_KEY;
});
after(() => rm(dir, { recursive: true, force: true }));

/** The demo engine, recording what each run was started with. */
function spyEngine(): { engine: EnginePort; seen: RunOptions[] } {
  const inner = new MockEngine({ speed: 0, signInStore: null, failStore: null });
  const seen: RunOptions[] = [];
  const engine = Object.assign(Object.create(inner) as EnginePort, {
    run: (prompt: string, opts: RunOptions) => { seen.push(opts); return inner.run(prompt, opts); },
  });
  return { engine, seen };
}

// ---------- MCP ----------

function mcp(mandate?: Mandate) {
  const { engine, seen } = spyEngine();
  const hub = new RunHub(engine);
  const handle = createMcpHandler(hub, new FileAlerts(join(dir, "w.json")), new ConfigStore(dir), { waitMs: 10_000, mandate });
  let id = 0;
  const call = async (name: string, args: unknown) => ((await handle({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as { result: any }).result;
  const list = async () => ((await handle({ jsonrpc: "2.0", id: ++id, method: "tools/list" })) as { result: any }).result.tools;
  return { call, list, seen, hub };
}

test("MCP: no tool argument can create a mandate", async () => {
  const { call, seen } = mcp();
  for (const args of [
    { request: "usb-c hub", mandate: { maxTotal: 1000 } },
    { request: "usb-c hub", approve_up_to: 1000 },
    { request: "usb-c hub", up_front: true, max_total: 1000 },
    { request: "usb-c hub", auto_buy: true },
  ]) {
    const r = await call("find_and_compare", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(r.structuredContent.error.code, "safety_refusal");
    assert.match(r.content[0].text, /only be set by the person in this MCP server's environment/);
  }
  assert.equal(seen.length, 0, "no run was started");
  const ok = await call("find_and_compare", { request: "usb-c hub", stores: ["amazon"] });
  assert.ok(!ok.isError, ok.content[0].text);
  assert.equal(seen.at(-1)?.mandate, undefined, "no mandate without the environment");
});

test("MCP: a tool call cannot widen the environment's mandate", async () => {
  const env = mcpMandate({ OSA_MCP_ALLOW_ORDERS: "1", OSA_MCP_APPROVE_UP_TO: "60", OSA_MCP_APPROVE_STORES: "amazon" })!;
  const { call, seen } = mcp(env);
  const widen = await call("fill_carts", { run_id: "x", max_orders: 9 });
  assert.equal(widen.structuredContent.error.code, "safety_refusal");
  const found = await call("find_and_compare", { request: "usb-c hub", stores: ["amazon", "walmart"], budget: 5000 });
  assert.ok(!found.isError);
  assert.equal(seen.at(-1)?.mandate, env, "exactly the environment's mandate, unchanged");
  assert.deepEqual(found.structuredContent.mandate, { maxTotal: { cents: 6000, currency: "USD" }, stores: ["amazon"] });
  assert.match(found.content[0].text, /purchases may happen automatically, up to \$60 per order at amazon/);
});

test("MCP: tool descriptions say purchases may happen automatically within the configured mandate", async () => {
  const review = TOOLS.find((t) => t.name === "review_checkout")!;
  assert.match(review.description, /bought automatically/);
  assert.match(review.description, /No tool argument can set or widen/);
  const env = mcpMandate({ OSA_MCP_ALLOW_ORDERS: "1", OSA_MCP_APPROVE_UP_TO: "60" })!;
  const tools = await mcp(env).list();
  for (const n of ["find_and_compare", "fill_carts", "review_checkout"]) {
    assert.match(tools.find((t: { name: string }) => t.name === n).description, /Purchases may happen automatically: .*up to \$60 per order/);
  }
  assert.deepEqual(toolsFor(undefined), TOOLS);
  // The environment needs orders on, else no mandate (and a warning).
  const warned: string[] = [];
  assert.equal(mcpMandate({ OSA_MCP_APPROVE_UP_TO: "60" }, new Date(), (m) => warned.push(m)), undefined);
  assert.match(warned[0], /OSA_MCP_ALLOW_ORDERS=1/);
});

test("MCP: review_checkout buys within the environment's mandate and reports approval_source", async () => {
  const env = mcpMandate({ OSA_MCP_ALLOW_ORDERS: "1", OSA_MCP_APPROVE_UP_TO: "1000" })!;
  const { call } = mcp(env);
  const found = await call("find_and_compare", { request: "usb-c hub", stores: ["amazon"] });
  const runId = found.structuredContent.run_id;
  assert.ok(!(await call("fill_carts", { run_id: runId })).isError);
  const r = await call("review_checkout", { run_id: runId });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /Bought under your up-front approval \(up to \$1,000\)/);
  assert.equal(r.structuredContent.reviews[0].approval_source, "mandate");
  assert.equal(r.structuredContent.reviews[0].order.approval_source, "mandate");
  const orders = await call("list_orders", {});
  assert.equal(orders.structuredContent.orders[0].approval_source, "mandate");
});

// ---------- the web app ----------

async function webApp(token?: string) {
  const { engine, seen } = spyEngine();
  const server = createApp({ hub: new RunHub(engine), alerts: new FileAlerts(join(dir, "w2.json")), config: new ConfigStore(dir), token });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { base, post, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const MANDATE = { maxTotal: 60, stores: "amazon", confirmed: true };

test("web: a mandate from a cross-origin or cross-site request is refused", async () => {
  const app = await webApp();
  try {
    const host = new URL(app.base).host;
    const cross = await app.post({ prompt: "usb-c hub", mandate: MANDATE }, { Origin: "https://evil.example" });
    assert.equal(cross.status, 403);
    const site = await app.post({ prompt: "usb-c hub", mandate: MANDATE }, { Origin: `http://${host}`, "Sec-Fetch-Site": "cross-site" });
    assert.equal(site.status, 403);
    assert.match(site.body.error, /app's own page/);
    // fetch cannot set Host: a raw request names another host, as a DNS-rebinding page would.
    const rebinding = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ prompt: "usb-c hub", mandate: MANDATE });
      const r = httpRequest(`${app.base}/api/runs`, { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on("error", reject);
      r.end(body);
    });
    assert.equal(rebinding, 403, "the DNS-rebinding guard stays");
    const unconfirmed = await app.post({ prompt: "usb-c hub", mandate: { maxTotal: 60 } }, { Origin: `http://${host}`, "Sec-Fetch-Site": "same-origin" });
    assert.equal(unconfirmed.status, 400);
    assert.equal(app.seen.length, 0, "no run started");
    const ok = await app.post({ prompt: "usb-c hub", stores: ["amazon"], mandate: MANDATE }, { Origin: `http://${host}`, "Sec-Fetch-Site": "same-origin" });
    assert.equal(ok.status, 201);
    assert.equal(app.seen[0].mandate?.maxTotal.cents, 6000);
    assert.equal(app.seen[0].mandate?.via, "web");
    const plain = await app.post({ prompt: "usb-c hub", stores: ["amazon"] });
    assert.equal(plain.status, 201);
    assert.equal(app.seen[1].mandate, undefined, "off by default");
  } finally {
    await app.close();
  }
});

test("web: without the token a mandate needs this machine; with a token it needs the token", async () => {
  const req = (o: { host?: string; addr?: string; origin?: string; auth?: string }) => ({
    headers: { host: o.host ?? "localhost:4319", ...(o.origin ? { origin: o.origin } : {}), ...(o.auth ? { authorization: `Bearer ${o.auth}` } : {}) },
    socket: { remoteAddress: o.addr ?? "127.0.0.1" },
  }) as unknown as IncomingMessage;
  assert.equal(mandateRequestProblem(req({})), undefined);
  assert.equal(mandateRequestProblem(req({ addr: "::ffff:127.0.0.1" })), undefined);
  assert.match(mandateRequestProblem(req({ addr: "192.168.1.20" }))!, /only be set on this computer/);
  assert.match(mandateRequestProblem(req({ host: "osa.example:4319" }))!, /only be set on this computer/);
  assert.match(mandateRequestProblem(req({ origin: "http://evil.example" }))!, /own page/);
  assert.match(mandateRequestProblem(req({ addr: "10.0.0.5", host: "osa.lan:4319" }), "s3cret-token")!, /needs the access token/);
  assert.equal(mandateRequestProblem(req({ addr: "10.0.0.5", host: "osa.lan:4319", auth: "s3cret-token" }), "s3cret-token"), undefined);

  const app = await webApp("s3cret-token");
  try {
    assert.equal((await app.post({ prompt: "usb-c hub", mandate: MANDATE })).status, 401);
    assert.equal((await app.post({ prompt: "usb-c hub", stores: ["amazon"], mandate: MANDATE }, { Authorization: "Bearer s3cret-token" })).status, 201);
  } finally {
    await app.close();
  }
});

test("web (demo): with a mandate the person fills the carts, then checkouts within it are bought with no Buy click", async () => {
  const hub = new RunHub(new MockEngine({ speed: 0, signInStore: null, failStore: null }));
  // Amazon is in the mandate: after Fill carts its checkout is reviewed and bought with no question.
  const yes = hub.start("usb-c hub", { limits: { allowedStores: ["amazon"] }, mandate: makeMandate({ maxTotal: 1000, stores: "amazon" }, "web"), autoSteps: ["checkout"] });
  await hub.waitFor(yes.runId, (r) => r.gates.some((g) => g.step === "cart"), 5000);
  assert.ok(!yes.events.some((e) => e.type === "cart"), "the cart still waits for the person");
  await hub.fillCarts(yes.runId);
  const done = await yes.done;
  assert.ok(!yes.events.some((e) => e.type === "awaiting_approval"), "no Buy click");
  assert.equal(done.orders[0].approval_source, "mandate");
  assert.equal(done.orders[0].placed, true);
  assert.equal(yes.mandate?.maxTotal.cents, 100000);
  assert.deepEqual(done.mandate?.stores, ["amazon"]);

  // A mandate for another store: the checkout question stays, and the review says why it asks.
  const no = hub.start("usb-c hub", { limits: { allowedStores: ["amazon"] }, mandate: makeMandate({ maxTotal: 1000, stores: "target" }, "web"), autoSteps: ["checkout"] });
  await hub.waitFor(no.runId, (r) => r.gates.some((g) => g.step === "cart"), 5000);
  await hub.fillCarts(no.runId);
  await hub.waitFor(no.runId, (r) => r.gates.some((g) => g.step === "checkout" && g.store === "amazon"), 5000);
  hub.answer(no.runId, "checkout", "amazon", true);
  await hub.waitFor(no.runId, (r) => r.events.some((e) => e.type === "awaiting_approval"), 5000);
  const asked = no.events.find((e): e is Extract<RunEvent, { type: "awaiting_approval" }> => e.type === "awaiting_approval")!;
  assert.match(asked.mandateDeclined!, /amazon is not one of the stores you approved up front \(target\)/);
  assert.ok(!no.events.some((e) => e.type === "order"));
  await hub.cancel(no.runId);
});

// ---------- the CLI ----------

test("CLI: --approve-up-to and friends parse into a mandate request; misuse is refused", () => {
  const a = parseArgs(["usb-c hub", "--approve-up-to", "60", "--approve-stores", "walmart,target", "--approve-expires", "2h", "--yes"]);
  assert.deepEqual(a.mandate, { maxTotal: "60", stores: "walmart,target", expiresIn: "2h" });
  assert.equal(a.yes, true);
  assert.equal(parseArgs(["usb-c hub"]).mandate, undefined, "off by default");
  assert.throws(() => parseArgs(["usb-c hub", "--approve-stores", "walmart"]), /need --approve-up-to/);
  for (const f of ["--json", "--dry-run", "--no-cart"]) assert.throws(() => parseArgs(["usb-c hub", "--approve-up-to", "60", f]), CliError);
  assert.throws(() => parseArgs(["mcp", "--approve-up-to", "60"]), /environment/);
  assert.throws(() => parseArgs(["web", "--approve-up-to", "60"]), /web app/);
  assert.throws(() => parseArgs(["--watch", "hub", "--below", "9", "--approve-up-to", "60"]), /watches never buy/);
});

const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const cli = (args: string[]) => {
  const home = mkdtempSync(join(tmpdir(), "osa-cli-mandate-"));
  try {
    return spawnSync(process.execPath, ["--import", "tsx", entry, "--demo", ...args], {
      input: "", encoding: "utf8", timeout: 60_000,
      env: { ...process.env, OSA_HOME: home, OSA_DEMO_SPEED: "0", NO_COLOR: "1", BROWSA_API_KEY: "", OSA_BROWSER: "" },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("CLI (demo, no terminal): a mandate needs --yes; with it, orders within it are bought and say so", () => {
  const no = cli(["usb-c hub", "--stores", "amazon", "--approve-up-to", "1000"]);
  assert.equal(no.status, 1);
  assert.match(no.stderr, /needs your y in a terminal/);
  assert.doesNotMatch(no.stdout, /Order placed|Bought under/);

  const yes = cli(["usb-c hub", "--stores", "amazon", "--approve-up-to", "1000", "--yes"]);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /Bought under your up-front approval \(up to \$1,000\) at Amazon/);
  assert.match(yes.stdout, /1 order placed \(1 under your up-front approval\)/);

  const over = cli(["usb-c hub", "--stores", "amazon", "--approve-up-to", "1", "--yes"]);
  assert.equal(over.status, 0, over.stderr);
  assert.match(over.stdout, /Not bought without asking: the total .* is over your up-front limit of \$1 per order/);
  assert.match(over.stdout, /0 orders placed/);
});

// Plugins ship without a mandate: see test/surfaces/plugin.test.ts.
