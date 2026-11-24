#!/usr/bin/env node
// osa / open-shopping-agent: the command line. Finds and compares, then asks per store before it
// fills a cart, reviews a checkout or buys. Never buys without a typed "y".

import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { RunEvent, StoreId } from "../core/types.js";
import { cartPlan } from "./plan.js";
import { listOrders, type OrderEntry } from "../core/orders.js";
import { EXIT, classify, errorEnvelope, errorOf, exitCodeFor, okEnvelope, printJson, runExitCode, worstCode } from "./output.js";
import { ConfigStore, DEFAULT_STORES, osaHome } from "../web/config.js";
import { NoBrowserError, checkFor, createAlerts, createEngine, noBrowserReason } from "../web/engine-factory.js";
import { runWatchCli, whereText } from "../alerts/cli.js";
import { WatchStore } from "../alerts/store.js";
import { compareFromEvents, money, storeName } from "../web/format.js";
import { RunHub, type Gate } from "../web/session.js";
import { CliError, HELP, MCP_HELP, parseArgs, type CliArgs } from "./args.js";
import { Progress, colorEnabled, paint, renderCompare, renderLines, renderReview, totalLine } from "./render.js";
import { blockWords, friendlyError, isBlock, shortRaw } from "../../web/lib/wording.js";
import { MandateError, boughtUnderMandateText, makeMandate, mandateLimits, mandateQuestion, mandateText, type Mandate } from "../core/mandate.js";

import { VERSION } from "../version.js";

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "watch") return watchCommands(argv.slice(1));
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliError) {
      if (argv.includes("--json")) printJson(process.stdout, errorEnvelope("bad_args", e.message, ["osa --help"]));
      else process.stderr.write(`${e.message}\n`);
      return EXIT.user;
    }
    throw e;
  }
  if (args.json && args.command !== "help" && args.command !== "version" && args.command !== "web" && args.command !== "mcp") {
    // In JSON mode every failure is one envelope on stdout with its exit code, never a stack trace.
    try {
      return await dispatch(args);
    } catch (e) {
      const { code, message } = errorOf(e);
      printJson(process.stdout, errorEnvelope(code, message));
      return exitCodeFor(code);
    }
  }
  try {
    return await dispatch(args);
  } catch (e) {
    // No browser is set up and --demo was not passed: say what to set; never switch to demo data.
    if (e instanceof NoBrowserError) {
      process.stderr.write(`${e.message}\n`);
      return EXIT.user;
    }
    throw e;
  }
}

async function dispatch(args: CliArgs): Promise<number> {
  // --browser and --headless reach the web app and the MCP server through the environment.
  if (args.browser) process.env.OSA_BROWSER = args.browser;
  if (args.headless) process.env.OSA_HEADLESS = "1";
  switch (args.command) {
    case "help": process.stdout.write(args.helpTopic === "mcp" ? MCP_HELP : HELP); return 0;
    case "version": process.stdout.write(`${VERSION}\n`); return 0;
    case "web": return web(args);
    case "mcp": {
      const { startMcpServer } = await import("../mcp/server.js");
      await startMcpServer({ demo: args.demo });
      return -1; // keep running
    }
    case "watch": return watch(args);
    case "runs": return runs(args);
    case "orders": return orders(args);
    default: return shop(args);
  }
}

const STATE_WORDS: Record<string, string> = { placing: "placing", placed: "placed", failed: "not placed", unknown: "CHECK STORE" };

