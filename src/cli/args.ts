// Argument parsing for the osa CLI. No dependencies.

import type { Money, StoreId } from "../core/types.js";
import { dollarsToMoney } from "../web/format.js";
import { parseProviderId } from "../core/providers/select.js";
import type { ProviderId } from "../core/providers/types.js";
import type { MandateInput } from "../core/mandate.js";

export type Command = "run" | "watch" | "runs" | "orders" | "web" | "mcp" | "help" | "version";

export interface CliArgs {
  command: Command;
  prompt?: string;
  stores?: StoreId[];
  shopifyDomains?: string[];
  zip?: string;
  budget?: Money;
  json: boolean;
  noCart: boolean;
  /** --every-store: a cart at every store with every item. */
  everyStore: boolean;
  demo: boolean;
  watch?: string;
  below?: Money;
  backInStock: boolean;
  port?: number;
  host?: string;
  limit?: number;
  /** --browser browsa|local|cdp (added with browser providers). */
  browser?: ProviderId;
  /** --headless: the local browser runs without a window. */
  headless?: boolean;
  /** --dry-run: compare and show what each cart would get; no cart is changed. */
  dryRun: boolean;
  /** osa orders --all: failed checkouts too. */
  all: boolean;
  /** osa orders refresh [runId]: read the store's order pages. */
  refresh?: boolean;
  runId?: string;
  /**
   * Added in 0.2.0: --approve-up-to 60 [--approve-stores walmart,target] [--approve-expires 2h]
   * [--approve-run-total 100] [--approve-max-orders 2]: buy without asking within these limits.
   * Confirmed once in a terminal unless --yes.
   */
  mandate?: MandateInput;
  /** --yes: the up-front approval needs no confirmation question. */
  yes: boolean;
}

export class CliError extends Error {}

const ALIASES: Record<string, StoreId> = {
  amazon: "amazon", amzn: "amazon", walmart: "walmart", ebay: "ebay", bestbuy: "bestbuy", "best-buy": "bestbuy",
  "best buy": "bestbuy", bby: "bestbuy", target: "target", shopify: "shopify",
};

export function parseStores(value: string): { stores: StoreId[]; shopifyDomains: string[] } {
  const stores: StoreId[] = [];
  const shopifyDomains: string[] = [];
  for (const raw of value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const id = ALIASES[raw] ?? ALIASES[raw.replace(/\.com$/, "")];
    if (id) {
      if (!stores.includes(id)) stores.push(id);
    } else if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))) {
      shopifyDomains.push(raw.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
      if (!stores.includes("shopify")) stores.push("shopify");
    } else {
      throw new CliError(`Unknown store "${raw}". Use amazon, walmart, ebay, bestbuy, target, shopify or a Shopify domain.`);
    }
  }
  if (!stores.length) throw new CliError("--stores needs at least one store");
  return { stores, shopifyDomains };
}

function money(flag: string, v: string | undefined): Money {
  const m = v === undefined ? undefined : dollarsToMoney(v);
  if (!m || m.cents <= 0) throw new CliError(`${flag} needs an amount, like ${flag} 49.99`);
  return m;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { command: "run", json: false, noCart: false, everyStore: false, demo: false, backInStock: false, dryRun: false, all: false, yes: false };
  const approve: Partial<Record<"upTo" | "stores" | "expires" | "runTotal" | "maxOrders", string>> = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const next = () => {
      if (eq > 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined || (v.startsWith("--") && v.length > 2)) throw new CliError(`${name} needs a value`);
      return v;
    };
    switch (name) {
      case "-h": case "--help": out.command = "help"; break;
      case "-v": case "--version": out.command = "version"; break;
      case "--json": out.json = true; break;
      case "--no-cart": out.noCart = true; break;
      case "--dry-run": out.dryRun = true; break;
      case "--all": out.all = true; break;
      case "--every-store": out.everyStore = true; break;
      case "--demo": out.demo = true; break;
      case "--back-in-stock": out.backInStock = true; break;
      case "--stores": case "--store": {
        const s = parseStores(next());
        out.stores = s.stores;
        if (s.shopifyDomains.length) out.shopifyDomains = s.shopifyDomains;
        break;
      }
      case "--zip": {
        const z = next();
        if (!/^\d{5}$/.test(z)) throw new CliError("--zip needs a 5-digit ZIP");
        out.zip = z;
        break;
      }
      case "--budget": out.budget = money("--budget", next()); break;
      case "--below": out.below = money("--below", next()); break;
      case "--watch": out.watch = next().trim(); break;
      case "--port": {
        const p = Number(next());
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new CliError("--port needs a number from 1 to 65535");
        out.port = p;
        break;
      }
      case "--host": out.host = next(); break;
      case "--browser": {
        try { out.browser = parseProviderId(next(), "--browser"); } catch (e) { throw new CliError((e as Error).message); }
        break;
      }
      case "--headless": out.headless = true; break;
      case "--yes": case "-y": out.yes = true; break;
      case "--approve-up-to": approve.upTo = next(); break;
      case "--approve-stores": approve.stores = next(); break;
      case "--approve-expires": approve.expires = next(); break;
      case "--approve-run-total": approve.runTotal = next(); break;
      case "--approve-max-orders": approve.maxOrders = next(); break;
      case "--limit": out.limit = Math.max(1, Math.min(500, Number(next()) || 20)); break;
      default:
        if (a.startsWith("--")) throw new CliError(`Unknown option ${a}. Run osa --help.`);
        words.push(a);
    }
  }
  if (out.command === "help" || out.command === "version") return out;
  if (Object.keys(approve).length) {
    if (!approve.upTo) throw new CliError("--approve-stores, --approve-expires, --approve-run-total and --approve-max-orders need --approve-up-to <amount per order>");
    if (out.json || out.dryRun || out.noCart) throw new CliError("--approve-up-to buys without asking, so it cannot go with --json, --dry-run or --no-cart (they never fill a cart)");
    if (out.watch !== undefined) throw new CliError("--approve-up-to is for a shopping run, not a watch (watches never buy)");
    out.mandate = {
      maxTotal: approve.upTo,
      ...(approve.stores ? { stores: approve.stores } : {}),
      ...(approve.expires ? { expiresIn: approve.expires } : {}),
      ...(approve.runTotal ? { maxRunTotal: approve.runTotal } : {}),
      ...(approve.maxOrders ? { maxOrders: approve.maxOrders } : {}),
    };
  }
  if (out.watch !== undefined) {
    if (!out.watch) throw new CliError("--watch needs an item");
    if (!out.below && !out.backInStock) throw new CliError('--watch needs --below <price> or --back-in-stock');
    out.command = "watch";
    return out;
  }
  const first = words[0];
  if (words.length === 1 && (first === "runs" || first === "orders" || first === "web" || first === "mcp" || first === "help" || first === "version")) {
    if (out.mandate && first !== "help" && first !== "version") {
      throw new CliError(first === "web" ? "Set \"Buy without asking\" on the run in the web app instead of --approve-up-to"
        : first === "mcp" ? "The MCP server takes its up-front approval from its environment (OSA_MCP_APPROVE_UP_TO), not from flags"
        : `--approve-up-to is for a shopping run, not osa ${first}`);
    }
    out.command = first;
    return out;
  }
  // osa orders refresh [run-id]
  if (first === "orders" && words[1] === "refresh" && words.length <= 3) {
    out.command = "orders";
    out.refresh = true;
    if (words[2]) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(words[2])) throw new CliError(`"${words[2]}" is not a run id. Run osa orders to see them.`);
      out.runId = words[2];
    }
    return out;
  }
  const prompt = words.join(" ").trim();
  if (!prompt) {
    out.command = "help";
    return out;
  }
  if (prompt.length > 500) throw new CliError("The request is too long (500 characters at most)");
  out.prompt = prompt;
  return out;
}

