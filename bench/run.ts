// The bench: run fixed shopping tasks on every installed store adapter and record what passed.
//
//   npm run bench                      all stores, all tasks (needs BROWSA_API_KEY)
//   npm run bench -- --stores amazon,ebay --tasks 3 --max-credits 20
//   npm run bench -- --dry-run         check tasks.json and which adapters are installed, no browser
//
// Stages: search, details (product page), cart (add and read back), checkout (reach the sign-in,
// guest or review page). It never places an order: placeOrder is blocked here, and the checkout
// stage stops at the first page that asks who you are or at the review page.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import type { StoreAdapter, StoreContext } from "../src/stores/adapter.js";
import type { ItemRequest, Offer, StoreId } from "../src/core/types.js";
import { defaultLoader, type AdapterLoader } from "./adapters.js";
import { benchMeter, browsaClient, browsaFactory, type ContextFactory } from "./browser.js";
import {
  judgeCart, judgeCheckout, judgeDetails, judgeSearch, loadTasks, mergeResults, pickForCart, updateReadme, STORE_IDS,
  type BenchResults, type BenchStage, type StageResult, type StoreResult, type TaskFile, type TaskResult,
} from "./lib.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Printed by every dry run (and shown in the bench workflow's summary). */
export const DRY_RUN_NOTICE = "DRY RUN, NO NUMBERS: checked bench/tasks.json and that every store adapter loads. No browser was opened, no store was contacted, no result file or README table was written.";

export interface RunOptions {
  tasks: TaskFile;
  loader: AdapterLoader;
  factory?: ContextFactory;            // undefined = dry run
  stores?: StoreId[];
  maxTasksPerStore?: number;
  stages?: BenchStage[];
  maxCredits?: number;
  /**
   * Credits this bench run has used so far: only its own browsers and AI tasks (the CreditMeter
   * of src/core/credits.ts), never the account's balance, so other runs on the account do not count.
   * `exact` false means part of it is estimated from browser time.
   */
  credits?: () => Promise<{ credits: number; exact: boolean } | number | undefined>;
  /** Waits for late data charges (residential exit) before the final figure. */
  settle?: () => Promise<void>;
  stageTimeoutMs?: number;
  /** Set by runBench: true once the credit cap is reached. */
  overCap?: () => Promise<boolean>;
  log?: (m: string) => void;
  now?: () => Date;
}

/** Wrap an adapter so the bench can never place an order, whatever the adapter does. */
export function guard(adapter: StoreAdapter): StoreAdapter {
  return {
    ...adapter,
    placeOrder: async () => { throw new Error("placeOrder is blocked in the bench"); },
  } as StoreAdapter;
}

async function timed<T>(ms: number, fn: () => Promise<T>): Promise<{ value?: T; error?: string; ms: number }> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms); }),
    ]);
    return { value, ms: Date.now() - t0 };
  } catch (e) {
    return { error: ((e as Error).message || String(e)).split("\n")[0].slice(0, 200), ms: Date.now() - t0 };
  } finally { if (timer) clearTimeout(timer); }
}

