// 0.2.1, releases: the changelog has notes for every published version, the release-notes script
// reads them, the publish workflow uses npm trusted publishing and the Actions bot, and the default
// test suite launches no browser.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error a plain .mjs script without types
import { dateFor, notesFor } from "../../scripts/release-notes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (f: string) => readFileSync(join(root, f), "utf8");
const changelog = read("CHANGELOG.md");

test("the changelog covers every version on npm, newest first, with a date", () => {
  const heads = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, ["0.2.1", "0.2.0", "0.1.1", "0.1.0"]);
  for (const v of heads) {
    const notes: string = notesFor(changelog, v);
    assert.ok(notes && notes.length > 200, `notes for ${v}`);
    assert.doesNotMatch(notes, /^## \[/m, "one version's notes only");
    assert.doesNotMatch(notes, /^\[\d/m, "no link list");
    assert.match(dateFor(changelog, v), /^2026-11-\d\d$/);
  }
  // 0.1.2 was never published: no section, but the changelog says what happened to it
  assert.equal(notesFor(changelog, "0.1.2"), undefined);
  assert.match(changelog, /0\.1\.2 was prepared for the MCP registry but never published/);
  assert.equal(notesFor(changelog, "v0.2.1"), notesFor(changelog, "0.2.1"));
  assert.match(notesFor(changelog, "0.2.1"), /A run with a store failure no longer exits 0/);
  assert.match(notesFor(changelog, "0.1.1"), /never read as dollars/);
});

test("release-notes script: prints the notes, exits 1 with a clear message for an unknown version", () => {
  const ok = spawnSync(process.execPath, [join(root, "scripts/release-notes.mjs"), "0.2.0"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /Buy without asking/);
  const bad = spawnSync(process.execPath, [join(root, "scripts/release-notes.mjs"), "9.9.9"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /CHANGELOG\.md has no section "## \[9\.9\.9\]"/);
  assert.equal(bad.stdout, "");
});

test("publish workflow: tag v*, provenance through OIDC, a fast clear stop without a trusted publisher, Release by the Actions bot", () => {
  const wf = read(".github/workflows/publish.yml");
  assert.match(wf, /tags:\n\s+- 'v\*'/);
  assert.match(wf, /id-token: write/);
  assert.match(wf, /npm publish --provenance --access public/);
  // no long-lived npm token anywhere
  assert.doesNotMatch(wf, /NPM_TOKEN\s*:|NODE_AUTH_TOKEN|secrets\.NPM/);
  // the trusted publisher check runs before anything is installed or built, and names the form values
  const check = wf.indexOf("Check that npm trusts this workflow");
  assert.ok(check > 0 && check < wf.indexOf("- run: npm ci"), "the check comes before npm ci");
  assert.match(wf, /npm trusted publisher is not configured/);
  for (const v of ['Organization or user "browsa-io"', 'Repository "open-shopping-agent"', 'Workflow filename "publish.yml"', "Environment name empty"]) assert.ok(wf.includes(v), v);
  // the tag must match the version, the version must be new, and the changelog must have its notes
  assert.match(wf, /does not match package\.json version/);
  assert.match(wf, /is already on npm/);
  assert.match(wf, /node scripts\/release-notes\.mjs "\$\{version\}"/);
  // the Release: after the publish, with the workflow's own token (author github-actions[bot])
  const release = wf.slice(wf.indexOf("\n  release:"));
  assert.match(release, /needs: publish/);
  assert.match(release, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(release, /gh release create "v\$VERSION" --verify-tag --title "v\$VERSION" --notes-file notes\.md/);
  assert.doesNotMatch(wf, /secrets\.(GH|GITHUB)_?(PAT|TOKEN)|personal access/i);
  // the backfill workflow never publishes and never creates a tag
  const back = read(".github/workflows/release-notes.yml");
  assert.doesNotMatch(back, /npm publish|git tag|git push/);
  assert.match(back, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test("the package ships the changelog; the export keeps the workflows and the notes script", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.files.includes("CHANGELOG.md"));
  // The export script itself is not part of the public tree, so it is only checked where it exists.
  if (existsSync(join(root, "scripts/export-public.sh"))) {
    const exp = read("scripts/export-public.sh");
    assert.doesNotMatch(exp, /--exclude[ =]'?\.github\/workflows|--exclude[ =]'?CHANGELOG|--exclude[ =]'?scripts\/release-notes/);
  }
  for (const f of ["CHANGELOG.md", "scripts/release-notes.mjs", ".github/workflows/publish.yml"]) assert.ok(existsSync(join(root, f)), f);
});

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "fixtures" ? [] : testFiles(p);
    return /\.ts$/.test(f) ? [p] : [];
  });
}

test("the default suite launches no browser: only test/browser does, and npm test leaves it out", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.test, /-not -name '\*\.browser\.test\.ts'/);
  assert.match(pkg.scripts["test:browser"], /test\/browser\/\*\.browser\.test\.ts/);
  assert.match(pkg.scripts["test:browser"], /--test-force-exit/);
  const launches = /chromium\.launch\(|launchPersistentContext\(|new LocalProvider\(|findChrome\(\)/;
  const offenders = testFiles(join(root, "test"))
    .filter((p) => !p.includes(`${join("test", "browser")}`) && !/\.live\.test\.ts$|live-harness\.ts$/.test(p) && !p.endsWith(join("surfaces", "release.test.ts")))
    .filter((p) => launches.test(readFileSync(p, "utf8")));
  assert.deepEqual(offenders.map((p) => p.slice(root.length)), []);
  for (const f of readdirSync(join(root, "test/browser"))) assert.match(f, /\.browser\.test\.ts$/);
  // the browser suite has a launch timeout, a per-test timeout and a cleanup that cannot hang
  const suite = read("test/browser/providers-chrome.browser.test.ts");
  assert.match(suite, /timeout: LAUNCH_MS/);
  assert.equal((suite.match(/\{ skip, timeout: TEST_MS \}/g) ?? []).length, 5);
  assert.match(suite, /after\(async \(\) =>/);
  // CI: the unit job runs npm test, and a separate job runs the browser suite on a runner with Chrome
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /\n  browser:\n/);
  assert.match(ci, /OSA_REQUIRE_CHROME: "1"/);
  assert.match(ci, /run: npm run test:browser/);
  assert.match(ci, /run: npm test\n/);
  assert.doesNotMatch(ci, /find test -name/);
  // CONTRIBUTING describes both suites
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /`npm test`\*\*, the default suite\. It needs no network, no browser and no Browsa key, and it never launches Chrome/);
  assert.match(contributing, /`npm run test:browser`\*\*, the browser suite/);
});