export const HELP = `Open Shopping Agent: search stores at once, compare, fill carts, buy only with your OK.

Usage
  osa "usb-c hub and 6 ft hdmi under $60"     find, compare, then ask per store
  osa runs                                    past runs
  osa orders [--all]                          orders placed (and ones to check on the store)
  osa orders refresh [run-id] [--store x]     read each order's page on the store: status, carrier, tracking
  osa web [--port 4319] [--host 127.0.0.1]    start the web app
  osa mcp                                     start the MCP server (stdio)
  osa --watch "6 ft hdmi cable" --below 9.99  price-drop watch (or --back-in-stock)
  osa watch add|list|run|history|remove ...   manage and check watches (osa watch help)

Options
  --stores amazon,walmart,shop.example.com    stores to search (Shopify by domain)
  --zip 82001                                 delivery ZIP
  --budget 60                                 total budget in dollars
  --no-cart                                   compare only, do not fill carts
  --dry-run                                   compare and show what each cart would get; no cart is changed
  --every-store                               a cart at every store with every item (compare real totals)
  --json                                      one JSON reply {ok, v, data, next} (compare only, no carts)
  --demo                                      use made-up demo data
  --browser browsa|local|cdp                  where the browsers run (default: browsa with a key, else your Chrome)
  --headless                                  run your local Chrome without a window

Buy without asking (off by default; you confirm it once with a y, or pass --yes)
  --approve-up-to 60                          buy without asking when a store's checkout total is at most $60
  --approve-stores walmart,target             only at these stores (store names or Shopify domains)
  --approve-expires 2h                        only for this long (default: this run only)
  --approve-run-total 100                     at most this much for all orders of the run
  --approve-max-orders 2                      at most this many orders (default: one per store)
  --yes                                       no confirmation question (needed without a terminal)
  Anything outside these limits waits for your y on the exact total, as without them.

Exit codes
  0 ok, 1 user error, 2 store or network problem (try again later),
  3 needs you (captcha, sign-in, approval, an order to check on the store), 4 safety refusal

Environment
  BROWSA_API_KEY     Browsa key (Phantom browsers)
  OSA_BROWSER        browsa, local (your Chrome or Edge) or cdp
  OSA_CHROME_PATH    browser binary for local (default: the installed Chrome)
  OSA_HEADLESS=1     local browser without a window
  OSA_CDP_URL        ws:// or http:// address of any DevTools browser (cdp); OSA_CDP_HEADERS as JSON
  OSA_LLM            your own model: anthropic:<model>, openai:<model>, openrouter:<model>, google:<model>
  OSA_LLM_API_KEY    key for your own model (parsing, and the AI fallback on every browser)
  OSA_LLM_BASE_URL   any OpenAI-compatible API
  OSA_HOME           settings and history folder (default ./.osa)
  OSA_PROXY          your own proxy for every store: http://user:pass@host:port (free on Browsa)
  OSA_PROXY_AMAZON   a proxy for one store (also WALMART, EBAY, BESTBUY, TARGET, SHOPIFY)
  OSA_PROXIES        a pool rotated per store and run: host1:port,host2:port or @proxies.txt
  OSA_US_EXIT=0      no Browsa residential US exit for Amazon, Target and Best Buy
  OSA_MAX_CREDITS    Browsa credits cap per run (default 40)
`;
