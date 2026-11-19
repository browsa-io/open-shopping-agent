// Run history: every run is saved to <dataDir>/runs/<runId>/
//   events.jsonl     one RunEvent per line, with a time stamp
//   request.json     the parsed ShoppingRequest
//   summary.json     the RunSummary, written when the run ends (and after each order)
//   screenshots/     PNGs, referenced by path from the summary and from "log" events
//   tracking.json    order status read later from the store's order page (osa orders refresh)
// Phantom Live links are single use and give control of a browser: history keeps them without
// the access code (the part after #).

import { appendFile, mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Page } from "playwright-core";
import type { RunEvent, RunSummary, ShoppingRequest, StoreId } from "./types.js";

export interface RunListItem {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  prompt?: string;
  items: number;
  picks: number;
  orders: number;
  failures: number;
  creditsUsed?: number;
  creditsEstimated?: boolean;
}

export interface SavedRun {
  runId: string;
  dir: string;
  request?: ShoppingRequest;
  summary?: RunSummary;
  events: (RunEvent & { at?: string })[];
  screenshots: string[];
}

const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

export function runsDir(dataDir = ".osa"): string {
  return join(dataDir, "runs");
}

export function runDir(dataDir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`bad run id: ${runId}`);
  return join(runsDir(dataDir), runId);
}

/** Strip the single-use access code from Phantom Live links before anything is written. */
export function redactLive<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (k, v) => {
    if (typeof v === "string" && (k === "liveUrl" || k === "live_url") && v.includes("#")) return `${v.split("#")[0]}#(single-use code removed)`;
    return v;
  })) as T;
}

/** Writes one run's files. Writes are queued so lines never interleave. */
export class RunRecorder {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<unknown>;
  readonly screenshots: { store: StoreId; label: string; path: string }[] = [];

  constructor(readonly dataDir: string, readonly runId: string) {
    this.dir = runDir(dataDir, runId);
    this.ready = mkdir(join(this.dir, "screenshots"), { recursive: true });
  }

  private enqueue(fn: () => Promise<unknown>): Promise<void> {
    const p = this.queue.then(() => this.ready).then(fn);
    this.queue = p.catch(() => {});
    return p.then(() => {}, () => {}); // history must never fail a run
  }

  event(ev: RunEvent): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), ...redactLive(ev) }) + "\n";
    return this.enqueue(() => appendFile(join(this.dir, "events.jsonl"), line));
  }

  request(req: ShoppingRequest): Promise<void> {
    return this.enqueue(() => writeFile(join(this.dir, "request.json"), JSON.stringify(req, null, 2) + "\n"));
  }

  summary(s: RunSummary): Promise<void> {
    const body = JSON.stringify(redactLive({ ...s, screenshots: this.screenshots }), null, 2) + "\n";
    return this.enqueue(() => writeFile(join(this.dir, "summary.json"), body));
  }

  /** Save a screenshot of the page; returns its path, or undefined when it failed. */
  async screenshot(store: StoreId, label: string, page: Page): Promise<string | undefined> {
    const safe = `${store}-${label}`.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60);
    const path = join(this.dir, "screenshots", `${String(this.screenshots.length + 1).padStart(2, "0")}-${safe}.png`);
    try {
      await this.ready;
      await page.screenshot({ path, timeout: 20_000 });
      this.screenshots.push({ store, label, path });
      return path;
    } catch {
      return undefined;
    }
  }

  /** Wait for queued writes. */
  flush(): Promise<void> {
    return this.queue.then(() => {});
  }
}

/** Runs in the data folder, newest first. */
export async function listRuns(dataDir = ".osa", limit = 50): Promise<RunListItem[]> {
  let names: string[];
  try { names = await readdir(runsDir(dataDir)); } catch { return []; }
  const ids = names.filter((n) => RUN_ID.test(n)).sort().reverse().slice(0, Math.max(1, limit));
  const out: RunListItem[] = [];
  for (const runId of ids) {
    const dir = runDir(dataDir, runId);
    const summary = await readJSON<RunSummary>(join(dir, "summary.json"));
    const request = await readJSON<ShoppingRequest>(join(dir, "request.json"));
    let startedAt = summary?.startedAt;
    if (!startedAt) {
      try { startedAt = (await stat(dir)).birthtime.toISOString(); } catch { startedAt = ""; }
    }
    out.push({
      runId,
      startedAt,
      finishedAt: summary?.finishedAt,
      prompt: request?.prompt,
      items: request?.items.length ?? 0,
      picks: summary?.picks.length ?? 0,
      orders: summary?.orders.filter((o) => o.placed).length ?? 0,
      failures: summary?.failures.length ?? 0,
      creditsUsed: summary?.creditsUsed,
      ...(summary?.creditsEstimated ? { creditsEstimated: true } : {}),
    });
  }
  return out;
}

/** One saved run with its events, or undefined when there is no such run. */
export async function getRun(runId: string, dataDir = ".osa"): Promise<SavedRun | undefined> {
  if (!RUN_ID.test(runId)) return undefined;
  const dir = runDir(dataDir, runId);
  try { await stat(dir); } catch { return undefined; }
  let events: SavedRun["events"] = [];
  try {
    const text = await readFile(join(dir, "events.jsonl"), "utf8");
    events = text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { /* no events yet */ }
  let screenshots: string[] = [];
  try { screenshots = (await readdir(join(dir, "screenshots"))).filter((f) => f.endsWith(".png")).sort().map((f) => join(dir, "screenshots", f)); } catch { /* none */ }
  return {
    runId, dir, events, screenshots,
    request: await readJSON<ShoppingRequest>(join(dir, "request.json")),
    summary: await readJSON<RunSummary>(join(dir, "summary.json")),
  };
}

async function readJSON<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; }
}
