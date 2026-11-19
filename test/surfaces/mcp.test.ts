import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createMcpHandler, mcpOrdersAllowed } from "../../src/mcp/server.js";
import { FileAlerts } from "../../src/web/alerts-port.js";
import { ConfigStore } from "../../src/web/config.js";
import { MockEngine } from "../../src/web/mock-engine.js";
import { RunHub } from "../../src/web/session.js";

let dir: string;
let handle: ReturnType<typeof createMcpHandler>;
let id = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "osa-mcp-"));
  const hub = new RunHub(new MockEngine({ speed: 0, signInStore: null, failStore: null }));
  handle = createMcpHandler(hub, new FileAlerts(join(dir, "watches.json")), new ConfigStore(dir), { waitMs: 10_000 });
});
after(() => rm(dir, { recursive: true, force: true }));

const rpc = async (method: string, params?: unknown) => {
  const res = (await handle({ jsonrpc: "2.0", id: ++id, method, params })) as { result?: any; error?: any };
  return res;
};
const call = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).result;

test("initialize and tools/list", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "open-shopping-agent");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  const { result } = await rpc("tools/list");
  const names = result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names, ["find_and_compare", "fill_carts", "review_checkout", "place_order", "watch_price", "list_runs", "list_orders"]);
  const place = result.tools.find((t: { name: string }) => t.name === "place_order");
  assert.match(place.description, /ask the human first/i);
  assert.deepEqual(place.inputSchema.required, ["run_id", "store", "approved_total"]);
  for (const t of result.tools) assert.equal(t.inputSchema.type, "object");
  assert.equal((await rpc("nope/method")).error.code, -32601);
});

test("find, fill, review, then place_order only with the exact total", async () => {
  process.env.OSA_MCP_ALLOW_ORDERS = "1";
  const found = await call("find_and_compare", { request: "usb-c hub", stores: ["amazon", "walmart"], zip: "82001" });
  assert.ok(!found.isError, found.content?.[0]?.text);
  assert.match(found.content[0].text, /DEMO DATA/);
  assert.match(found.content[0].text, /\| Store \| Product \|/);
  const runId = found.structuredContent.run_id;
  assert.equal(found.structuredContent.picks.length, 1);
  const store = found.structuredContent.picks[0].store;

  const early = await call("place_order", { run_id: runId, store, approved_total: 1 });
  assert.equal(early.isError, true);

  const filled = await call("fill_carts", { run_id: runId });
  assert.ok(!filled.isError, filled.content[0].text);
  assert.equal(filled.structuredContent.carts.length, 1);

  const reviewed = await call("review_checkout", { run_id: runId });
  assert.ok(!reviewed.isError, reviewed.content[0].text);
  const total = reviewed.structuredContent.reviews[0].total;
  assert.ok(total.cents > 0);
  assert.match(reviewed.content[0].text, /TOTAL \$/);

  const wrong = await call("place_order", { run_id: runId, store, approved_total: total.cents / 100 + 1 });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /does not match/);
  const missing = await call("place_order", { run_id: runId, store });
  assert.equal(missing.isError, true);

  const placed = await call("place_order", { run_id: runId, store, approved_total: total.cents / 100 });
  assert.ok(!placed.isError, placed.content[0].text);
  assert.match(placed.content[0].text, /Order placed/);
  assert.equal(placed.structuredContent.order.total.cents, total.cents);

  const runs = await call("list_runs", { limit: 5 });
  assert.match(runs.content[0].text, new RegExp(runId));
});

test("watch_price and argument errors", async () => {
  const w = await call("watch_price", { item: "6 ft hdmi cable", below: 7.99 });
  assert.ok(!w.isError);
  assert.equal(w.structuredContent.watch.below.cents, 799);
  assert.equal((await call("watch_price", { item: "hub" })).isError, true);
  assert.equal((await call("fill_carts", { run_id: "missing" })).isError, true);
  assert.equal((await call("find_and_compare", { request: "x", stores: ["costco"] })).isError, true);
});

test("stdio server answers initialize and tools/list", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", "mcp", "--demo"], {
    cwd: join(import.meta.dirname, "..", ".."),
    env: { ...process.env, OSA_HOME: dir, OSA_DEMO_SPEED: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: any[] = [];
  let buf = "";
  const got = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no reply from stdio server")), 15_000);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
      if (lines.length >= 2) { clearTimeout(t); resolve(); }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  try {
    await got;
  } finally {
    child.kill();
  }
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.protocolVersion, "2024-11-05");
  assert.equal(lines[1].result.tools.length, 7);
});

