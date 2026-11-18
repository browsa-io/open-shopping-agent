// MCP server over stdio (newline-delimited JSON-RPC 2.0), implemented directly: the protocol
// surface used here (initialize, tools/list, tools/call, ping) is small, so no SDK dependency.
// Tools: find_and_compare, fill_carts, review_checkout, place_order, watch_price, list_runs.

import { createInterface } from "node:readline";
import type { RunEvent, StoreId } from "../core/types.js";
import type { AlertsPort } from "../web/alerts-port.js";
import { ConfigStore, DEFAULT_STORES } from "../web/config.js";
import { createAlerts, createEngine } from "../web/engine-factory.js";
import { STORE_IDS, compareFromEvents, deliveredCents, dollarsToMoney, money, storeName } from "../web/format.js";
import { RunHub, type LiveRun } from "../web/session.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "open-shopping-agent", version: "0.1.0" };

/** OSA_MCP_ALLOW_ORDERS=1 (or true/on/yes) lets place_order spend money; off by default. */
export function mcpOrdersAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env.OSA_MCP_ALLOW_ORDERS ?? "").trim());
}

const storeEnum = { type: "string", enum: STORE_IDS };

export const TOOLS = [
  {
    name: "find_and_compare",
    description:
      "Search several stores at once (Amazon, Walmart, eBay, Best Buy, Target, Shopify stores) for what the user asks for, " +
      "compare price, shipping, delivery, rating and seller, and pick the best offer per item with a one-line reason. " +
      "Read-only: nothing is added to a cart and nothing is bought. Returns a run_id for the next steps, the comparison table and the picks.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", description: 'What to buy, in plain words, e.g. "usb-c hub and 6 ft hdmi cable under $60"' },
        stores: { type: "array", items: storeEnum, description: "Stores to search. Default: the user's allowed stores." },
        shopify_domains: { type: "array", items: { type: "string" }, description: "Shopify store domains to include, e.g. shop.example.com" },
        zip: { type: "string", description: "Delivery ZIP code for prices and delivery dates" },
        budget: { type: "number", description: "Total budget in dollars across all stores" },
      },
      required: ["request"],
    },
  },
  {
    name: "fill_carts",
    description:
      "Add the best picks of a run to each store's cart and read every cart back from the store (options and quantities as the store shows them). " +
      "Does not check out and does not buy. Call after find_and_compare, ideally after the user agreed to the picks.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "run_id from find_and_compare" },
        stores: { type: "array", items: storeEnum, description: "Only these stores. Default: every store with a pick." },
      },
      required: ["run_id"],
    },
  },
  {
    name: "review_checkout",
    description:
      "Go to each filled cart's checkout and stop on the order review page, before the final Place order click. " +
      "Returns per store the lines, subtotal, shipping, tax and total, or what the store needs from the person (sign-in, code, payment) with a Phantom Live link. Does not buy.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        stores: { type: "array", items: storeEnum, description: "Only these stores. Default: every store with a filled cart." },
      },
      required: ["run_id"],
    },
  },
  {
    name: "place_order",
    description:
      "Place a real order at one store. Off unless the server was started with OSA_MCP_ALLOW_ORDERS=1. Spends the user's money. ALWAYS ask the human first: show them the store, items and the exact total from review_checkout " +
      "and wait for an explicit yes. Pass approved_total equal to that review total; the order is refused if it differs, and the agent re-checks the total on the store before clicking.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        store: storeEnum,
        approved_total: { type: "number", description: "The review total in dollars that the human approved, e.g. 41.97" },
      },
      required: ["run_id", "store", "approved_total"],
    },
  },
  {
    name: "watch_price",
    description: "Save a watch that alerts when an item's price drops to a target, or when it is back in stock. Nothing is bought.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "Item description or a product URL" },
        below: { type: "number", description: "Alert at or below this price in dollars (price drop)" },
        back_in_stock: { type: "boolean", description: "Alert when back in stock instead of a price" },
        stores: { type: "array", items: storeEnum },
      },
      required: ["item"],
    },
  },
  {
    name: "list_runs",
    description: "List recent shopping runs with their status, picks total and orders placed.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "At most this many, default 10" } } },
  },
] as const;

type Json = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Json; isError?: boolean };

class ToolError extends Error {}

const last = <T extends RunEvent["type"]>(run: LiveRun, type: T) =>
  [...run.events].reverse().find((e): e is Extract<RunEvent, { type: T }> => e.type === type);

