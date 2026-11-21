// 0.2.1: what the CLI says and returns has to match what happened.
//   - a run with a store failure does not exit 0
//   - no browser set up: stop and say what to set; demo data only with --demo (or OSA_DEMO=1)
//   - a store that blocked the browser is reported as a block, in the README table's words
// Runs the real CLI entry in a child process on demo data. No store is contacted.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, runExitCode } from "../../src/cli/output.js";
import { HELP } from "../../src/cli/args.js";
import { NoBrowserError, createEngine, noBrowserReason } from "../../src/web/engine-factory.js";
import { blockWords, friendlyError, isBlock } from "../../web/lib/wording.js";

const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

function osa(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "osa-honest-"));
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
      encoding: "utf8", timeout: 60_000, input: "",
      env: { ...process.env, OSA_HOME: home, OSA_DEMO_SPEED: "0", NO_COLOR: "1", BROWSA_API_KEY: "", OSA_BROWSER: "", OSA_DEMO: "", OSA_CDP_URL: "", ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("runExitCode: a store failure is never exit 0", () => {
  assert.equal(runExitCode({ failures: [], unknownOrders: 0 }), EXIT.ok);
  assert.equal(runExitCode({ failures: [{ error: "eBay refused the page twice (Error Page, status 403)" }], unknownOrders: 0 }), EXIT.retry);
  assert.equal(runExitCode({ failures: [{ error: "searching Amazon timed out after 180s" }], unknownOrders: 0 }), EXIT.retry);
  assert.equal(runExitCode({ failures: [{ error: "something odd" }], unknownOrders: 0 }), EXIT.retry);
  // a bot check or a sign-in is for the person
  assert.equal(runExitCode({ failures: [{ error: "Walmart shows a bot check that did not clear on this browser" }], unknownOrders: 0 }), EXIT.needsUser);
  assert.equal(runExitCode({ failures: [{ error: "status 403" }, { error: "Amazon asks you to sign in" }], unknownOrders: 0 }), EXIT.needsUser);
  // a safety refusal
  assert.equal(runExitCode({ failures: [{ error: "Target is not in the allowed stores" }], unknownOrders: 0 }), EXIT.safety);
  // an order that may have gone through comes first
  assert.equal(runExitCode({ failures: [{ error: "status 403" }], unknownOrders: 1 }), EXIT.needsUser);
});

test("CLI: a run with a store failure exits 2 and says which store; without one it exits 0", () => {
  // The demo's Target search fails on purpose.
  const bad = osa(["--demo", "--no-cart", "usb-c hub with hdmi"]);
  assert.equal(bad.code, 2, bad.err);
  assert.match(bad.out, /1 store failure/);
  assert.match(bad.err, /Exit code 2: Target did not finish its search\./);
  const good = osa(["--demo", "--no-cart", "--stores", "amazon,walmart", "usb-c hub with hdmi"]);
  assert.equal(good.code, 0, good.err);
  assert.match(good.out, /0 store failures/);
  assert.doesNotMatch(good.err, /Exit code/);
});

test("CLI --json: a partial run keeps its picks, lists the failure, and exits with the failure's code", () => {
  const r = osa(["--demo", "--json", "usb-c hub with hdmi"]);
  assert.equal(r.code, 2);
  const env = JSON.parse(r.out);
  assert.equal(env.ok, true);
  assert.equal(env.data.partial, true);
  assert.equal(env.data.failures.length, 1);
  assert.ok(env.data.picks.length > 0);
  const full = osa(["--demo", "--json", "--stores", "amazon,walmart", "usb-c hub with hdmi"]);
  assert.equal(full.code, 0);
  assert.equal(JSON.parse(full.out).data.partial, false);
});

test("--browser browsa without a key stops with what to set; never demo data", () => {
  const r = osa(["--browser", "browsa", "usb-c hub with hdmi"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /set BROWSA_API_KEY, or use --browser local \(your own Chrome\), or pass --demo/);
  assert.doesNotMatch(r.out + r.err, /Demo data|Best pick|Looking for/);
  assert.equal(r.out, "");
  // the same as one JSON envelope
  const j = osa(["--browser", "browsa", "--json", "usb-c hub with hdmi"]);
  assert.equal(j.code, 1);
  const e = JSON.parse(j.out);
  assert.equal(e.ok, false);
  assert.equal(e.error.code, "setup_needed");
  assert.match(e.error.message, /BROWSA_API_KEY/);
  // OSA_BROWSER=browsa is the same choice
  assert.equal(osa(["usb-c hub with hdmi"], { OSA_BROWSER: "browsa" }).code, 1);
  // cdp without an address
  const c = osa(["--browser", "cdp", "usb-c hub with hdmi"]);
  assert.equal(c.code, 1);
  assert.match(c.err, /set OSA_CDP_URL, or use --browser local/);
});

test("demo data only when asked for: --demo and OSA_DEMO=1 show the banner", () => {
  for (const r of [osa(["--demo", "--no-cart", "--stores", "amazon", "usb-c hub"]), osa(["--no-cart", "--stores", "amazon", "usb-c hub"], { OSA_DEMO: "1" }), osa(["--demo", "--browser", "browsa", "--no-cart", "--stores", "amazon", "usb-c hub"])]) {
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Demo data: made-up products and prices/);
  }
});

test("engine factory: strict never returns the demo engine unasked", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.OSA_DEMO; delete process.env.OSA_BROWSER; delete process.env.OSA_CDP_URL;
    const cfg = { allowedStores: [] } as never;
    assert.match(noBrowserReason(cfg, { browser: "browsa" }) ?? "", /Browsa cloud browsers need a key/);
    await assert.rejects(createEngine(cfg, { browser: "browsa", strict: true }), (e: unknown) => e instanceof NoBrowserError && /BROWSA_API_KEY/.test((e as Error).message));
    assert.equal(noBrowserReason(cfg, { browser: "browsa", demo: true }), undefined);
    assert.equal((await createEngine(cfg, { browser: "browsa", demo: true, strict: true, speed: 0 })).demo, true);
    // not strict (the web app): the demo engine still opens, and the reason is there to show
    assert.equal((await createEngine(cfg, { browser: "browsa", speed: 0 })).demo, true);
  } finally {
    process.env = saved;
  }
});

