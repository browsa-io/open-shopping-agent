// `osa watch ...` subcommands. The CLI front end calls runWatchCli(args, { check }) and passes the
// engine's check function; the commands that only edit watches.json work without it.

import { parseArgs } from "node:util";
import type { StoreId } from "../core/types.js";
import { formatMoney } from "../stores/util.js";
import { runDueWatches, startWatching } from "./checker.js";
import { configFromEnv, createNotifiers, deliver } from "./notify.js";
import { WatchStore } from "./store.js";
import type { Alert, AlertConfig, CheckFn, NotifyChannel, NotifyTarget, WatchInput } from "./types.js";

export const WATCH_HELP = `osa watch: price-drop and back-in-stock alerts

  osa watch add "<query>" [--store amazon,walmart,satechi.com] [--target 199.99] [--back-in-stock]
                [--notify desktop,slack,webhook,email] [--to you@example.com] [--every 12h] [--id name]
  osa watch add --url <product url> [--target 49] [--back-in-stock] ...
  osa watch list
  osa watch history <id>
  osa watch pause <id> | resume <id> | remove <id>
  osa watch run [--once] [--force] [id ...]   check due watches (--once: one pass, for cron)
  osa watch test <desktop|slack|webhook|email> [--to you@example.com]

Checks run at most every 6 hours per watch (default 12 hours).
Settings: OSA_DIR, OSA_SLACK_WEBHOOK_URL, OSA_WEBHOOK_URL, OSA_WEBHOOK_SECRET, OSA_EMAIL_TO,
OSA_SMTP_HOST, OSA_SMTP_PORT, OSA_SMTP_USER, OSA_SMTP_PASS, OSA_SMTP_FROM, RESEND_API_KEY, OSA_EMAIL_FROM.
`;

export interface WatchCliDeps {
  check?: CheckFn;
  store?: WatchStore;
  config?: AlertConfig;
  out?: { write(s: string): unknown };
  signal?: AbortSignal;
}

/** "90m", "6h", "1d" or a number of minutes. */
export function parseEvery(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/i);
  if (!m) throw new Error(`cannot read interval "${s}" (use 90m, 12h or 1d)`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || "m").toLowerCase();
  return Math.round(unit === "d" ? n * 1440 : unit === "h" ? n * 60 : n);
}

/** "amazon, satechi.com": the watch's stores with each Shopify shop by its domain. */
export function whereText(w: { stores: StoreId[]; shopifyDomains?: string[] }, sep = ", "): string {
  return w.stores.flatMap((s) => (s === "shopify" ? (w.shopifyDomains?.length ? w.shopifyDomains : ["shopify"]) : [s])).join(sep);
}