async function runStoreTasks(adapter: StoreAdapter, ctx: StoreContext, tasks: TaskFile["stores"][number]["tasks"], o: RunOptions & { searchLimit: number }): Promise<TaskResult[]> {
  const timeout = o.stageTimeoutMs ?? 120_000;
  const want = (s: BenchStage) => !o.stages || o.stages.includes(s);
  const results: TaskResult[] = [];
  for (const task of tasks) {
    if (o.overCap && (await o.overCap())) { o.log?.(`  credit cap reached, ${tasks.length - results.length} task(s) not run`); break; }
    const r: TaskResult = { id: task.id, query: task.query, stages: {} };
    results.push(r);
    const item: ItemRequest = { id: "item-1", query: task.query, description: task.query, quantity: 1 };
    const set = (s: BenchStage, x: StageResult) => { r.stages[s] = x; o.log?.(`  ${task.id} ${s}: ${x.pass ? "pass" : "FAIL"} ${x.ms} ms${x.note ? ` (${x.note})` : ""}`); };

    const taskCtx = task.domain ? { ...ctx, domain: task.domain } : ctx;
    const s = await timed(timeout, () => adapter.search(taskCtx, item, o.searchLimit));
    const offers: Offer[] = s.value ?? [];
    set("search", s.error ? { pass: false, ms: s.ms, note: s.error } : { ms: s.ms, ...judgeSearch(offers, task.expect) });
    const pick = pickForCart(offers);

    if (task.stages.includes("details") && want("details")) {
      if (!adapter.details) set("details", { pass: false, ms: 0, note: "adapter has no details()" });
      else if (!pick) set("details", { pass: false, ms: 0, note: "no in-stock offer to open" });
      else {
        const d = await timed(timeout, () => adapter.details!(taskCtx, pick));
        set("details", d.error ? { pass: false, ms: d.ms, note: d.error } : { ms: d.ms, ...judgeDetails(pick, d.value!, task.requireDelivery) });
      }
    }

    let touched = false; // the cart may hold something: clear it afterwards
    let carted = false;  // the cart stage passed
    if (task.stages.includes("cart") && want("cart")) {
      if (!pick) set("cart", { pass: false, ms: 0, note: "no in-stock offer to add" });
      else {
        touched = true;
        const c = await timed(timeout, async () => {
          const added = await adapter.addToCart(taskCtx, pick, 1);
          const back = await adapter.readCart(taskCtx);
          return judgeCart(pick, added, back);
        });
        set("cart", c.error ? { pass: false, ms: c.ms, note: c.error } : { ms: c.ms, ...c.value! });
        carted = !c.error && !!c.value?.pass;
      }
    }

    if (task.stages.includes("checkout") && want("checkout")) {
      if (!carted) set("checkout", { pass: false, ms: 0, note: "the cart stage did not pass" });
      else {
        const k = await timed(timeout, () => adapter.reviewCheckout(taskCtx));
        set("checkout", k.error ? { pass: false, ms: k.ms, note: k.error } : { ms: k.ms, ...judgeCheckout(k.value!) });
      }
    }

    if (touched && adapter.clearCart) {
      const c = await timed(timeout, () => adapter.clearCart!(taskCtx));
      if (c.error) o.log?.(`  ${task.id}: clear cart failed: ${c.error}`);
    }
  }
  return results;
}

export async function runBench(o: RunOptions): Promise<BenchResults> {
  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results: BenchResults = { date: startedAt.slice(0, 10), startedAt, finishedAt: startedAt, stores: [] };
  if (o.maxCredits !== undefined) results.maxCredits = o.maxCredits;
  let estimated = false;
  const used = async () => {
    const r = await o.credits?.().catch(() => undefined);
    if (r === undefined) return undefined;
    if (typeof r === "number") return r;
    if (!r.exact) estimated = true;
    return r.credits;
  };
  const overCap = async () => {
    if (o.maxCredits === undefined) return false;
    const u = await used();
    return u !== undefined && u >= o.maxCredits;
  };

  for (const entry of o.tasks.stores) {
    const t0 = Date.now();
    const sr: StoreResult = { store: entry.store, status: "skipped", tasks: [], ms: 0 };
    results.stores.push(sr);
    if (o.stores && !o.stores.includes(entry.store)) { sr.note = "not selected"; continue; }
    if (results.stopped) { sr.note = results.stopped; continue; }

    let adapter: StoreAdapter | undefined;
    try { adapter = await o.loader(entry.store); } catch (e) { sr.note = `load failed: ${(e as Error).message}`; }
    if (!adapter) { sr.status = "not_installed"; sr.note ??= "not installed"; o.log?.(`${entry.store}: not installed`); continue; }
    if (!o.factory) { sr.note = "dry run"; o.log?.(`${entry.store}: installed (dry run)`); continue; }

    const before = await used();
    const ac = new AbortController();
    let opened: Awaited<ReturnType<ContextFactory>> | undefined;
    try {
      o.log?.(`${entry.store}: opening a Phantom browser`);
      opened = await o.factory(entry.store, entry.domain, { zip: o.tasks.zip, log: (m) => o.log?.(m), signal: ac.signal });
      const tasks = entry.tasks.slice(0, o.maxTasksPerStore ?? entry.tasks.length);
      sr.tasks = await runStoreTasks(guard(adapter), opened.ctx, tasks, { ...o, overCap, searchLimit: o.tasks.searchLimit ?? 10 });
      sr.status = "ran";
      sr.date = results.date;
    } catch (e) {
      sr.status = "error";
      sr.note = ((e as Error).message || String(e)).slice(0, 200);
      o.log?.(`${entry.store}: ${sr.note}`);
    } finally {
      ac.abort();
      await opened?.close().catch(() => undefined);
    }
    sr.ms = Date.now() - t0;
    const after = await used();
    if (before !== undefined && after !== undefined) sr.credits = after - before;
    if (o.maxCredits !== undefined && after !== undefined && after >= o.maxCredits) {
      results.stopped = `stopped at the credit cap (${after} of ${o.maxCredits})`;
    }
  }

  await o.settle?.().catch(() => undefined);
  estimated = false;
  const total = await used();
  if (total !== undefined) {
    results.creditsUsed = total;
    if (estimated) results.creditsEstimated = true;
  }
  results.finishedAt = now().toISOString();
  return results;
}

