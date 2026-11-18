#!/usr/bin/env node
// osa / open-shopping-agent: the command line. Finds and compares, then asks per store before it
// fills a cart, reviews a checkout or buys. Never buys without a typed "y".

import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { RunEvent, StoreId } from "../core/types.js";
import { ConfigStore, DEFAULT_STORES, osaHome } from "../web/config.js";
import { checkFor, createAlerts, createEngine } from "../web/engine-factory.js";
import { runWatchCli } from "../alerts/cli.js";
import { WatchStore } from "../alerts/store.js";
import { compareFromEvents, money, storeName } from "../web/format.js";
import { RunHub, type Gate } from "../web/session.js";
import { CliError, HELP, parseArgs, type CliArgs } from "./args.js";
import { Progress, colorEnabled, paint, renderCompare, renderLines, renderReview, totalLine } from "./render.js";

const VERSION = "0.1.0";

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "watch") return watchCommands(argv.slice(1));
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  switch (args.command) {
    case "help": process.stdout.write(HELP); return 0;
    case "version": process.stdout.write(`${VERSION}\n`); return 0;
    case "web": return web(args);
    case "mcp": {
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer({ demo: args.demo });
      return -1; // keep running
    }
    case "watch": return watch(args);
    case "runs": return runs(args);
    default: return shop(args);
  }
}

async function web(args: CliArgs): Promise<number> {
  const { startWebServer } = await import("../web/server.js");
  const { url } = await startWebServer({ port: args.port, host: args.host, demo: args.demo });
  process.stdout.write(`Open Shopping Agent web app: ${url}\n`);
  return -1;
}

async function watch(args: CliArgs): Promise<number> {
  const alerts = createAlerts();
  const w = await alerts.create({
    kind: args.backInStock ? "back_in_stock" : "price_drop",
    item: args.watch!,
    url: /^https:\/\//.test(args.watch!) ? args.watch : undefined,
    below: args.backInStock ? undefined : args.below,
    stores: args.stores,
  });
  if (args.json) process.stdout.write(JSON.stringify(w, null, 2) + "\n");
  else process.stdout.write(`Watch saved (${w.id}): ${w.item}, ${w.kind === "price_drop" ? `at or below ${money(w.below)}` : "back in stock"}\n`);
  if (!args.json) process.stdout.write(alerts.demo ? "Saved locally. Checks start when the alerts service runs.\n" : "Check it with: osa watch run --once (or keep osa watch run going).\n");
  return 0;
}

/** `osa watch add|list|history|pause|resume|remove|run|test`, on the real alerts store. */
async function watchCommands(argv: string[]): Promise<number> {
  const home = osaHome();
  const cfg = await new ConfigStore(home).effective();
  const check = checkFor(cfg, home);
  if (argv[0] === "run" && !check) {
    process.stderr.write("Set BROWSA_API_KEY (or save a key in osa web, Settings) to check watches.\n");
    return 1;
  }
  return runWatchCli(argv, { check, store: new WatchStore(home) });
}

async function runs(args: CliArgs): Promise<number> {
  const config = new ConfigStore();
  const hub = new RunHub(await createEngine(await config.effective(), { demo: args.demo }));
  const list = await hub.list(args.limit ?? 20);
  if (args.json) {
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    return 0;
  }
  if (!list.length) {
    process.stdout.write("No runs yet.\n");
    return 0;
  }
  for (const r of list) {
    process.stdout.write(`${r.startedAt.slice(0, 16).replace("T", " ")}  ${r.status.padEnd(9)}  ${(r.picksTotal ? money(r.picksTotal) : "").padStart(9)}  ${r.prompt}  ${r.runId}\n`);
  }
  return 0;
}

