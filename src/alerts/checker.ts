// Run one watch: call the injected check function, record the result in history, send alerts.
// And the scheduler loop that runs every due watch, one at a time.

import { evaluate, evaluateFailure } from "./evaluate.js";
import { configFromEnv, createNotifiers, deliver } from "./notify.js";
import { WatchStore } from "./store.js";
import type { Alert, AlertConfig, CheckFn, HistoryEntry, Notifier, NotifyChannel, Watch } from "./types.js";

export interface CheckDeps {
  check: CheckFn;
  store?: WatchStore;
  notifiers?: Record<NotifyChannel, Notifier>;
  config?: AlertConfig;
  now?: () => Date;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface CheckResult {
  watch: Watch;
  entry: HistoryEntry;
  alerts: Alert[];
  deliveryErrors: string[];
}

export async function checkWatch(watch: Watch, deps: CheckDeps): Promise<CheckResult> {
  const store = deps.store ?? new WatchStore();
  const notifiers = deps.notifiers ?? createNotifiers(deps.config ?? configFromEnv());
  const now = deps.now ?? (() => new Date());
  const history = await store.history(watch.id, 50);

  let result: { entry: HistoryEntry; alerts: Alert[] };
  try {
    const offers = await deps.check(watch, deps.signal);
    result = evaluate(watch, offers, history, now().toISOString());
  } catch (e) {
    result = evaluateFailure(watch, (e as Error).message || String(e), history, now().toISOString());
  }
  await store.append(watch.id, result.entry);

  const deliveryErrors: string[] = [];
  for (const alert of result.alerts) deliveryErrors.push(...(await deliver(alert, watch.notify, notifiers)));
  for (const err of deliveryErrors) deps.log?.(`watch ${watch.id}: could not notify: ${err}`);
  return { watch, entry: result.entry, alerts: result.alerts, deliveryErrors };
}

/** When the watch should run next, from its last history entry. */
export async function nextDue(watch: Watch, store: WatchStore): Promise<Date> {
  const last = (await store.history(watch.id, 1))[0];
  if (!last) return new Date(0);
  return new Date(new Date(last.at).getTime() + watch.intervalMinutes * 60_000);
}

/** Run every watch that is due now, one after the other. Use it from cron (`--once`). */
export async function runDueWatches(deps: CheckDeps & { ids?: string[]; force?: boolean }): Promise<CheckResult[]> {
  const store = deps.store ?? new WatchStore();
  const now = deps.now ?? (() => new Date());
  const notifiers = deps.notifiers ?? createNotifiers(deps.config ?? configFromEnv());
  const results: CheckResult[] = [];
  for (const watch of await store.list()) {
    if (deps.signal?.aborted) break;
    if (watch.paused) continue;
    if (deps.ids && !deps.ids.includes(watch.id)) continue;
    if (!deps.force && (await nextDue(watch, store)).getTime() > now().getTime()) continue;
    deps.log?.(`checking ${watch.id}`);
    results.push(await checkWatch(watch, { ...deps, store, notifiers, now }));
  }
  return results;
}

export interface Watcher {
  /** Resolves when the current check (if any) is done and the loop has stopped. */
  stop(): Promise<void>;
  /** Run one pass now (also what each tick does). */
  tick(): Promise<CheckResult[]>;
}

/**
 * Keep checking watches until stop(). Reads watches.json on every tick, so edits take effect
 * without a restart. Runs watches one at a time, never two checks in parallel.
 */
export function startWatching(deps: CheckDeps & { tickMs?: number; onResult?: (r: CheckResult) => void }): Watcher {
  const tickMs = deps.tickMs ?? 60_000;
  const ac = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, ac.signal]) : ac.signal;
  let running: Promise<CheckResult[]> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<CheckResult[]> => {
    if (running) return running;
    running = (async () => {
      try {
        const results = await runDueWatches({ ...deps, signal });
        for (const r of results) deps.onResult?.(r);
        return results;
      } catch (e) {
        deps.log?.(`watch loop: ${(e as Error).message}`);
        return [];
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const loop = async () => {
    if (stopped) return;
    await tick();
    if (!stopped) timer = setTimeout(loop, tickMs);
  };
  timer = setTimeout(loop, 0);

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      ac.abort();
      if (running) await running;
    },
  };
}