test("tool results carry the envelope: ok, v, next; errors carry code, retryable, next", async () => {
  const found = await call("find_and_compare", { request: "usb-c hub", stores: ["amazon"] });
  assert.equal(found.structuredContent.ok, true);
  assert.equal(found.structuredContent.v, 1);
  assert.ok(Array.isArray(found.structuredContent.next));
  const missing = await call("fill_carts", { run_id: "missing" });
  assert.equal(missing.isError, true);
  assert.deepEqual(Object.keys(missing.structuredContent.error).sort(), ["code", "message", "next", "retryable"]);
  assert.equal(missing.structuredContent.ok, false);
  assert.equal(missing.structuredContent.error.code, "not_found");
  assert.equal(missing.structuredContent.error.retryable, false);
  assert.equal((await call("watch_price", { item: "hub" })).structuredContent.error.code, "bad_args");
  const saved = process.env.OSA_MCP_ALLOW_ORDERS;
  delete process.env.OSA_MCP_ALLOW_ORDERS;
  try {
    assert.equal((await call("place_order", { run_id: "x", store: "amazon", approved_total: 1 })).structuredContent.error.code, "orders_disabled");
  } finally {
    if (saved !== undefined) process.env.OSA_MCP_ALLOW_ORDERS = saved;
  }
});

test("fill_carts dry_run says what each cart would get and changes nothing", async () => {
  const found = await call("find_and_compare", { request: "usb-c hub and 6 ft hdmi cable", stores: ["amazon", "walmart", "ebay"] });
  const runId = found.structuredContent.run_id;
  const dry = await call("fill_carts", { run_id: runId, dry_run: true });
  assert.ok(!dry.isError, dry.content[0].text);
  assert.match(dry.content[0].text, /DRY RUN: no cart was changed/);
  assert.equal(dry.structuredContent.dry_run, true);
  assert.ok(dry.structuredContent.carts.length >= 1);
  assert.ok(dry.structuredContent.carts.every((c: { lines: unknown[]; subtotal: { cents: number } }) => c.lines.length && c.subtotal.cents > 0));
  // Still waiting: the real fill_carts works after the dry run, and fills what the dry run said.
  const filled = await call("fill_carts", { run_id: runId });
  assert.ok(!filled.isError, filled.content[0].text);
  assert.deepEqual(filled.structuredContent.carts.map((c: { store: string }) => c.store).sort(), dry.structuredContent.carts.map((c: { store: string }) => c.store).sort());
});

test("place_order: an order the store did not confirm is order_unknown, never retried, and listed", async () => {
  const hub = new RunHub(new MockEngine({ speed: 0, signInStore: null, failStore: null, unknownStore: "amazon" }));
  const h = createMcpHandler(hub, new FileAlerts(join(dir, "w2.json")), new ConfigStore(dir), { waitMs: 10_000 });
  const c = async (name: string, args: unknown) => ((await h({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as { result: any }).result;
  process.env.OSA_MCP_ALLOW_ORDERS = "1";
  const found = await c("find_and_compare", { request: "usb-c hub", stores: ["amazon"] });
  const runId = found.structuredContent.run_id;
  await c("fill_carts", { run_id: runId });
  const reviewed = await c("review_checkout", { run_id: runId });
  const total = reviewed.structuredContent.reviews[0].total;
  assert.equal(reviewed.structuredContent.reviews[0].code, "needs_approval");
  const r = await c("place_order", { run_id: runId, store: "amazon", approved_total: total.cents / 100 });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, "order_unknown");
  assert.equal(r.structuredContent.error.retryable, false);
  assert.match(r.content[0].text, /Do not call place_order again/);
  assert.equal(r.structuredContent.data.order.state, "unknown");
  const again = await c("place_order", { run_id: runId, store: "amazon", approved_total: total.cents / 100 });
  assert.equal(again.isError, true);
  assert.match(again.structuredContent.error.code, /order_unknown|already_ordered/);
  const listed = await c("list_orders", {});
  assert.equal(listed.structuredContent.orders[0].state, "unknown");
  assert.match(listed.content[0].text, /UNKNOWN/);
  assert.ok(listed.structuredContent.next.length);
});

test("place_order is off unless OSA_MCP_ALLOW_ORDERS is set", async () => {
  assert.equal(mcpOrdersAllowed({}), false);
  assert.equal(mcpOrdersAllowed({ OSA_MCP_ALLOW_ORDERS: "0" }), false);
  assert.equal(mcpOrdersAllowed({ OSA_MCP_ALLOW_ORDERS: "1" }), true);
  assert.equal(mcpOrdersAllowed({ OSA_MCP_ALLOW_ORDERS: "on" }), true);
  const saved = process.env.OSA_MCP_ALLOW_ORDERS;
  delete process.env.OSA_MCP_ALLOW_ORDERS;
  try {
    const r = await call("place_order", { run_id: "nope", store: "amazon", approved_total: 10 });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /OSA_MCP_ALLOW_ORDERS/);
  } finally {
    if (saved !== undefined) process.env.OSA_MCP_ALLOW_ORDERS = saved;
  }
});