function storesArg(v: unknown): StoreId[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ToolError("stores must be an array");
  return v.map((s) => {
    if (!STORE_IDS.includes(s as StoreId)) throw new ToolError(`Unknown store ${String(s)}`);
    return s as StoreId;
  });
}

function textTable(run: LiveRun): string {
  const lines: string[] = [];
  for (const item of compareFromEvents(run.events)) {
    lines.push(`## ${item.label}`);
    if (item.pick) lines.push(`Best pick: ${item.pick.offer.title} at ${storeName(item.pick.offer.store, item.pick.offer.storeDomain)}, ${money({ cents: deliveredCents(item.pick.offer), currency: "USD" })} delivered. ${item.pick.reason}`);
    lines.push("| | Store | Product | Price | Shipping | Delivery | Rating | Seller |", "|---|---|---|---|---|---|---|---|");
    for (const r of item.rows.slice(0, 8)) {
      const o = r.offer;
      lines.push(`| ${r.best ? "best" : r.alternative ? "alt" : ""} | ${storeName(o.store, o.storeDomain)} | [${o.title.replace(/\|/g, "/")}](${o.url})${o.inStock ? "" : " (out of stock)"} | ${money(o.price)} | ${!o.shipping ? "not shown" : o.shipping.cents === 0 ? "Free" : money(o.shipping)} | ${(o.deliveryText ?? "–").replace(/^Arrives\s+/i, "")} | ${o.rating ? `${o.rating.stars.toFixed(1)} (${o.rating.count})` : ""} | ${o.seller ?? ""} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function createMcpHandler(hub: RunHub, alerts: AlertsPort, config: ConfigStore, opts: { waitMs?: number } = {}) {
  const waitMs = opts.waitMs ?? 300_000;

  const getRun = (id: unknown): LiveRun => {
    const run = typeof id === "string" ? hub.get(id) : undefined;
    if (!run) throw new ToolError(`Unknown or finished run_id ${String(id)}. Start with find_and_compare.`);
    return run;
  };

  async function callTool(name: string, a: Json): Promise<ToolResult> {
    const ok = (text: string, structured: Json): ToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });
    switch (name) {
      case "find_and_compare": {
        const request = typeof a.request === "string" ? a.request.trim() : "";
        if (!request) throw new ToolError("request is required");
        const cfg = await config.effective();
        const budget = a.budget !== undefined ? dollarsToMoney(a.budget as number) : cfg.budget;
        const run = hub.start(request, {
          limits: { allowedStores: storesArg(a.stores) ?? cfg.allowedStores ?? DEFAULT_STORES, budget },
          zip: typeof a.zip === "string" ? a.zip : cfg.zip,
          shopifyDomains: Array.isArray(a.shopify_domains) ? (a.shopify_domains as string[]) : cfg.shopifyDomains,
        });
        await hub.waitFor(run.runId, (r) => !!last(r, "picks") || !!r.summary, waitMs);
        const picks = last(run, "picks");
        const failures = run.events.filter((e): e is Extract<RunEvent, { type: "store_failed" }> => e.type === "store_failed");
        const head = [
          hub.engine.demo ? "DEMO DATA: made-up products and prices, nothing real is bought." : "",
          `run_id: ${run.runId}`,
          picks ? `Total for best picks: ${money(picks.total)}${picks.overBudget ? " (over budget)" : ""}` : "No picks found.",
          ...failures.map((f) => `${storeName(f.store)} failed at ${f.stage}: ${f.error}`),
          "Next: show the picks to the user; fill_carts only if they want to go ahead.",
        ].filter(Boolean).join("\n");
        return ok(`${head}\n\n${textTable(run)}`, {
          run_id: run.runId, demo: hub.engine.demo, total: picks?.total, over_budget: picks?.overBudget ?? false,
          picks: (picks?.picks ?? []).map((p) => ({ item_id: p.itemId, store: p.offer.store, title: p.offer.title, url: p.offer.url, price: p.offer.price, shipping: p.offer.shipping, delivery: p.offer.deliveryText, rating: p.offer.rating, seller: p.offer.seller, reason: p.reason, alternatives: p.alternatives.map((o) => ({ store: o.store, title: o.title, url: o.url, price: o.price })) })),
          failures: failures.map((f) => ({ store: f.store, stage: f.stage, error: f.error })),
        });
      }
      case "fill_carts": {
        const run = getRun(a.run_id);
        const want = storesArg(a.stores);
        await hub.waitFor(run.runId, (r) => r.gates.some((g) => g.step === "cart") || !!r.summary, 10_000).catch(() => run);
        const gates = run.gates.filter((g) => g.step === "cart");
        if (!gates.length) throw new ToolError("No cart is waiting to be filled in this run.");
        const chosen = gates.filter((g) => !want || want.includes(g.store)).map((g) => g.store);
        for (const g of gates) hub.answer(run.runId, "cart", g.store, chosen.includes(g.store));
        await hub.waitFor(run.runId, (r) => chosen.every((s) =>
          r.events.some((e) => (e.type === "cart" && e.cart.store === s) || (e.type === "store_failed" && e.store === s)) || !!r.summary), waitMs);
        const carts = run.events.filter((e): e is Extract<RunEvent, { type: "cart" }> => e.type === "cart" && chosen.includes(e.cart.store)).map((e) => e.cart);
        const text = carts.map((c) => `${storeName(c.store, c.storeDomain)} cart (read back):\n` +
          c.lines.map((l) => `- ${l.quantity} x ${l.title}${l.options ? ` (${Object.values(l.options).join(", ")})` : ""}: ${money(l.price)}`).join("\n") +
          (c.subtotal ? `\nSubtotal ${money(c.subtotal)}` : "") + c.warnings.map((w) => `\nWarning: ${w}`).join("")).join("\n\n");
        return ok(`${text || "No cart was filled."}\n\nNext: review_checkout to see totals with shipping and tax.`, { run_id: run.runId, carts });
      }
      case "review_checkout": {
        const run = getRun(a.run_id);
        const want = storesArg(a.stores);
        await hub.waitFor(run.runId, (r) => r.gates.some((g) => g.step === "checkout") || !!r.summary, 10_000).catch(() => run);
        const gates = run.gates.filter((g) => g.step === "checkout");
        if (!gates.length) throw new ToolError("No filled cart is waiting for checkout review. Call fill_carts first.");
        const chosen = gates.filter((g) => !want || want.includes(g.store)).map((g) => g.store);
        // Only events after this call count: a second review (after a sign-in in Phantom Live) waits for the new answer.
        const from = run.events.length;
        for (const g of gates) if (chosen.includes(g.store)) hub.answer(run.runId, "checkout", g.store, true);
        await hub.waitFor(run.runId, (r) => chosen.every((s) => r.events.slice(from).some((e) =>
          (e.type === "awaiting_approval" && e.store === s) || (e.type === "needs_user" && e.store === s) || (e.type === "store_failed" && e.store === s))) || !!r.summary, waitMs);
        const reviews = chosen.map((s) => {
          const needs = run.events.slice(from).reverse().find((e): e is Extract<RunEvent, { type: "needs_user" }> => e.type === "needs_user" && e.store === s)?.needs;
          const review = hub.pendingReview(run.runId, s);
          return { store: s, review, needs_user: needs };
        });
        const text = reviews.map(({ store, review, needs_user }) => {
          if (needs_user) return `${storeName(store)}: needs the person. ${needs_user.message}${needs_user.liveUrl ? `\nTake over in Phantom Live: ${needs_user.liveUrl}` : ""}${hub.engine.demo ? "" : "\nWhen they are done, call review_checkout again for this store."}`;
          if (!review) return `${storeName(store)}: no review (see failures).`;
          return `${storeName(store, review.storeDomain)} checkout review:\n` + review.lines.map((l) => `- ${l.quantity} x ${l.title}: ${money(l.price)}`).join("\n") +
            `\nSubtotal ${money(review.subtotal)}, shipping ${review.shipping ? money(review.shipping) : "not shown"}, tax ${review.tax ? money(review.tax) : "not shown"}\nTOTAL ${money(review.total)}` +
            (review.shipTo ? `\nShips to ${review.shipTo}` : "") + (review.paymentHint ? `\nPayment: ${review.paymentHint}` : "");
        }).join("\n\n");
        return ok(`${text}\n\nNext: ask the human to approve each total. Only after an explicit yes, call place_order with approved_total equal to the TOTAL.`, {
          run_id: run.runId,
          reviews: reviews.map((r) => ({ store: r.store, total: r.review?.total, subtotal: r.review?.subtotal, shipping: r.review?.shipping, tax: r.review?.tax, lines: r.review?.lines, needs_user: r.needs_user })),
        });
      }
      case "place_order": {
        // Spending money from an AI client is off unless the person who set up the server turned it on:
        // the tool's "ask the human first" is only an instruction to the model, and a page the agent read
        // could talk it into calling this.
        if (!mcpOrdersAllowed()) {
          throw new ToolError("Placing orders from MCP is off. Finish the order in the web app (open-shopping-agent web) or the CLI, " +
            "or set OSA_MCP_ALLOW_ORDERS=1 in this MCP server's env to let your AI client place orders you approve in the chat.");
        }
        const run = getRun(a.run_id);
        const store = storesArg([a.store])![0];
        const approved = typeof a.approved_total === "number" || typeof a.approved_total === "string" ? dollarsToMoney(a.approved_total) : undefined;
        if (!approved) throw new ToolError("approved_total is required: the review total the human approved, in dollars");
        try {
          await hub.approve(run.runId, store, approved);
        } catch (e) {
          throw new ToolError((e as Error).message);
        }
        await hub.waitFor(run.runId, (r) => r.events.some((e) => e.type === "order" && e.result.store === store) || !!r.summary, waitMs);
        const order = [...run.events].reverse().find((e): e is Extract<RunEvent, { type: "order" }> => e.type === "order" && e.result.store === store)?.result;
        if (!order) throw new ToolError("The run ended before the order was confirmed");
        const text = order.placed
          ? `Order placed at ${storeName(store)}: ${order.orderId ?? "(no order number shown)"}, ${money(order.total)}.${order.confirmationText ? ` ${order.confirmationText}` : ""}`
          : `Order NOT placed at ${storeName(store)}: ${order.error ?? order.confirmationText ?? order.needsUser?.message ?? "unknown reason"}`;
        return { ...ok(text, { run_id: run.runId, order }), isError: !order.placed };
      }
      case "watch_price": {
        const back = a.back_in_stock === true;
        const below = a.below !== undefined ? dollarsToMoney(a.below as number) : undefined;
        if (!back && !below) throw new ToolError("Give below (a price in dollars) or back_in_stock: true");
        const item = typeof a.item === "string" ? a.item : "";
        const w = await alerts.create({ kind: back ? "back_in_stock" : "price_drop", item, url: /^https:\/\//.test(item) ? item : undefined, below: back ? undefined : below, stores: storesArg(a.stores) });
        return ok(`Watch saved (${w.id}): ${w.item}, ${back ? "back in stock" : `at or below ${money(w.below)}`}.${alerts.demo ? " Saved locally; checks start when the alerts service runs." : " Checks run with osa watch run."}`, { watch: w });
      }
      case "list_runs": {
        const limit = typeof a.limit === "number" ? Math.max(1, Math.min(100, a.limit)) : 10;
        const runs = await hub.list(limit);
        const text = runs.length ? runs.map((r) => `${r.startedAt.slice(0, 16).replace("T", " ")} ${r.status} ${r.picksTotal ? money(r.picksTotal) : ""} "${r.prompt}" (${r.runId})${r.orders ? `, ${r.orders} order(s)` : ""}`).join("\n") : "No runs yet.";
        return ok(text, { runs });
      }
      default:
        throw new ToolError(`Unknown tool ${name}`);
    }
  }

  /** Handle one JSON-RPC message; returns the response, or undefined for notifications. */
  return async function handle(msg: Json): Promise<Json | undefined> {
    const id = msg.id as string | number | undefined;
    const method = msg.method as string | undefined;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
    if (msg.jsonrpc !== "2.0" || typeof method !== "string") return id === undefined ? undefined : fail(-32600, "Invalid request");
    if (id === undefined) return undefined; // notifications: initialized, cancelled
    const params = (msg.params ?? {}) as Json;
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion as string;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "Shopping across stores on Phantom cloud browsers. find_and_compare is read-only. place_order spends money: always get the human's explicit approval of the exact total first.",
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": {
        const name = params.name as string;
        if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool ${name}`);
        try {
          return reply(await callTool(name, (params.arguments ?? {}) as Json));
        } catch (e) {
          if (e instanceof ToolError || e instanceof Error) return reply({ content: [{ type: "text", text: e.message }], isError: true });
          throw e;
        }
      }
      default: return fail(-32601, `Method not found: ${method}`);
    }
  };
}

export async function startMcpServer(o: { demo?: boolean } = {}): Promise<void> {
  const config = new ConfigStore();
  const engine = await createEngine(await config.effective(), { demo: o.demo });
  const handle = createMcpHandler(new RunHub(engine), createAlerts(), config);
  const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
  // stdout carries the protocol only; any log goes to stderr
  console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    handle(msg).then((res) => res && write(res), (e) => write({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } }));
  });
  rl.on("close", () => process.exit(0));
}