function gitCommit(): string | undefined {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim(); } catch { return undefined; }
}

async function main() {
  const { values } = parseArgs({
    options: {
      stores: { type: "string" }, tasks: { type: "string" }, stages: { type: "string" },
      "max-credits": { type: "string" }, "dry-run": { type: "boolean" }, "no-ai": { type: "boolean" },
      "no-readme": { type: "boolean" }, file: { type: "string" }, out: { type: "string" },
    },
  });
  const tasks = await loadTasks(values.file ?? join(here, "tasks.json"));
  const stores = values.stores ? (values.stores.split(",").map((s) => s.trim()) as StoreId[]) : undefined;
  for (const s of stores ?? []) if (!STORE_IDS.includes(s)) throw new Error(`unknown store "${s}"`);
  const apiKey = process.env.BROWSA_API_KEY;
  const dry = values["dry-run"] || !apiKey;
  if (!values["dry-run"] && !apiKey) console.log("BROWSA_API_KEY is not set: dry run only (get a free key at https://browsa.io).");
  const maxCredits = values["max-credits"] ? Number(values["max-credits"]) : 60;
  // The run's own meter: the ledger rows of the browsers and tasks this bench creates, nothing else.
  const meter = apiKey && !dry ? benchMeter(browsaClient(apiKey, process.env.BROWSA_BASE_URL), maxCredits) : undefined;
  await meter?.begin();

  const results = await runBench({
    tasks,
    loader: defaultLoader(),
    factory: dry ? undefined : browsaFactory({ apiKey: apiKey!, baseUrl: process.env.BROWSA_BASE_URL, ai: !values["no-ai"], meter }),
    stores,
    maxTasksPerStore: values.tasks ? Number(values.tasks) : undefined,
    stages: values.stages ? (values.stages.split(",").map((s) => s.trim()) as BenchStage[]) : undefined,
    maxCredits,
    credits: meter ? () => meter.measure() : undefined,
    // Residential exit data reaches the ledger a few seconds after a browser stops.
    settle: meter ? async () => { if (meter.dataBilled) await new Promise((r) => setTimeout(r, 16_000)); } : undefined,
    log: (m) => console.log(m),
  });
  const commit = gitCommit();
  if (commit) results.commit = commit;

  if (dry) {
    console.log(JSON.stringify(results.stores.map((s) => ({ store: s.store, status: s.status, note: s.note }))));
    // A dry run measures nothing: say so in words nobody can read as fresh results.
    console.log(DRY_RUN_NOTICE);
    return;
  }
  const outDir = values.out ?? join(here, "results");
  await mkdir(outDir, { recursive: true });
  // A second run on the same day gets its own file: earlier results are never overwritten.
  let file = join(outDir, `${results.date}.json`);
  if (await readFile(file).then(() => true, () => false)) file = join(outDir, `${results.date}-${results.startedAt.slice(11, 19).replace(/:/g, "")}.json`);
  await writeFile(file, JSON.stringify(results, null, 2) + "\n");
  // latest.json and the README combine this run with earlier results of stores not run today.
  let previous: BenchResults | undefined;
  try { previous = JSON.parse(await readFile(join(outDir, "latest.json"), "utf8")) as BenchResults; } catch { /* first run */ }
  const merged = mergeResults(previous, results);
  await writeFile(join(outDir, "latest.json"), JSON.stringify(merged, null, 2) + "\n");
  console.log(`wrote ${file}${results.creditsUsed !== undefined ? `, ${results.creditsEstimated ? "about " : ""}${results.creditsUsed} credits (this run's own browsers and tasks)` : ""}`);
  if (!values["no-readme"]) await updateReadme(join(here, "..", "README.md"), merged);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error((e as Error).stack ?? e); process.exit(1); });
}
