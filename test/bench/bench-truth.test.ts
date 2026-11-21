// 0.2.1, bench truth: the results file the README links and the README sentence say the same
// thing, a merged file names its runs, and a dry run cannot be read as numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeResults, renderTable, BENCH_START, BENCH_END, type BenchResults, type StoreResult } from "../../bench/lib.js";
import { DRY_RUN_NOTICE } from "../../bench/run.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const json = <T>(f: string) => JSON.parse(read(f)) as T;

const ran = (store: StoreResult["store"], credits: number, date: string): StoreResult => ({ store, status: "ran", tasks: [], ms: 1, credits, date });
const skipped = (store: StoreResult["store"]): StoreResult => ({ store, status: "skipped", note: "not selected", tasks: [], ms: 0 });

test("mergeResults: a later run of some stores gives a file that names both runs and both credit figures", () => {
  const first: BenchResults = {
    date: "2026-11-18", startedAt: "2026-11-18T16:00:00.000Z", finishedAt: "2026-11-18T16:20:00.000Z", creditsUsed: 13, maxCredits: 40,
    stores: [ran("amazon", 6, "2026-11-18"), ran("ebay", 4, "2026-11-18"), ran("shopify", 3, "2026-11-18")],
  };
  const second: BenchResults = {
    date: "2026-11-18", startedAt: "2026-11-18T17:00:00.000Z", finishedAt: "2026-11-18T17:05:00.000Z", creditsUsed: 2, maxCredits: 15,
    stores: [skipped("amazon"), ran("ebay", 1, "2026-11-18"), ran("shopify", 1, "2026-11-18")],
  };
  const m = mergeResults(first, second);
  // the top level is about the stores shown, not about the last run alone
  assert.equal(m.creditsUsed, 6 + 1 + 1);
  assert.equal(m.creditsAllRuns, 15);
  assert.equal(m.maxCredits, undefined);
  assert.equal(m.startedAt, first.startedAt);
  assert.deepEqual(m.runs?.map((r) => [r.startedAt, r.creditsUsed, r.stores]), [
    [first.startedAt, 13, ["amazon"]],
    [second.startedAt, 2, ["ebay", "shopify"]],
  ]);
  assert.deepEqual(m.stores.map((s) => s.run), [first.startedAt, second.startedAt, second.startedAt]);
  const table = renderTable(m);
  assert.match(table, /in 2 runs \(eBay and Shopify stores \(named by domain\) were run again\)/);
  assert.match(table, /8 Browsa credits for the results shown, 15 for the 2 runs in all/);

  // a third run of everything replaces all of it: one run again, its own figure, no "runs"
  const third: BenchResults = {
    date: "2026-11-19", startedAt: "2026-11-19T09:00:00.000Z", finishedAt: "2026-11-19T09:20:00.000Z", creditsUsed: 12,
    stores: [ran("amazon", 5, "2026-11-19"), ran("ebay", 4, "2026-11-19"), ran("shopify", 3, "2026-11-19")],
  };
  const all = mergeResults(m, third);
  assert.equal(all.creditsUsed, 12);
  assert.equal(all.runs, undefined);
  assert.equal(all.creditsAllRuns, undefined);
  assert.ok(all.stores.every((s) => s.run === undefined));
  assert.match(renderTable(all), /by \[the bench\]\(bench\/\), stopped before buying \(\[results\]\(bench\/results\/latest\.json\), 12 Browsa credits\)/);

  // a fourth run of one store keeps the third's other stores and drops the runs no result comes from
  const fourth: BenchResults = { date: "2026-11-20", startedAt: "2026-11-20T09:00:00.000Z", finishedAt: "2026-11-20T09:03:00.000Z", creditsUsed: 1, stores: [skipped("amazon"), ran("ebay", 1, "2026-11-20"), skipped("shopify")] };
  const again = mergeResults(all, fourth);
  assert.deepEqual(again.runs?.map((r) => r.startedAt), [third.startedAt, fourth.startedAt]);
  assert.equal(again.creditsUsed, 5 + 1 + 3);
  assert.equal(again.creditsAllRuns, 13);
});

