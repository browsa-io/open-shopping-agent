// Agent-readable CLI output: one JSON envelope per reply, fixed exit codes, --dry-run, osa orders.
// Runs the real CLI entry in a child process on demo data or a hand-made run history.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, classify, errorEnvelope, errorOf, exitCodeFor, okEnvelope, worstCode } from "../../src/cli/output.js";
import { CliError, parseArgs } from "../../src/cli/args.js";
import { LimitError } from "../../src/core/limits.js";

const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

function osa(args: string[], home: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8", timeout: 60_000, input: "",
    env: { ...process.env, OSA_HOME: home, OSA_DEMO_SPEED: "0", NO_COLOR: "1", BROWSA_API_KEY: "", OSA_BROWSER: "", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const withHome = (fn: (home: string) => void) => () => {
  const home = mkdtempSync(join(tmpdir(), "osa-json-"));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
};

test("output: envelopes and exit codes", () => {
  assert.deepEqual(okEnvelope({ a: 1 }, ["next"]), { ok: true, v: 1, data: { a: 1 }, next: ["next"] });
  const e = errorEnvelope("timeout", "Amazon took too long", ["retry"]);
  assert.deepEqual(e, { ok: false, v: 1, error: { code: "timeout", message: "Amazon took too long", retryable: true, next: ["retry"] } });
  assert.equal(exitCodeFor("bad_args"), 1);
  assert.equal(exitCodeFor("network"), 2);
  assert.equal(exitCodeFor("needs_captcha"), 3);
  assert.equal(exitCodeFor("order_unknown"), 3);
  assert.equal(exitCodeFor("approval_mismatch"), 4);
  assert.equal(EXIT.safety, 4);
  const cases: [string, string][] = [
    ["searching Amazon timed out after 180s", "timeout"],
    ["page.goto: net::ERR_TUNNEL_CONNECTION_FAILED", "network"],
    ["Walmart blocked this browser. Solve the captcha", "needs_captcha"],
    ["Amazon asks you to sign in", "needs_sign_in"],
    ["Order not placed: the approved total $40.00 does not match the review total $41.97", "approval_mismatch"],
    ["Walmart total is now $31.00, approved 30; order not placed", "total_changed"],
    ["Order not placed: the last order at this store may have gone through; check your orders on the store", "order_unknown"],
    ["Order not placed: an order was already placed for this store in this run", "already_ordered"],
    ["Placing orders from MCP is off. Set OSA_MCP_ALLOW_ORDERS=1", "orders_disabled"],
    ["Unknown or finished run_id x", "not_found"],
    ["the checkout has a membership line: Prime", "safety_refusal"],
    ["something odd", "store_error"],
  ];
  for (const [msg, code] of cases) assert.equal(classify(msg), code, msg);
  assert.equal(errorOf(new CliError("--zip needs a 5-digit ZIP")).code, "bad_args");
  assert.equal(errorOf(new LimitError("budget", "over the $10 budget")).code, "over_budget");
  assert.equal(errorOf(new LimitError("approval", "Order not placed: the approved total $1.00 does not match the review total $2.00")).code, "approval_mismatch");
  assert.equal(worstCode(["timeout", "needs_captcha", "bad_args"]), "needs_captcha");
  assert.equal(parseArgs(["--dry-run", "hub"]).dryRun, true);
  assert.equal(parseArgs(["orders"]).command, "orders");
  const r = parseArgs(["orders", "refresh", "run-20261119-100000-abc123"]);
  assert.equal(r.refresh, true);
  assert.equal(r.runId, "run-20261119-100000-abc123");
  assert.equal(parseArgs(["orders", "of", "socks"]).command, "run", "a prompt that starts with 'orders' is a prompt");
});

test("--json: one envelope with the comparison, exit 0", withHome((home) => {
  const r = osa(["--json", "--demo", "usb-c hub", "--stores", "amazon,walmart"], home);
  assert.equal(r.code, 0, r.err);
  const env = JSON.parse(r.out);
  assert.equal(env.ok, true);
  assert.equal(env.v, 1);
  assert.equal(env.data.demo, true);
  assert.equal(env.data.picks.length, 1);
  assert.ok(Array.isArray(env.next) && env.next.length);
}));

test("--json: bad arguments are an error envelope with exit 1", withHome((home) => {
  const r = osa(["--json", "hub", "--zip", "12"], home);
  assert.equal(r.code, 1);
  const env = JSON.parse(r.out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "bad_args");
  assert.equal(env.error.retryable, false);
  assert.match(env.error.message, /5-digit/);
  assert.equal(osa(["hub", "--bogus"], home).code, 1, "user errors exit 1 without --json too");
}));

test("--dry-run: shows each cart's lines and fills nothing", withHome((home) => {
  const r = osa(["--dry-run", "--demo", "usb-c hub and a 6 ft hdmi cable", "--stores", "amazon,walmart,ebay"], home);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Dry run: no cart was changed/);
  assert.doesNotMatch(r.out, /Fill cart at|Filling cart|cart, read back/);
  const j = osa(["--dry-run", "--json", "--demo", "usb-c hub", "--stores", "amazon"], home);
  const env = JSON.parse(j.out);
  assert.equal(env.data.dryRun, true);
  assert.equal(env.data.carts.length, 1);
  assert.ok(env.data.carts[0].lines[0].quantity >= 1);
  const over = osa(["--dry-run", "--json", "--demo", "--budget", "1", "usb-c hub", "--stores", "amazon"], home);
  assert.equal(over.code, 4);
  assert.equal(JSON.parse(over.out).error.code, "over_budget");
}));

function seedHistory(home: string) {
  const runId = "run-20261119-100000-abc123";
  const dir = join(home, "runs", runId);
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  const usd = (c: number) => ({ cents: c, currency: "USD" });
  const ev = [
    { type: "parsed", request: { prompt: "usb-c hub and hdmi cable", items: [], stores: ["amazon", "walmart"] } },
    { type: "order_state", store: "amazon", state: "proposed", at: "2026-11-19T10:01:00.000Z" },
    { type: "order_state", store: "amazon", state: "awaiting_approval", at: "2026-11-19T10:01:01.000Z" },
    { type: "order_state", store: "amazon", state: "placing", at: "2026-11-19T10:02:00.000Z", total: usd(3209) },
    { type: "order_state", store: "amazon", state: "placed", at: "2026-11-19T10:02:30.000Z", orderId: "111-2222222-3333333", orderUrl: "https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333", total: usd(3209) },
    { type: "order", result: { store: "amazon", placed: true, state: "placed", orderId: "111-2222222-3333333", total: usd(3209), placedAt: "2026-11-19T10:02:30.000Z", orderUrl: "https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333" } },
    { type: "order_state", store: "walmart", state: "placing", at: "2026-11-19T10:03:00.000Z", total: usd(5318) },
    { type: "order_state", store: "walmart", state: "unknown", at: "2026-11-19T10:04:00.000Z", total: usd(5318), message: "Walmart may have taken this order, but no order number was confirmed. Check your orders on Walmart (https://www.walmart.com/orders) before you try again." },
    { type: "done", summary: { runId, startedAt: "2026-11-19T10:00:00.000Z", finishedAt: "2026-11-19T10:05:00.000Z", picks: [], carts: [], reviews: [], orders: [], failures: [] } },
  ];
  writeFileSync(join(dir, "events.jsonl"), ev.map((e) => JSON.stringify({ at: "2026-11-19T10:00:00.000Z", ...e })).join("\n") + "\n");
  writeFileSync(join(dir, "request.json"), JSON.stringify(ev[0].request));
  writeFileSync(join(dir, "summary.json"), JSON.stringify((ev.at(-1) as { summary: unknown }).summary));
  writeFileSync(join(dir, "tracking.json"), JSON.stringify({ amazon: { status: "Shipped", carrier: "UPS", trackingNumber: "1Z999AA10123456784", checkedAt: "2026-11-20T08:00:00.000Z" } }));
  return runId;
}

test("osa orders: placed and unknown orders from the run history, with tracking", withHome((home) => {
  const runId = seedHistory(home);
  const j = osa(["orders", "--json"], home);
  assert.equal(j.code, 0, j.err);
  const env = JSON.parse(j.out);
  assert.equal(env.ok, true);
  const [walmart, amazon] = env.data.orders;
  assert.equal(walmart.state, "unknown");
  assert.equal(walmart.ordersUrl, "https://www.walmart.com/orders");
  assert.equal(amazon.state, "placed");
  assert.equal(amazon.orderId, "111-2222222-3333333");
  assert.equal(amazon.total.cents, 3209);
  assert.equal(amazon.runId, runId);
  assert.equal(amazon.tracking.carrier, "UPS");
  assert.ok(env.next.some((n: string) => /Check your orders on Walmart/.test(n)));
  const h = osa(["orders"], home);
  assert.equal(h.code, 0, h.err);
  assert.match(h.out, /Walmart\s+CHECK STORE/);
  assert.match(h.out, /Check your orders on Walmart/);
  assert.match(h.out, /Amazon\s+placed\s+111-2222222-3333333/);
  assert.match(h.out, /Shipped, UPS 1Z999AA10123456784/);
}));

test("osa orders refresh without a browser says what it needs (exit 1)", withHome((home) => {
  seedHistory(home);
  const r = osa(["orders", "refresh", "--json"], home, { OSA_DEMO: "1" });
  // OSA_DEMO forces the demo engine: no browser to read the store's pages with.
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.out).error.message, /needs a browser/);
}));
