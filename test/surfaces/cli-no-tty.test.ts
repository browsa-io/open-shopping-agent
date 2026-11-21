// The CLI never fills a cart, reviews a checkout or buys without a typed "y": with no terminal on
// stdin (a pipe, cron, CI) every question is answered N. Runs the real CLI entry in a child process.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

test("no terminal: every question is answered N, nothing is filled or bought", () => {
  const home = mkdtempSync(join(tmpdir(), "osa-notty-"));
  try {
    // The demo's Target search fails on purpose; leave Target out so this run has no store failure (exit 0).
    const r = spawnSync(process.execPath, ["--import", "tsx", entry, "--demo", "--stores", "amazon,walmart,ebay,bestbuy", "usb-c hub with hdmi and a 6 ft hdmi cable", "--zip", "10001"], {
      input: "y\ny\ny\ny\ny\n", // typed answers on a pipe are not read: only a terminal can say y
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, OSA_HOME: home, OSA_DEMO_SPEED: "0", NO_COLOR: "1", BROWSA_API_KEY: "", OSA_BROWSER: "" },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /Fill cart at .*\[y\/N\] n \(no terminal input\)/);
    assert.doesNotMatch(out, /Filling cart|Review checkout at|Buy for|Order placed/);
    assert.match(out, /0 orders placed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