test("a block is reported as a block, in the words of the README's per-browser table", () => {
  const e403 = "eBay refused the page twice (Error Page, status 403) at https://www.ebay.com/sch/i.html?_nkw=x";
  assert.equal(isBlock(e403), true);
  assert.equal(blockWords(e403, "search"), "blocked at search (403)");
  assert.equal(blockWords("Walmart shows a bot check that did not clear on this browser", "cart"), "blocked at the cart (bot check)");
  assert.equal(blockWords("Walmart shows a bot check that did not clear on this browser", "search"), "blocked at search (bot check)");
  assert.equal(blockWords("Best Buy refused the browser", "product"), "blocked at the product page (page refused)");
  assert.equal(isBlock("searching Amazon timed out after 180s"), false);
  // the README table uses exactly these words
  for (const words of ["blocked at search (403)", "blocked at the cart (bot check)", "blocked at search (bot check)"]) {
    assert.ok(README.includes(words), `README per-browser table says "${words}"`);
  }
  const f = friendlyError(e403, "search", "ebay");
  assert.equal(f.title, "Blocked at search (403)");
  assert.doesNotMatch(f.title + f.hint, /nothing found/i);
  assert.equal(friendlyError("Walmart shows a bot check that did not clear on this browser", "search", "walmart").title, "Blocked at search (bot check)");
});

test("CLI: a store that refused the search prints the block, not \"Nothing found\"", () => {
  const r = osa(["--demo", "--no-cart", "--stores", "amazon,ebay", "6 ft usb-c cable under $15"], { OSA_DEMO_BLOCK_STORE: "ebay" });
  assert.equal(r.code, 2, r.err);
  assert.match(r.out, /eBay: Blocked at search \(403\)\./);
  assert.doesNotMatch(r.out, /eBay: Nothing found/);
  assert.doesNotMatch(r.out, /eBay: Found/);
  assert.match(r.err, /Exit code 2: eBay blocked at search \(403\)\./);
  assert.match(r.out, /Amazon: Found \d+ offers?/);
});

test("help and README agree on the exit codes and on demo data", () => {
  assert.match(HELP, /2 a store or the network failed or blocked the browser, also when other stores gave results/);
  assert.match(HELP, /browsa without BROWSA_API_KEY stops with an error/);
  assert.match(README, /\| 2 \| a store or the network failed or blocked the browser, also when other stores gave results/);
  assert.match(README, /`setup_needed`/);
});