/** One line of tracking: "Shipped, Arriving Thursday, UPS 1Z..." or why it could not be read. */
export function trackingText(t: OrderEntry["tracking"]): string {
  if (!t) return "";
  if (t.error) return `not read: ${t.error}`;
  if (t.signIn) return "sign in to the store in the saved profile to read it";
  if (t.unreadable && !t.status) return "the order page could not be read";
  return [t.status, t.deliveryText, [t.carrier, t.trackingNumber].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

/** `osa orders [--all]` and `osa orders refresh [run-id] [--store x]`. */
async function orders(args: CliArgs): Promise<number> {
  const out = process.stdout;
  let list: OrderEntry[];
  if (args.refresh) {
    const engine = await createEngine(await new ConfigStore().effective(), { demo: args.demo, browser: args.browser, strict: true });
    list = await new RunHub(engine).refreshOrders({ runId: args.runId, store: args.stores?.[0], limit: args.limit });
  } else if (args.demo) {
    list = []; // the demo engine keeps its orders in memory only
  } else {
    // Orders live in the run history: no browser and no key needed to list them.
    list = await listOrders(osaHome(), { all: args.all, limit: args.limit ?? 50 });
  }
  const unknown = list.filter((o) => o.state === "unknown");
  const readable = list.filter((o) => o.state === "placed" && o.orderUrl);
  const next = [
    ...(unknown.length ? unknown.map((o) => `Check your orders on ${storeName(o.store, o.storeDomain)}: ${o.ordersUrl}`) : []),
    ...(!args.refresh && readable.length ? ["osa orders refresh"] : []),
  ];
  if (args.json) {
    printJson(out, okEnvelope({ orders: list, refreshed: !!args.refresh }, next));
    return EXIT.ok;
  }
  const p = paint(colorEnabled(out));
  if (!list.length) {
    out.write(args.refresh ? "No placed order with an order page to read.\n" : "No orders yet. Orders appear here after you approve a checkout.\n");
    return EXIT.ok;
  }
  for (const o of list) {
    const word = STATE_WORDS[o.state] ?? o.state;
    const tone = o.state === "placed" ? p.green : o.state === "unknown" ? p.yellow : o.state === "failed" ? p.red : p.dim;
    out.write(`${(o.at || "").slice(0, 16).replace("T", " ")}  ${storeName(o.store, o.storeDomain).padEnd(10)} ${tone(word.padEnd(11))} ${(o.orderId ?? "-").padEnd(20)} ${money(o.total).padStart(9)}  ${o.prompt ?? ""}\n`);
    if (o.state === "unknown" && o.message) out.write(p.yellow(`  ${o.message}\n`));
    if (o.state === "failed" && o.message) out.write(p.dim(`  ${o.message}\n`));
    const t = trackingText(o.tracking);
    if (t) out.write(p.dim(`  ${t}${o.tracking?.trackingUrl ? ` ${o.tracking.trackingUrl}` : ""}${o.tracking?.checkedAt ? ` (read ${o.tracking.checkedAt.slice(0, 16).replace("T", " ")})` : ""}\n`));
    else if (o.state === "placed" && o.orderUrl) out.write(p.dim(`  ${o.orderUrl}\n`));
  }
  if (!args.refresh && readable.length) out.write(p.dim("\nosa orders refresh reads each order's page on the store (status, carrier, tracking).\n"));
  return EXIT.ok;
}

async function web(args: CliArgs): Promise<number> {
  const { startWebServer, stopRunsOnExit } = await import("../web/server.js");
  const { url, hub } = await startWebServer({ port: args.port, host: args.host, demo: args.demo });
  stopRunsOnExit(hub);
  process.stdout.write(`Open Shopping Agent web app: ${url}\n`);
  // The web app can still open (Settings is where a key is saved), but say plainly that it shows demo data.
  const why = hub.engine.demo && !args.demo ? noBrowserReason(await new ConfigStore().effective(), { browser: args.browser }) : undefined;
  if (why) process.stderr.write(`No browser is set up, so the web app shows made-up demo data until one is. ${why.replace(/, or pass --demo.*$/, ".")} Or save a Browsa key in Settings.\n`);
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
    // --stores satechi.com: the Shopify shop goes with the watch, as it does for a search.
    ...(args.shopifyDomains?.length ? { shopifyDomains: args.shopifyDomains } : {}),
  });
  const where = w.stores?.length ? ` on ${whereText({ stores: w.stores, shopifyDomains: w.shopifyDomains })}` : "";
  if (args.json) {
    printJson(process.stdout, okEnvelope({ watch: w }, alerts.demo ? [] : ["osa watch run --once"]));
    return EXIT.ok;
  }
  process.stdout.write(`Watch saved (${w.id}): ${w.item}${where}, ${w.kind === "price_drop" ? `at or below ${money(w.below)}` : "back in stock"}\n`);
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
    printJson(process.stdout, okEnvelope({ runs: list }, ["osa orders"]));
    return EXIT.ok;
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

/** ", 12 credits" (this run's own browsers and tasks), ", about 12 credits" when estimated, else "". */
export function creditsText(s: { creditsUsed?: number; creditsEstimated?: boolean }): string {
  if (s.creditsUsed === undefined) return "";
  return `, ${s.creditsEstimated ? "about " : ""}${s.creditsUsed} credit${s.creditsUsed === 1 ? "" : "s"}`;
}

async function shop(args: CliArgs): Promise<number> {
  const config = new ConfigStore();
  const cfg = await config.effective();
  if (args.headless) process.env.OSA_HEADLESS = "1";
  // Demo data only when asked for (--demo or OSA_DEMO=1): with no browser set up this throws NoBrowserError.
  const engine = await createEngine(cfg, { demo: args.demo, browser: args.browser, strict: true });
  const hub = new RunHub(engine);
  const p = paint(colorEnabled(process.stdout));
  const err = process.stderr;
  // --dry-run and --json never change a cart: no "fill cart?" question is even asked.
  const interactive = !args.json && !args.noCart && !args.dryRun;
  const stores: StoreId[] = args.stores ?? cfg.allowedStores ?? DEFAULT_STORES;
  const budget = args.budget ?? cfg.budget;

  if (engine.demo && !args.json) err.write(p.yellow("Demo data: made-up products and prices. No store is contacted, nothing is bought.\n"));

  const out = process.stdout;
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

  // Up-front approval: only from the person's own flags, confirmed once here (or --yes).
  let mandate: Mandate | undefined;
  if (args.mandate) {
    try {
      mandate = makeMandate(args.mandate, "cli");
    } catch (e) {
      if (!(e instanceof MandateError)) throw e;
      rl?.close();
      err.write(`${e.message}\n`);
      return EXIT.user;
    }
    if (!args.yes) {
      if (!rl) {
        err.write("--approve-up-to needs your y in a terminal. Add --yes to grant it without the question.\n");
        return EXIT.user;
      }
      if (!(await ask(p.bold(mandateQuestion(mandateLimits(mandate)))))) {
        mandate = undefined;
        out.write(p.dim("No up-front approval: every order waits for your y on the exact total.\n"));
      }
    }
    if (mandate) out.write(p.dim(`Up-front approval: buying without asking, ${mandateText(mandateLimits(mandate))}.\n`));
  }

  const run = hub.start(args.prompt!, {
    limits: { allowedStores: stores, budget },
    zip: args.zip ?? cfg.zip,
    shopifyDomains: args.shopifyDomains ?? cfg.shopifyDomains,
    checkout: interactive,
    everyStore: args.everyStore,
    // With an up-front approval, carts and checkout reviews at its stores need no question either.
    ...(mandate ? { mandate, autoSteps: ["cart" as const, "checkout" as const] } : {}),
  });

  process.once("SIGINT", () => {
    err.write("\nCancelled. Stopping the browsers...\n");
    hub.cancel(run.runId).finally(() => process.exit(130));
  });

  if (args.json) {
    const summary = await run.done;
    const picks = [...run.events].reverse().find((e): e is Extract<RunEvent, { type: "picks" }> => e.type === "picks");
    const parsed = run.events.find((e): e is Extract<RunEvent, { type: "parsed" }> => e.type === "parsed");
    const overBudget = picks?.overBudget ?? false;
    const data = {
      runId: run.runId, demo: engine.demo, dryRun: args.dryRun, request: parsed?.request, picks: summary.picks,
      total: picks?.total, overBudget, compare: compareFromEvents(run.events).map((c) => ({
        itemId: c.itemId, label: c.label, offers: c.rows.map((r) => ({ ...r.offer, raw: undefined, best: r.best })),
      })), failures: summary.failures.map((f) => ({ ...f, code: classify(f.error) })),
      ...(args.dryRun ? { carts: cartPlan(summary.picks, parsed?.request.items ?? []) } : {}),
    };
    const quoted = JSON.stringify(args.prompt);
    if (!summary.picks.length && summary.failures.length) {
      const code = worstCode(data.failures.map((f) => f.code)) ?? "store_error";
      printJson(process.stdout, errorEnvelope(code, `No store finished: ${summary.failures.map((f) => `${storeName(f.store)} ${f.error}`).join("; ").slice(0, 400)}`,
        code === "needs_captcha" || code === "needs_sign_in" ? ["osa web (finish the step in the live browser)"] : [`osa --json ${quoted}`], data));
      return exitCodeFor(code);
    }
    if (args.dryRun && overBudget) {
      printJson(process.stdout, errorEnvelope("over_budget", "The picks are over the budget, so no cart would be filled", [`osa --dry-run --json --budget <higher> ${quoted}`], data));
      return exitCodeFor("over_budget");
    }
    const next = !summary.picks.length ? ["Try simpler words, like \"usb-c hub\""]
      : overBudget ? [`osa --json --budget <higher> ${quoted}`]
      : [`osa ${quoted} (in a terminal: fills carts after a y per store; buys only after a y on the exact total)`, "osa runs --json"];
    // Some stores gave picks and some failed: the reply is ok (the picks are real) and lists the
    // failures; the exit code is the worst failure's, the same as without --json.
    printJson(process.stdout, okEnvelope({ ...data, partial: summary.failures.length > 0 }, next));
    return runExitCode({ failures: summary.failures, unknownOrders: 0 });
  }

  const progress = new Progress(out, p);
  let compared = false;
  const exitWarnings: string[] = [];
  const offers = new Map<StoreId, number>();
  const failed = new Set<StoreId>();
  const blockedAt = new Map<StoreId, string>();

  const onGate = async (g: Gate) => {
    const name = storeName(g.store);
    if (g.step === "cart") {
      const picks = (run.events.find((e) => e.type === "picks") as Extract<RunEvent, { type: "picks" }> | undefined)?.picks ?? [];
      const mine = picks.filter((pk) => pk.offer.store === g.store);
      const yes = await ask(`Fill cart at ${p.bold(name)} (${mine.length} item${mine.length === 1 ? "" : "s"}, ${money({ cents: mine.reduce((s, pk) => s + pk.offer.price.cents, 0), currency: "USD" })})?`);
      hub.answer(run.runId, "cart", g.store, yes);
      if (yes) out.write(p.dim(`${name}: Filling cart\n`));
    } else {
      const yes = await ask(`Review checkout at ${p.bold(name)}? It stops before Place order.`);
      hub.answer(run.runId, "checkout", g.store, yes);
      if (yes) out.write(p.dim(`${name}: Reviewing checkout\n`));
    }
  };

  const onEvent = async (e: RunEvent) => {
    switch (e.type) {
      case "browser":
        out.write(p.dim(`Browser: ${e.label}${e.provider === "local" && e.capabilities.liveLink === "none" ? " (headless)" : ""}\n`));
        break;
      case "parsed":
        out.write(`${p.bold("Looking for")} ${e.request.items.map((i) => (i.quantity > 1 ? `${i.quantity} x ${i.description}` : i.description)).join(", ")}` +
          `${e.request.budget ? p.dim(`, budget ${money(e.request.budget)}`) : ""}\n`);
        for (const s of e.request.stores) progress.set(s, { label: "Starting", tone: "busy" });
        break;
      case "store_started": progress.set(e.store, { label: "Searching", tone: "busy" }); break;
      case "store_waiting":
        if (!compared && !failed.has(e.store)) progress.set(e.store, { label: e.waiting ? e.message ?? "Waiting for the AI fallback" : "Searching", tone: "busy" });
        break;
      case "offers": {
        const n = (offers.get(e.store) ?? 0) + e.offers.length;
        offers.set(e.store, n);
        progress.set(e.store, { label: `Reading prices (${n} offer${n === 1 ? "" : "s"})`, tone: "busy" });
        break;
      }
      case "store_failed": {
        // Same plain words as the web app: what happened and what to do next.
        const f = friendlyError(e.error, e.stage, e.store, e.domain);
        failed.add(e.store);
        if (isBlock(e.error) && !blockedAt.has(e.store)) blockedAt.set(e.store, blockWords(e.error, e.stage));
        if (!compared) progress.set(e.store, { label: `${f.title}. ${f.hint}`, tone: "bad" });
        else out.write(p.red(`${storeName(e.store, e.domain)}: ${f.title}. `) + f.hint + p.dim(` (${shortRaw(f.raw, 120)})`) + "\n");
        // One plain line on a non-Browsa browser that a store blocked.
        if (e.hint) { if (compared) out.write(p.dim(`  ${e.hint}\n`)); else exitWarnings.push(e.hint); }
        break;
      }
      case "picks": {
        const parsed = run.events.find((x): x is Extract<RunEvent, { type: "parsed" }> => x.type === "parsed");
        if (compared) {
          out.write(p.dim(`Picks changed: total ${money(e.total)}\n`));
          break;
        }
        for (const s of parsed?.request.stores ?? []) {
          const n = offers.get(s) ?? 0;
          // A store that failed keeps its failure line (a block stays a block), also when another of its searches found offers.
          if (failed.has(s)) continue;
          if (n) progress.set(s, { label: `Found ${n} offer${n === 1 ? "" : "s"}`, tone: "ok" });
          else progress.set(s, { label: "Nothing found", tone: "warn" });
        }
        progress.stop();
        compared = true;
        const cmp = compareFromEvents(run.events);
        out.write("\n" + renderCompare(cmp, p, { width: out.columns ?? 100 }) + "\n");
        const shipUnknown = e.picks.some((pk) => !pk.offer.shipping);
        out.write(totalLine(e.total, parsed?.request.budget, e.overBudget, p, shipUnknown) + "\n\n");
        for (const w of exitWarnings.splice(0)) out.write(p.yellow(`! ${w}\n\n`));
        if (!e.picks.length) out.write(p.yellow("Nothing found. Try simpler words, like \"usb-c hub\".\n"));
        else if (e.overBudget) out.write(p.yellow("Over budget: carts are not filled. Search again with a higher --budget or fewer items.\n"));
        else if (interactive && mandate) out.write(p.dim(`Next: filling the carts. Checkouts within your up-front approval (${mandateText(mandateLimits(mandate))}) are bought without asking; anything else waits for your y.\n`));
        else if (interactive) out.write(p.dim("Next: fill the carts. You are asked per store, and nothing is bought without a y.\n"));
        if (args.dryRun && e.picks.length && !e.overBudget) {
          out.write(p.bold("Dry run: no cart was changed.") + " Each cart would get:\n");
          for (const c of cartPlan(e.picks, parsed?.request.items ?? [])) {
            out.write(`  ${p.bold(storeName(c.store, c.storeDomain))}: ${c.lines.map((l) => `${l.quantity} x ${l.title.slice(0, 60)}`).join("; ")} (${money(c.subtotal)} before shipping and tax)\n`);
          }
        }
        break;
      }
      case "cart":
        out.write(`${p.bold(storeName(e.cart.store, e.cart.storeDomain))} cart, read back from the store:\n${renderLines(e.cart.lines, p)}\n`);
        for (const w of e.cart.warnings) out.write(p.yellow(`  ! ${w}\n`));
        break;
      case "needs_user":
        out.write(p.yellow(`${storeName(e.store, e.domain)}: Needs you. `) + `${e.needs.message}\n`);
        if (e.needs.liveUrl) out.write(`  Open the live browser: ${e.needs.liveUrl}\n`);
        break;
      case "awaiting_approval": {
        const r = e.review;
        out.write(`\n${p.bold(`${storeName(e.store, r.storeDomain)} checkout`)}\n${renderReview(r, p)}\n`);
        if (e.mandateDeclined) out.write(p.yellow(`Not bought without asking: ${e.mandateDeclined}.\n`));
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
        if (e.result.placed && e.result.approval_source === "mandate" && e.result.mandate) out.write(p.green(`${boughtUnderMandateText(e.result.mandate)} at ${storeName(e.result.store)}: ${e.result.orderId ?? ""} ${money(e.result.total)}`) + "\n");
        else if (e.result.placed) out.write(p.green(`Order placed at ${storeName(e.result.store)}: ${e.result.orderId ?? ""} ${money(e.result.total)}`) + (e.result.confirmationText ? p.dim(` (${e.result.confirmationText})`) : "") + "\n");
        else if (e.result.state === "unknown") out.write(p.yellow(`Order not confirmed at ${storeName(e.result.store)}. `) + `${e.result.checkMessage ?? ""}\n`);
        else out.write(p.red(`Order not placed at ${storeName(e.result.store)}: ${e.result.error ?? e.result.confirmationText ?? e.result.needsUser?.message ?? "unknown"}\n`));
        break;
      case "log":
        if (compared && e.store) out.write(p.dim(`  ${storeName(e.store)}: ${e.message}\n`));
        else if (/may block Browsa's default exit|often block non-US or datacenter browsers|AI fallback is off|showed prices in [A-Z]{3}/.test(e.message)) {
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
  const unknown = summary.orders.filter((o) => o.state === "unknown");
  const upFront = placed.filter((o) => o.approval_source === "mandate").length;
  out.write(p.dim(`\nRun ${summary.runId}: ${placed.length} order${placed.length === 1 ? "" : "s"} placed${upFront ? ` (${upFront} under your up-front approval)` : ""}${unknown.length ? `, ${unknown.length} to check on the store` : ""}, ${summary.failures.length} store failure${summary.failures.length === 1 ? "" : "s"}${creditsText(summary)}.\n`));
  // An order that may have gone through needs the person to look at the store (3). Else a store
  // that failed decides the code (2 store or network, 3 needs you, 4 safety), also when other stores gave results.
  const code = runExitCode({ failures: summary.failures, unknownOrders: unknown.length });
  if (code !== EXIT.ok && summary.failures.length) {
    const names = [...new Set(summary.failures.map((f) => `${storeName(f.store, (f as { domain?: string }).domain)} ${isBlock(f.error) ? blockedAt.get(f.store) ?? blockWords(f.error, f.stage) : `did not finish ${f.stage === "search" ? "its search" : `at ${f.stage.replace("_", " ")}`}`}`))];
    err.write(p.yellow(`Exit code ${code}: ${names.join("; ")}.\n`));
  }
  return code;
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