test("the committed latest.json, its run files and the README sentence agree", () => {
  const latest = json<BenchResults>("bench/results/latest.json");
  const shown = latest.stores.filter((s) => s.status === "ran");
  const sum = shown.reduce((n, s) => n + (s.credits ?? 0), 0);
  assert.equal(latest.creditsUsed, sum, "top-level creditsUsed is the sum of the store results shown");

  // every run it names is a real file in bench/results with the same figure and the same store results
  const files = ["2026-11-18.json", "2026-11-18-170958.json"].map((f) => json<BenchResults>(`bench/results/${f}`));
  assert.ok(latest.runs && latest.runs.length === 2);
  for (const r of latest.runs) {
    const file = files.find((f) => f.startedAt === r.startedAt);
    assert.ok(file, `a results file for the run started ${r.startedAt}`);
    assert.equal(file.creditsUsed, r.creditsUsed);
    for (const id of r.stores) {
      const { run: _run, ...mine } = latest.stores.find((s) => s.store === id)!;
      assert.deepEqual(mine, file.stores.find((s) => s.store === id), `${id} is that run's recorded result`);
    }
  }
  assert.equal(latest.creditsAllRuns, latest.runs.reduce((n, r) => n + (r.creditsUsed ?? 0), 0));

  // the README says exactly these figures, and its table is what the file renders to
  const readme = read("README.md");
  const block = readme.slice(readme.indexOf(BENCH_START) + BENCH_START.length, readme.indexOf(BENCH_END)).trim();
  assert.equal(block, renderTable(latest).trim());
  assert.match(block, new RegExp(`\\(\\[results\\]\\(bench/results/latest\\.json\\), ${latest.creditsUsed} Browsa credits for the results shown, ${latest.creditsAllRuns} for the 2 runs in all\\)`));
  assert.match(readme, /The first ran all six stores \(13 credits\)\. eBay and the Shopify stores were then run again \(2 credits\)/);
  assert.equal(files[0].creditsUsed, 13);
  assert.equal(files[1].creditsUsed, 2);
});

test("a dry run says DRY RUN, NO NUMBERS and writes nothing", () => {
  const before = read("bench/results/latest.json");
  const out = execFileSync(process.execPath, ["--import", "tsx", join(root, "bench/run.ts"), "--dry-run"], { cwd: root, encoding: "utf8", env: { ...process.env, BROWSA_API_KEY: "" } });
  assert.ok(out.includes(DRY_RUN_NOTICE));
  assert.match(DRY_RUN_NOTICE, /^DRY RUN, NO NUMBERS/);
  assert.equal(read("bench/results/latest.json"), before);
  // no key and no --dry-run is a dry run too, and says so
  const noKey = execFileSync(process.execPath, ["--import", "tsx", join(root, "bench/run.ts")], { cwd: root, encoding: "utf8", env: { ...process.env, BROWSA_API_KEY: "" } });
  assert.ok(noKey.includes(DRY_RUN_NOTICE));
  assert.equal(read("bench/results/latest.json"), before);
});

test("the bench workflow: a run without the secret is named a dry run, and the secret is documented", () => {
  const wf = read(".github/workflows/bench.yml");
  assert.match(wf, /^name: bench \(dry run unless BROWSA_API_KEY is set\)$/m);
  assert.match(wf, /name: DRY RUN, no numbers \(no BROWSA_API_KEY secret\)/);
  assert.match(wf, /name: REAL RUN on Phantom \(results committed\)/);
  assert.match(wf, /GITHUB_STEP_SUMMARY/);
  // the dry-run job cannot commit: only the real job has write access
  const dry = wf.slice(wf.indexOf("  dry-run:"), wf.indexOf("  real:"));
  assert.doesNotMatch(dry, /contents: write|git push|git commit/);
  assert.match(read("bench/README.md"), /add the repository secret `BROWSA_API_KEY`/);
  assert.match(read("bench/README.md"), /Expect 15 to 40 credits a day/);
  // the README has no bench badge while the workflow can only do a dry run
  assert.doesNotMatch(read("README.md"), /actions\/workflows\/bench\.yml\/badge\.svg/);
});
