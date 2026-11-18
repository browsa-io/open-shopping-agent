import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError, parseArgs, parseStores } from "../../src/cli/args.js";
import { paint, renderCompare, renderTable, truncate, visibleLength } from "../../src/cli/render.js";
import { MockEngine } from "../../src/web/mock-engine.js";
import { compareFromEvents } from "../../src/web/format.js";
import { RunHub } from "../../src/web/session.js";

test("prompt with flags", () => {
  const a = parseArgs(["usb-c hub and 6 ft hdmi", "under $60", "--stores", "amazon,best buy,shop.example.com", "--zip", "82001", "--budget", "60", "--no-cart"]);
  assert.equal(a.command, "run");
  assert.equal(a.prompt, "usb-c hub and 6 ft hdmi under $60");
  assert.deepEqual(a.stores, ["amazon", "bestbuy", "shopify"]);
  assert.deepEqual(a.shopifyDomains, ["shop.example.com"]);
  assert.equal(a.zip, "82001");
  assert.equal(a.budget?.cents, 6000);
  assert.equal(a.noCart, true);
  assert.equal(a.json, false);
});

test("--flag=value form and --json", () => {
  const a = parseArgs(["--budget=49.99", "--json", "hdmi cable"]);
  assert.equal(a.budget?.cents, 4999);
  assert.equal(a.json, true);
  assert.equal(a.prompt, "hdmi cable");
});

test("subcommands", () => {
  assert.equal(parseArgs(["runs"]).command, "runs");
  assert.equal(parseArgs(["web", "--port", "8080"]).port, 8080);
  assert.equal(parseArgs(["mcp"]).command, "mcp");
  assert.equal(parseArgs([]).command, "help");
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["-v"]).command, "version");
  // a prompt that merely starts with a subcommand word is a prompt
  assert.equal(parseArgs(["web", "camera"]).command, "run");
});

test("watch", () => {
  const w = parseArgs(["--watch", "6 ft hdmi cable", "--below", "9.99"]);
  assert.equal(w.command, "watch");
  assert.equal(w.watch, "6 ft hdmi cable");
  assert.equal(w.below?.cents, 999);
  assert.equal(parseArgs(["--watch", "hub", "--back-in-stock"]).backInStock, true);
  assert.throws(() => parseArgs(["--watch", "hub"]), CliError);
});

test("bad input is a CliError", () => {
  assert.throws(() => parseArgs(["x", "--zip", "123"]), /5-digit/);
  assert.throws(() => parseArgs(["x", "--budget", "abc"]), CliError);
  assert.throws(() => parseArgs(["x", "--stores", "costco"]), /Unknown store/);
  assert.throws(() => parseArgs(["x", "--bogus"]), /Unknown option/);
  assert.throws(() => parseArgs(["x", "--zip"]), /needs a value/);
  assert.throws(() => parseStores(""), CliError);
});

test("renderTable aligns columns and ignores ANSI in widths", () => {
  const p = paint(true);
  const out = renderTable([{ header: "Store" }, { header: "Price", align: "right" }], [[p.green("Amazon"), "$9.99"], ["eBay", "$129.00"]]);
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  const widths = lines.map(visibleLength);
  assert.equal(widths[2], widths[3], "rows line up");
  assert.ok(lines[3].endsWith("$129.00"));
  assert.ok(lines[2].endsWith("  $9.99"));
  assert.equal(truncate("abcdefgh", 5), "abcd…");
});

test("renderCompare prints the best pick first with its reason", async () => {
  const hub = new RunHub(new MockEngine({ speed: 0, failStore: null }));
  const run = hub.start("usb-c hub and 6 ft hdmi", { checkout: false, limits: { allowedStores: ["amazon", "walmart", "ebay"] } });
  await run.done;
  const items = compareFromEvents(run.events);
  assert.equal(items.length, 2);
  const text = renderCompare(items, paint(false), { width: 120, maxRows: 4 });
  assert.match(text, /^usb-c hub$/m);
  assert.match(text, /Best pick (Amazon|Walmart|eBay), \$\d+\.\d\d delivered\./);
  const firstRow = text.split("\n").find((l) => l.includes("★"));
  assert.ok(firstRow, "best row is marked");
  assert.match(text, /\+ \d+ more/);
  assert.ok(!/\x1b\[/.test(text), "no colour when disabled");
});