/** Returns the process exit code. */
export async function runWatchCli(args: string[], deps: WatchCliDeps = {}): Promise<number> {
  const out = deps.out ?? process.stdout;
  const store = deps.store ?? new WatchStore();
  const config = deps.config ?? configFromEnv();
  const say = (s: string) => out.write(s + "\n");
  const [sub, ...rest] = args;

  try {
    switch (sub) {
      case "add": {
        const { values, positionals } = parseArgs({
          args: rest, allowPositionals: true,
          options: {
            url: { type: "string" }, store: { type: "string" }, shopify: { type: "string" },
            target: { type: "string" }, "back-in-stock": { type: "boolean" }, used: { type: "boolean" },
            notify: { type: "string" }, to: { type: "string" }, every: { type: "string" },
            id: { type: "string" }, label: { type: "string" },
          },
        });
        const channels = (values.notify ?? "desktop").split(",").map((c) => c.trim()).filter(Boolean) as NotifyChannel[];
        const notify: NotifyTarget[] = channels.map((channel) => (channel === "email" && values.to ? { channel, to: values.to } : { channel }));
        const input: WatchInput = {
          id: values.id,
          label: values.label,
          query: positionals.join(" ") || undefined,
          url: values.url,
          // Store names and Shopify shop domains: --store amazon,satechi.com (normalizeWatch splits them).
          stores: values.store ? (values.store.split(",").map((s) => s.trim()).filter(Boolean) as StoreId[]) : undefined,
          shopifyDomains: values.shopify ? values.shopify.split(",").map((s) => s.trim()) : undefined,
          targetPrice: values.target ? Number(values.target.replace(/[$,]/g, "")) : undefined,
          backInStock: values["back-in-stock"],
          condition: values.used ? "any" : "new",
          notify,
          intervalMinutes: values.every ? parseEvery(values.every) : undefined,
        };
        if (input.shopifyDomains && !input.stores) input.stores = ["shopify"];
        const w = await store.add(input);
        say(`Added watch "${w.id}": ${w.query ?? w.url} on ${whereText(w)}, every ${w.intervalMinutes / 60} h` +
          `${w.targetPrice ? `, target ${formatMoney(w.targetPrice)}` : ""}${w.backInStock ? ", back in stock" : ""}` +
          `, notify ${w.notify.map((n) => n.channel).join(", ")}.`);
        return 0;
      }
      case "list": {
        const watches = await store.list();
        if (!watches.length) { say("No watches yet. Add one: osa watch add \"27 inch 4K monitor\" --target 250"); return 0; }
        for (const w of watches) {
          const last = (await store.history(w.id, 1))[0];
          const seen = last?.best ? `${formatMoney(last.best.total)} at ${last.best.storeDomain}` : last ? (last.ok ? "none in stock" : "last check failed") : "not checked yet";
          say(`${w.id}${w.paused ? " (paused)" : ""}: ${w.query ?? w.url} | ${whereText(w, ",")} | ` +
            `${w.targetPrice ? `target ${formatMoney(w.targetPrice)} | ` : ""}${w.backInStock ? "back in stock | " : ""}last: ${seen}`);
        }
        return 0;
      }
      case "history": {
        const id = rest[0];
        if (!id) throw new Error("usage: osa watch history <id>");
        const entries = await store.history(id, 30);
        if (!entries.length) { say(`No checks yet for "${id}".`); return 0; }
        for (const e of entries) {
          say(`${e.at}  ${e.ok ? (e.best ? `${formatMoney(e.best.total)} ${e.best.storeDomain}` : "none in stock") : `failed: ${e.error}`}` +
            `${e.alerts.length ? `  alert: ${e.alerts.join(",")}` : ""}`);
        }
        return 0;
      }
      case "pause": case "resume": {
        const id = rest[0];
        if (!id) throw new Error(`usage: osa watch ${sub} <id>`);
        await store.update(id, { paused: sub === "pause" });
        say(`${sub === "pause" ? "Paused" : "Resumed"} "${id}".`);
        return 0;
      }
      case "remove": case "rm": {
        const id = rest[0];
        if (!id) throw new Error("usage: osa watch remove <id>");
        const removed = await store.remove(id);
        say(removed ? `Removed "${id}".` : `No watch "${id}".`);
        return removed ? 0 : 1;
      }
      case "run": {
        const { values, positionals } = parseArgs({
          args: rest, allowPositionals: true,
          options: { once: { type: "boolean" }, force: { type: "boolean" } },
        });
        if (!deps.check) throw new Error("the shopping engine is not installed, so watches cannot be checked");
        const notifiers = createNotifiers({ ...config, out: config.out ?? out });
        const log = (m: string) => say(m);
        const ids = positionals.length ? positionals : undefined;
        if (values.once) {
          const results = await runDueWatches({ check: deps.check, store, notifiers, ids, force: values.force, log, signal: deps.signal });
          say(`Checked ${results.length} watch${results.length === 1 ? "" : "es"}, ${results.reduce((n, r) => n + r.alerts.length, 0)} alert(s).`);
          return results.some((r) => r.deliveryErrors.length) ? 1 : 0;
        }
        const watcher = startWatching({ check: deps.check, store, notifiers, log, signal: deps.signal });
        say("Watching. Press Ctrl+C to stop.");
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          deps.signal?.addEventListener("abort", done, { once: true });
          process.once("SIGINT", done);
          process.once("SIGTERM", done);
        });
        await watcher.stop();
        return 0;
      }
      case "test": {
        const channel = rest[0] as NotifyChannel;
        const { values } = parseArgs({ args: rest.slice(1), options: { to: { type: "string" }, url: { type: "string" } } });
        const alert: Alert = {
          kind: "below_target", watchId: "test", label: "Test alert", at: new Date().toISOString(),
          message: "Test alert from Open Shopping Agent. Your notifications work.",
        };
        const errors = await deliver(alert, [{ channel, ...(values.to ? { to: values.to } : {}), ...(values.url ? { url: values.url } : {}) }],
          createNotifiers({ ...config, out: config.out ?? out }));
        if (errors.length) { say(errors.join("\n")); return 1; }
        say(`Sent a test alert to ${channel}.`);
        return 0;
      }
      case undefined: case "help": case "--help": case "-h":
        out.write(WATCH_HELP);
        return 0;
      default:
        out.write(`Unknown watch command "${sub}".\n\n${WATCH_HELP}`);
        return 2;
    }
  } catch (e) {
    say(`Error: ${(e as Error).message}`);
    return 1;
  }
}