async function shop(args: CliArgs): Promise<number> {
  const config = new ConfigStore();
  const cfg = await config.effective();
  const engine = await createEngine(cfg, { demo: args.demo });
  const hub = new RunHub(engine);
  const p = paint(colorEnabled(process.stdout));
  const err = process.stderr;
  const interactive = !args.json && !args.noCart;
  const stores: StoreId[] = args.stores ?? cfg.allowedStores ?? DEFAULT_STORES;
  const budget = args.budget ?? cfg.budget;

  if (engine.demo && !args.json) err.write(p.yellow("Demo data: made-up products and prices. No store is contacted, nothing is bought.\n"));

  const run = hub.start(args.prompt!, {
    limits: { allowedStores: stores, budget },
    zip: args.zip ?? cfg.zip,
    shopifyDomains: args.shopifyDomains ?? cfg.shopifyDomains,
    checkout: interactive,
  });

  process.once("SIGINT", () => {
    err.write("\nCancelled. Stopping the browsers...\n");
    hub.cancel(run.runId).finally(() => process.exit(130));
  });

  if (args.json) {
    const summary = await run.done;
    const picks = [...run.events].reverse().find((e): e is Extract<RunEvent, { type: "picks" }> => e.type === "picks");
    const parsed = run.events.find((e): e is Extract<RunEvent, { type: "parsed" }> => e.type === "parsed");
    process.stdout.write(JSON.stringify({
      runId: run.runId, demo: engine.demo, request: parsed?.request, picks: summary.picks,
      total: picks?.total, overBudget: picks?.overBudget ?? false, compare: compareFromEvents(run.events).map((c) => ({
        itemId: c.itemId, label: c.label, offers: c.rows.map((r) => ({ ...r.offer, raw: undefined, best: r.best })),
      })), failures: summary.failures,
    }, null, 2) + "\n");
    return 0;
  }

  const out = process.stdout;
  const progress = new Progress(out, p);
  let compared = false;
  const exitWarnings: string[] = [];
  const offers = new Map<StoreId, number>();

  const rl = interactive && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let chain = Promise.resolve();
  const ask = (q: string): Promise<boolean> => {
    const next = chain.then(async () => {
      if (!rl) {
        out.write(`${q} [y/N] ${p.dim("n (no terminal input)")}\n`);
        return false;
      }
      const a = (await rl.question(`${q} ${p.dim("[y/N]")} `)).trim().toLowerCase();
      return a === "y" || a === "yes";
    });
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  const onGate = async (g: Gate) => {
    const name = storeName(g.store);
    if (g.step === "cart") {
      const picks = (run.events.find((e) => e.type === "picks") as Extract<RunEvent, { type: "picks" }> | undefined)?.picks ?? [];
      const mine = picks.filter((pk) => pk.offer.store === g.store);
      const yes = await ask(`Fill cart at ${p.bold(name)} (${mine.length} item${mine.length === 1 ? "" : "s"}, ${money({ cents: mine.reduce((s, pk) => s + pk.offer.price.cents, 0), currency: "USD" })})?`);
      hub.answer(run.runId, "cart", g.store, yes);
    } else {
      const yes = await ask(`Review checkout at ${p.bold(name)}? It stops before Place order.`);
      hub.answer(run.runId, "checkout", g.store, yes);
    }
  };

  const onEvent = async (e: RunEvent) => {
    switch (e.type) {
      case "parsed":
        out.write(`${p.bold("Looking for")} ${e.request.items.map((i) => (i.quantity > 1 ? `${i.quantity} x ${i.description}` : i.description)).join(", ")}` +
          `${e.request.budget ? p.dim(`, budget ${money(e.request.budget)}`) : ""}\n`);
        for (const s of e.request.stores) progress.set(s, { label: "starting browser", tone: "busy" });
        break;
      case "store_started": progress.set(e.store, { label: e.exit ? `searching (exit: ${e.exit})` : "searching", tone: "busy" }); break;
      case "offers": {
        const n = (offers.get(e.store) ?? 0) + e.offers.length;
        offers.set(e.store, n);
        progress.set(e.store, { label: `${n} offer${n === 1 ? "" : "s"}`, tone: "busy" });
        break;
      }
      case "store_failed":
        if (!compared) progress.set(e.store, { label: `failed at ${e.stage}: ${e.error}`, tone: "bad" });
        else out.write(p.red(`${storeName(e.store)} failed at ${e.stage}: ${e.error}\n`));
        break;
      case "picks": {
        for (const [s, n] of offers) progress.set(s, { label: `${n} offer${n === 1 ? "" : "s"}`, tone: "ok" });
        progress.stop();
        compared = true;
        const parsed = run.events.find((x): x is Extract<RunEvent, { type: "parsed" }> => x.type === "parsed");
        out.write("\n" + renderCompare(compareFromEvents(run.events), p, { width: out.columns ?? 100 }) + "\n");
        out.write(totalLine(e.total, parsed?.request.budget, e.overBudget, p) + "\n\n");
        for (const w of exitWarnings.splice(0)) out.write(p.yellow(`! ${w}\n\n`));
        break;
      }
      case "cart":
        out.write(`${p.bold(storeName(e.cart.store, e.cart.storeDomain))} cart, read back from the store:\n${renderLines(e.cart.lines, p)}\n`);
        for (const w of e.cart.warnings) out.write(p.yellow(`  ! ${w}\n`));
        break;
      case "needs_user":
        out.write(p.yellow(`${storeName(e.store)}: ${e.needs.message}\n`));
        if (e.needs.liveUrl) out.write(`  Take over in Phantom Live: ${e.needs.liveUrl}\n`);
        break;
      case "awaiting_approval": {
        const r = e.review;
        out.write(`\n${p.bold(`${storeName(e.store, r.storeDomain)} checkout`)}\n${renderReview(r, p)}\n`);
        const yes = await ask(`${p.bold(`Buy for ${money(r.total)} at ${storeName(e.store, r.storeDomain)}?`)}`);
        if (yes) {
          await hub.approve(run.runId, e.store, r.total).catch((x) => out.write(p.red(`${(x as Error).message}\n`)));
        } else {
          await hub.cancel(run.runId, e.store);
          out.write(p.dim(`Not bought at ${storeName(e.store)}. The cart stays filled.\n`));
        }
        break;
      }
      case "order":
        if (e.result.placed) out.write(p.green(`Order placed at ${storeName(e.result.store)}: ${e.result.orderId ?? ""} ${money(e.result.total)}`) + (e.result.confirmationText ? p.dim(` (${e.result.confirmationText})`) : "") + "\n");
        else out.write(p.red(`Order not placed at ${storeName(e.result.store)}: ${e.result.error ?? e.result.confirmationText ?? e.result.needsUser?.message ?? "unknown"}\n`));
        break;
      case "log":
        if (compared && e.store) out.write(p.dim(`  ${storeName(e.store)}: ${e.message}\n`));
        else if (/may block Browsa's default exit/.test(e.message)) {
          // Printed after the progress lines, which redraw in place.
          if (compared) out.write(p.yellow(`! ${e.message}\n`)); else exitWarnings.push(e.message);
        }
        break;
    }
  };

  let queue = Promise.resolve();
  hub.subscribe(run.runId, (m) => {
    queue = queue.then(() => (m.kind === "event" ? onEvent(m.event) : m.open ? onGate(m.gate) : undefined)).catch(() => undefined);
  });
  const summary = await run.done;
  await queue;
  await chain;
  progress.stop();
  rl?.close();
  const placed = summary.orders.filter((o) => o.placed);
  out.write(p.dim(`\nRun ${summary.runId}: ${placed.length} order${placed.length === 1 ? "" : "s"} placed, ${summary.failures.length} store failure${summary.failures.length === 1 ? "" : "s"}${summary.creditsUsed !== undefined ? `, ${summary.creditsUsed} credits` : ""}.\n`));
  return 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  }, (e) => {
    process.stderr.write(`${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
