// The engine: parse -> open one Phantom browser per store -> search every item in every store ->
// pick -> fill carts -> review checkout -> place an order only with the user's matching approval.
//
//   const agent = new ShoppingAgent({ apiKey: process.env.BROWSA_API_KEY });
//   const run = await agent.run("2 USB-C cables under $15 and an HDMI hub", { onEvent, until: "review" });
//   // show run.reviews to the user; when they click Approve:
//   await run.approve("amazon", approvalFor(review));
//   await run.close();
//
// A failing store never fails the run: it gets a "store_failed" event and the others go on.

import type {
  Approval, ApprovalSource, Cart, CheckoutReview, ItemRequest, Limits, Money, NeedsUser, Offer, OrderResult, OrderState, Pick, RunEvent, RunSummary,
  ShoppingRequest, Stage, StoreId,
} from "./types.js";
import type { StoreAdapter, StoreContext } from "../stores/adapter.js";
import { loadAdapter, STORE_NAMES } from "../stores/index.js";
import { currencyNote, formatMoney, isDeadPageError, isExitError, nowIso } from "../stores/util.js";
import { parseRequest, ALL_STORES } from "./parse.js";
import { llmFromEnv, type LLMConfig } from "./llm.js";
import { BrowserPool, defaultDomain, proxyFromText, type BrowserMode, type BrowsaClient, type StoreBrowser } from "./browsers.js";
import { deliveredTotal, markCurrency, pickAll, pickEveryStore, scoreOffers } from "./rank.js";
import { labelSameItem } from "./identity.js";
import { withUnits } from "./units.js";
import { SHOP_CATALOG_TERMS, ShopCatalog, ShopCatalogAuthError, shopCatalogEnabled } from "./shop-catalog.js";
import type { SpendEvent } from "./credits.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
import {
  allowedStores, approvalProblem, CreditMeter, effectiveBudget, forbiddenLines, LimitError, mandateApprovalFor, resolveLimits,
} from "./limits.js";
import { boughtUnderMandateText, invalidMandate, mandateLimits, mandateText, type Mandate, type MandateLimits } from "./mandate.js";
import { newRunId, RunRecorder } from "./history.js";
import { OrderStateError, OrderTracker, approvalId, blocksNewOrder, unknownMessage } from "./order-state.js";
import { extractPage, orderPages, type ConfirmationInfo, type TrackingInfo } from "../orders/index.js";
import {
  BLOCKY_STORES, BrowsaProvider, CdpProvider, LocalProvider, NON_BROWSA_EXIT_WARNING, ProxyPlan, blockedNote, botCheckMessage,
  browsaTaskLlm, chooseProvider, describeFallback, hasProxies, isBotBlock, proxySettingsFrom, toBrowsaProxy,
  type BrowserProvider, type ProviderId, type ProxySettings,
} from "./providers/index.js";

export interface ShoppingAgentOptions {
  /** Browsa API key (agt_...). Default: BROWSA_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  /** A Browsa client (tests, custom transport). Default: new Client from npm `browsa`. */
  client?: BrowsaClient;
  /** LLM for parsing the request. Default: from OSA_LLM and the provider key env; false = rules only. */
  llm?: LLMConfig | false;
  /** Folder for agents.json and run history. Default ".osa". */
  dataDir?: string;
  /** Browser kind per store; see browsers.ts. Default "auto". */
  browserMode?: BrowserMode;
  /** Model for AI fallback tasks on Browsa: "browsa" (default), "browsa-fast", "browsa-smart" or "provider:model". */
  aiLlm?: string;
  aiLlmApiKey?: string;
  aiMaxCredits?: number;
  /**
   * The user's own proxy for every store: "http://user:pass@host:port", "socks5://host:port",
   * "host:port" or Browsa's proxy object. Default: OSA_PROXY. Own proxies are free on Browsa.
   */
  proxy?: string | Record<string, unknown>;
  /** Give Amazon, Target and Best Buy Browsa's residential US exit when the account has it. Default true (OSA_US_EXIT=0 turns it off). */
  usExit?: boolean;
  /** Skip images, video, fonts and ads on exits billed per GB ("residential", default), on all ("always") or never. OSA_SAVE_DATA=0 is "never". */
  saveData?: "residential" | "always" | "never";
  /** Use these adapters instead of src/stores/<id>.ts. */
  adapters?: Partial<Record<StoreId, StoreAdapter>>;
  /** Open a store's browser (tests). Default: a BrowserPool on Browsa. */
  openBrowser?: (store: StoreId, domain: string, spend: (n: number, what: string) => Promise<number>) => Promise<StoreBrowser>;
  /** Offers asked per item per store. Default 8. */
  searchLimit?: number;
  /** Product pages opened per item per store to fill shipping and delivery (adapter.details). Default 2. */
  detailsTop?: number;
  /** Most time one store may spend on the search stage. Default 6 minutes (residential exits load slowly). */
  storeTimeoutMs?: number;
  /** Most time one adapter call may take. Default 2 minutes. */
  stepTimeoutMs?: number;
  /**
   * Most Phantom browsers open at once (OSA_MAX_BROWSERS). With a cap, stores wait their turn, a
   * fresh browser stops right after its search (it opens again for the cart) and after its checkout
   * stop. Default: no cap.
   */
  maxBrowsers?: number;
  /** Stores searched at once. Default 6. */
  concurrency?: number;
  /** Mint a view-only Phantom Live link per store for "store_started". Default true. */
  watchLinks?: boolean;
  /** Save screenshots of carts and reviews. Default true. */
  screenshots?: boolean;
  /** Save the run in <dataDir>/runs/. Default true. */
  history?: boolean;
  /** Default stores when the prompt names none. */
  defaultStores?: StoreId[];
  /**
   * Where the browsers run: "browsa" (Phantom on Browsa), "local" (your Chrome, Edge or Chromium),
   * "cdp" (any DevTools browser at OSA_CDP_URL), or a BrowserProvider. Default: OSA_BROWSER, else
   * browsa when a Browsa key is set, else cdp when OSA_CDP_URL is set, else local.
   */
  browser?: ProviderId | BrowserProvider;
  /** Your own proxies per store and a rotated pool (see providers/proxy.ts). The environment adds to them. */
  proxies?: ProxySettings;
  /** local provider: run headless (default OSA_HEADLESS=1) and the browser binary (default OSA_CHROME_PATH). */
  headless?: boolean;
  chromePath?: string;
  /** cdp provider: the browser's URL and headers (default OSA_CDP_URL, OSA_CDP_HEADERS). */
  cdpUrl?: string;
  cdpHeaders?: Record<string, string>;
  /** Most steps of the AI fallback loop on local and CDP browsers (your own model key). Default 8. */
  aiLoopSteps?: number;
  /**
   * Shop catalog (core/shop-catalog.ts): also find Shopify stores through Shopify's public catalog
   * (anonymous search and GTIN lookup at mcp.shop.com) when "shopify" is one of the run's stores.
   * Off by default; OSA_SHOP_CATALOG=1 (or 0) wins over this. Results open on the store's own site
   * with the Shopify adapter. A ShopCatalog instance (tests) switches it on.
   */
  shopCatalog?: boolean | ShopCatalog;
  /**
   * After the browsers stop, wait this long before counting credits when a browser used an exit
   * billed per GB (its last data charge reaches the ledger a few seconds late). Default 16000.
   */
  creditSettleMs?: number;
  /**
   * After "Place order" errored, timed out or showed no order number: how many times the engine
   * re-reads the page in the same browser for an order number (no reload, no click), and the wait
   * between reads. Defaults 3 and 5000.
   */
  orderVerifyAttempts?: number;
  orderVerifyDelayMs?: number;
  /** After placeOrder timed out, how long its late answer is still awaited before reading the page. Default 30000. */
  orderGraceMs?: number;
  /** Wait after opening an order page before reading it (order tracking). Default 3000. */
  orderReadDelayMs?: number;
}

export interface RunOptions {
  onEvent?: (ev: RunEvent) => void;
  limits?: Partial<Limits>;
  /** Where run() stops: after the picks, after filling carts (default), or at the checkout reviews. */
  until?: "picks" | "cart" | "review";
  /** Close the browsers when run() returns (default: true for "picks", false otherwise). */
  close?: boolean;
  signal?: AbortSignal;
  runId?: string;
  /** Delivery ZIP when the prompt gives none. */
  zip?: string;
  /** Shopify shop domains added to the ones the prompt names. */
  shopifyDomains?: string[];
  /** Stores searched when the prompt names none (default: the agent's defaultStores, else all six). */
  defaultStores?: StoreId[];
  /** Pick every item at each store (a cart per store, to compare real delivered totals) instead of the best store per item. */
  everyStore?: boolean;
  /** Save this run in the run history (default: the agent's `history` option). */
  history?: boolean;
  /**
   * Added in 0.2.0: the person's up-front approval (see core/mandate.ts, made with makeMandate).
   * With it, a checkout review whose total is within the mandate is bought without a prompt; any
   * other review waits for approve() as before, with the reason in "awaiting_approval". Front ends
   * set it only from the person's own input (CLI flags confirmed in a terminal, the web app's
   * confirmed setting, the MCP server's environment), never from a model's tool call.
   */
  mandate?: Mandate;
}

type StageError = { store: StoreId; stage: Stage; error: string; domain?: string };

export class ShoppingAgent {
  readonly options: ShoppingAgentOptions;
  private readonly llm: LLMConfig | undefined;

  constructor(options: ShoppingAgentOptions = {}) {
    this.options = { ...options };
    this.llm = options.llm === false ? undefined : options.llm ?? llmFromEnv();
  }

  /** Parse a prompt into a ShoppingRequest (LLM when configured, else rules). */
  parse(prompt: string, onLog?: (m: string) => void, defaultStores?: StoreId[], hasShopifyDomains?: boolean): Promise<ShoppingRequest> {
    return parseRequest(prompt, { llm: this.llm ?? false, defaultStores: defaultStores ?? this.options.defaultStores, hasShopifyDomains, onLog });
  }

  /** Start a run and carry it to `until`. Returns the run, with browsers open unless closed. */
  async run(input: string | ShoppingRequest, opts: RunOptions = {}): Promise<ShoppingRun> {
    const run = new ShoppingRun(this, opts);
    await run.start(input);
    return run;
  }

  private providerCache?: BrowserProvider;

  /** The browser provider of this agent's runs (see providers/). */
  provider(): BrowserProvider {
    if (this.providerCache) return this.providerCache;
    const b = this.options.browser;
    if (b && typeof b === "object") return (this.providerCache = b);
    const hasKey = !!(this.options.apiKey ?? process.env.BROWSA_API_KEY) || !!this.options.client;
    const id = chooseProvider({ flag: b, hasBrowsaKey: hasKey }).id;
    if (id === "local") {
      this.providerCache = new LocalProvider({
        dataDir: this.options.dataDir ?? ".osa", headless: this.options.headless, chromePath: this.options.chromePath,
        llm: this.llm, aiMaxSteps: this.options.aiLoopSteps,
      });
    } else if (id === "cdp") {
      this.providerCache = new CdpProvider({
        url: this.options.cdpUrl, headers: this.options.cdpHeaders, llm: this.llm, aiMaxSteps: this.options.aiLoopSteps,
        userProxies: hasProxies(this.proxySettings()),
      });
    } else {
      // The engine opens Browsa browsers through its own BrowserPool (credits, live links, exits).
      this.providerCache = new BrowsaProvider(() => { throw new Error("the engine opens Browsa browsers through its pool"); });
    }
    return this.providerCache;
  }

  /** The user's proxies: options.proxies and options.proxy, with the environment on top. */
  proxySettings(): ProxySettings {
    const s = proxySettingsFrom(process.env, this.options.proxies ?? {});
    const p = this.options.proxy;
    if (typeof p === "string" && p.trim()) s.all = p.trim();
    return s;
  }

  /** The AI fallback's model on Browsa: the user's own key when given, else the hosted tier. */
  browsaFallback() {
    return browsaTaskLlm({ llm: this.llm, aiLlm: this.options.aiLlm, aiLlmApiKey: this.options.aiLlmApiKey });
  }

  /** One line about the AI fallback on this provider. */
  fallbackText(id: ProviderId): string {
    return describeFallback(id, this.llm, id === "browsa" ? this.browsaFallback() : undefined);
  }

  /** Internal: the Browsa pool, made on first use. */
  makePool(spend: (n: number, what: string) => Promise<number>, log: (s: StoreId, m: string) => void, plan?: ProxyPlan, signal?: AbortSignal, track?: (e: SpendEvent) => void): BrowserPool | undefined {
    if (this.options.openBrowser) return undefined;
    const apiKey = this.options.apiKey ?? process.env.BROWSA_API_KEY ?? "";
    const p = this.options.proxy ?? process.env.OSA_PROXY;
    const proxy = typeof p === "string" ? proxyFromText(p) : p;
    return new BrowserPool({
      apiKey, baseUrl: this.options.baseUrl ?? process.env.BROWSA_BASE_URL, client: this.options.client,
      proxy, usExit: this.options.usExit ?? process.env.OSA_US_EXIT !== "0",
      saveData: this.options.saveData ?? (process.env.OSA_SAVE_DATA === "0" ? "never" : process.env.OSA_SAVE_DATA === "always" ? "always" : "residential"),
      dataDir: this.options.dataDir ?? ".osa", mode: this.options.browserMode ?? ((process.env.OSA_BROWSERS as BrowserMode) || "auto"),
      ...pickKeys(this.browsaFallback(), ["aiLlm", "aiLlmApiKey", "aiLlmBaseUrl", "aiLlmKeyId"]),
      ...(plan && !plan.empty ? { proxyFor: async (s: StoreId) => { const sp = await plan.forStore(s); return sp ? toBrowsaProxy(sp) : undefined; } } : {}),
      aiMaxCredits: this.options.aiMaxCredits, spend, track, log, signal,
      maxBrowsers: this.options.maxBrowsers ?? (Number(process.env.OSA_MAX_BROWSERS) > 0 ? Math.floor(Number(process.env.OSA_MAX_BROWSERS)) : undefined),
    });
  }
}

interface Shop {
  store: StoreId;
  domain: string;
  key: string;                       // "amazon" or "shopify:allbirds.com"
  adapter: StoreAdapter;
  browser: StoreBrowser;
  ctx: StoreContext;
  abort: AbortController;
}

/** One run: its state, and the steps after the search (carts, review, approval, close). */
export class ShoppingRun {
  readonly runId: string;
  request!: ShoppingRequest;
  limits!: Limits;
  budget?: Money;
  readonly offers: Offer[] = [];
  picks: Pick[] = [];
  total?: Money;
  overBudget = false;
  readonly carts = new Map<string, Cart>();
  readonly reviews = new Map<string, CheckoutReview>();
  readonly orders: OrderResult[] = [];
  readonly failures: StageError[] = [];
  readonly startedAt = nowIso();
  finishedAt?: string;
  creditsUsed?: number;
  /** True when part of creditsUsed is estimated from browser time (Browsa's figures could not be read). */
  creditsEstimated?: boolean;

  private readonly o: ShoppingAgentOptions;
  private readonly shops = new Map<string, Shop>();
  private readonly browsers = new Map<StoreId, Promise<StoreBrowser>>();
  private readonly ordered = new Set<string>();
  /** Order state per shop key: proposed -> awaiting_approval -> placing -> placed | failed | unknown. */
  readonly orderStates = new OrderTracker();
  private readonly recorder?: RunRecorder;
  private meter!: CreditMeter;
  private pool?: BrowserPool;
  /** The browser provider of this run (unset with a custom openBrowser hook). */
  provider?: BrowserProvider;
  /** Opens a store's browser through a provider other than the engine's Browsa pool. */
  private openFn?: (store: StoreId, domain: string) => Promise<StoreBrowser>;
  private closed = false;
  private readonly runAbort = new AbortController();
  /** Shop catalog client when the source is on for this run (see ShoppingAgentOptions.shopCatalog). */
  private catalog?: ShopCatalog;
  /** The person's up-front approval for this run (RunOptions.mandate), when it is valid. */
  readonly mandate?: Mandate;
  /** Why RunOptions.mandate was not used (said once at start). */
  private readonly mandateRefused?: string;
  /** Shop keys with an order under the mandate that is placing, placed or unknown. */
  private readonly mandateOrders = new Set<string>();
  /** Totals of orders being placed now (counted against the budget and the mandate until they settle). */
  private readonly placingTotals = new Map<string, Money>();
  /** The last order result per shop key. */
  private readonly lastResults = new Map<string, OrderResult>();

  constructor(private readonly agent: ShoppingAgent, private readonly opts: RunOptions) {
    this.o = agent.options;
    this.runId = opts.runId ?? newRunId();
    if (opts.mandate !== undefined) {
      const bad = invalidMandate(opts.mandate);
      if (bad) this.mandateRefused = bad;
      else this.mandate = { ...opts.mandate, maxTotal: { ...opts.mandate.maxTotal }, ...(opts.mandate.stores ? { stores: [...opts.mandate.stores] } : {}) };
    }
    if (this.o.history !== false && opts.history !== false) this.recorder = new RunRecorder(this.o.dataDir ?? ".osa", this.runId);
    if (opts.signal) {
      if (opts.signal.aborted) this.runAbort.abort();
      else opts.signal.addEventListener("abort", () => this.runAbort.abort(), { once: true });
    }
  }

  // ------------------------------------------------------------------------------------------
  // events

  private emit(ev: RunEvent): void {
    try { this.opts.onEvent?.(ev); } catch { /* a front end bug must not stop the run */ }
    void this.recorder?.event(ev);
  }

  private log(message: string, store?: StoreId): void {
    this.emit(store ? { type: "log", store, message } : { type: "log", message });
  }

  /** Add a "log" event to the run (front ends use it to record what the person chose). */
  note(message: string, store?: StoreId): void {
    this.log(message, store);
  }

  private fail(store: StoreId, stage: Stage, e: unknown, domain?: string): StageError {
    const error = errText(e);
    const f: StageError = domain && store === "shopify" ? { store, stage, error, domain } : { store, stage, error };
    this.failures.push(f);
    // A bot wall on a browser that does not pass them: hand it to the person, and say what passes it.
    const prov = this.provider;
    const blocked = !!prov && !prov.capabilities.captchaSolving && isBotBlock(e);
    // Browsa tried the check and failed: the adapter made a Phantom Live link for the person.
    const handoff = (e as { handoff?: NeedsUser } | undefined)?.handoff;
    if (handoff) {
      this.emit({ type: "needs_user", store, needs: handoff, ...(f.domain ? { domain: f.domain } : {}) });
    } else if (blocked) {
      this.emit({ type: "needs_user", store, needs: { reason: "captcha_handoff", message: botCheckMessage(prov.id, prov.capabilities) }, ...(f.domain ? { domain: f.domain } : {}) });
    }
    this.emit({ type: "store_failed", ...f, ...(blocked ? { hint: blockedNote(STORE_NAMES[store]) } : {}) });
    return f;
  }

  // ------------------------------------------------------------------------------------------
  // start: parse, open, search, pick, then carts and reviews as asked

  async start(input: string | ShoppingRequest): Promise<void> {
    const plan = this.setupProvider();
    const sc = this.o.shopCatalog;
    if (sc instanceof ShopCatalog ? process.env.OSA_SHOP_CATALOG?.trim() !== "0" : shopCatalogEnabled(sc === true)) {
      this.catalog = sc instanceof ShopCatalog ? sc : new ShopCatalog();
    }
    // With the Shop catalog on, Shopify stays in the default stores: the catalog names the shops.
    this.request = typeof input === "string" ? await this.agent.parse(input, (m) => this.log(m), this.opts.defaultStores, !!this.opts.shopifyDomains?.length || !!this.catalog) : normalizeRequest(input);
    if (this.opts.zip && !this.request.zip) this.request.zip = this.opts.zip;
    if (this.opts.shopifyDomains?.length && this.request.stores.includes("shopify")) {
      this.request.shopifyDomains = [...new Set([...(this.request.shopifyDomains ?? []), ...this.opts.shopifyDomains])];
    }
    this.budget = effectiveBudget(this.limits, this.request);
    this.emit({ type: "parsed", request: this.request });
    if (this.mandate) this.log(`Up-front approval: buy without asking, ${mandateText(mandateLimits(this.mandate))}. Anything else waits for your OK.`);
    else if (this.mandateRefused) this.log(`Up-front approval not used (${this.mandateRefused}); every order waits for your OK`);
    void this.recorder?.request(this.request);
    await this.setupMeter(plan);

    const { stores, refused } = allowedStores(this.request, this.limits);
    for (const s of refused) this.fail(s, "search", new LimitError("store_not_allowed", `${STORE_NAMES[s]} is not in the allowed stores`));
    if (!this.request.items.length) this.log("No items found in the request");

    try {
      if (this.request.items.length && stores.length) {
        const useCatalog = !!this.catalog && stores.includes("shopify");
        await Promise.all([this.searchAll(stores), useCatalog ? this.searchCatalog() : undefined]);
        if (useCatalog) await this.lookupSameItems();
      }
      this.pickNow();
      const closeAll = this.opts.close ?? (this.opts.until === "picks");
      if (!closeAll) await this.releaseUnpicked();
      const until = this.opts.until ?? "cart";
      if (until !== "picks" && this.picks.length) {
        await this.fillCarts();
        if (until === "review") await this.reviewAll();
      }
    } catch (e) {
      if (e instanceof LimitError) this.log(`Stopped: ${e.message}`);
      else throw e;
    } finally {
      await this.writeSummary();
      const close = this.opts.close ?? (this.opts.until === "picks");
      if (close) await this.close();
    }
  }

  /**
   * Read order pages of one store in its browser (the saved store profile), for order tracking.
   * Opens the store's page at each URL with a plain GET and reads it; never clicks, types or signs
   * in. The browser closes before this returns.
   */
  async readOrderPages(store: StoreId, domain: string, urls: string[]): Promise<{ url: string; tracking: TrackingInfo }[]> {
    const plan = this.setupProvider();
    this.request = { prompt: "order tracking", items: [], stores: [store], ...(store === "shopify" ? { shopifyDomains: [domain] } : {}) };
    await this.setupMeter(plan);
    const out: { url: string; tracking: TrackingInfo }[] = [];
    try {
      if (this.pool && (await this.pool.modeFor(store)) === "burner") {
        throw new Error(`Reading ${STORE_NAMES[store]} orders needs a saved store profile (Settings > Saved store profiles, or OSA_BROWSERS=persistent): a fresh browser is not signed in`);
      }
      const shop = await withTimeout(this.openShop(store, domain), this.o.stepTimeoutMs ?? 180_000, `opening ${STORE_NAMES[store]}`);
      const pages = orderPages(store);
      for (const url of urls) {
        if (!/^https:\/\//i.test(url)) continue;
        try {
          await shop.ctx.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await shop.ctx.page.waitForTimeout(this.o.orderReadDelayMs ?? 3000).catch(() => {});
          out.push({ url, tracking: pages.tracking(await extractPage(shop.ctx.page), domain) });
        } catch (e) {
          out.push({ url, tracking: { unreadable: true } });
          this.log(`Order page could not be read: ${errText(e)}`, store);
        }
      }
    } finally {
      await this.close({ settle: false });
    }
    return out;
  }

  /** Limits, the browser provider and its proxy plan. */
  private setupProvider(): ProxyPlan | undefined {
    this.limits = resolveLimits(this.opts.limits);
    let plan: ProxyPlan | undefined;
    if (!this.o.openBrowser) {
      const prov = this.agent.provider();
      this.provider = prov;
      plan = new ProxyPlan(this.agent.proxySettings(), { log: (m) => this.log(m) });
      this.emit({ type: "browser", provider: prov.id, label: prov.label, capabilities: prov.capabilities, fallback: this.agent.fallbackText(prov.id) });
      if (prov.id !== "browsa" || this.o.browser === prov) {
        if (!prov.capabilities.aiFallback) this.log(this.agent.fallbackText(prov.id));
        const p = plan;
        this.openFn = async (store, domain) => prov.open(store, {
          domain, log: (m) => this.log(m, store),
          ...(prov.id === "local" ? { proxy: (await p.forStore(store)) ?? null } : {}),
        });
      }
    }
    return plan;
  }

  /** The credit meter (this run's own browsers and tasks only) and the Browsa pool. */
  private async setupMeter(plan: ProxyPlan | undefined): Promise<void> {
    const client = this.o.client;
    // Only this run's own browsers and tasks count (other runs on the account do not).
    const browsa = (): BrowsaClient | undefined => (this.o.openBrowser || this.openFn ? undefined : client ?? this.pool?.client);
    this.meter = new CreditMeter(this.o.openBrowser || this.openFn ? undefined : {
      ledger: async (limit) => {
        const c = browsa();
        if (typeof c?.listLedger !== "function") throw new Error("no ledger");
        return c.listLedger({ limit });
      },
      agent: async (id) => {
        const c = browsa();
        if (!c) throw new Error("no Browsa client");
        return c.getAgent(id);
      },
    }, this.limits.maxCreditsPerRun);
    this.pool = this.openFn ? undefined : this.agent.makePool((n, what) => this.meter.spend(n, what), (s, m) => this.log(m, s), plan, this.runAbort.signal, (e) => this.meter.track(e));
    await this.meter.begin();
  }

  private shopsToOpen(stores: StoreId[]): { store: StoreId; domain: string }[] {
    const out: { store: StoreId; domain: string }[] = [];
    for (const s of stores) {
      if (s === "shopify") {
        const domains = this.request.shopifyDomains ?? [];
        if (!domains.length && this.catalog) this.log("Shopify stores come from Shop's catalog for this run", "shopify");
        else if (!domains.length) this.fail("shopify", "search", new Error("no Shopify shop domain given (add one like allbirds.com to the request)"));
        for (const d of domains) out.push({ store: s, domain: d });
      } else out.push({ store: s, domain: defaultDomain(s) });
    }
    return out;
  }

  private async searchAll(stores: StoreId[]): Promise<void> {
    const warn = await this.pool?.exitWarning(stores).catch(() => undefined);
    if (warn) this.log(warn);
    if (this.provider && !this.provider.capabilities.residentialExit && stores.some((s) => BLOCKY_STORES.includes(s))) this.log(NON_BROWSA_EXIT_WARNING);
    const targets = this.shopsToOpen(stores);
    const byStore = new Map<StoreId, string[]>();
    for (const t of targets) byStore.set(t.store, [...(byStore.get(t.store) ?? []), t.domain]);
    const limit = Math.max(1, this.o.concurrency ?? 6);
    await mapLimit([...byStore.entries()], limit, async ([store, domains]) => {
      // Shopify shops share one browser and run one after another; other stores run in parallel.
      for (const domain of domains) {
        if (this.runAbort.signal.aborted) return;
        await this.searchStore(store, domain);
      }
      // Browser slots are shared and all in use (another store waits for one): a fresh browser
      // keeps nothing worth a slot, so stop it now; it opens again if this store gets a pick.
      if (this.pool?.capped && (await this.pool.modeFor(store)) === "burner") {
        await this.releaseStore(store, "Stopped this browser after the search to keep within the browser cap (a fresh one opens for the cart)");
      } else if (this.pool?.slotsShort && (await this.pool.modeFor(store)) === "burner") {
        await this.releaseStore(store, "Browser slots are short; stopped this browser after the search (a fresh one opens for the cart)");
      }
    });
  }

  private async getBrowser(store: StoreId, domain: string): Promise<StoreBrowser> {
    if (this.closed) throw new Error("this run is closed");
    let p = this.browsers.get(store);
    if (!p) {
      p = this.o.openBrowser
        ? this.o.openBrowser(store, domain, (n, what) => this.meter.spend(n, what))
        : this.openFn ? this.openFn(store, domain) : this.pool!.openStore(store, domain);
      this.browsers.set(store, p);
      p.catch(() => this.browsers.delete(store));
    }
    return p;
  }

  /** Open the store (adapter, browser, context) once; later steps reuse it. */
  private async openShop(store: StoreId, domain: string): Promise<Shop> {
    const key = shopKey(store, domain);
    const have = this.shops.get(key);
    if (have) return have;
    const adapter = this.o.adapters?.[store] ?? await loadAdapter(store);
    const browser = await this.getBrowser(store, domain);
    const abort = new AbortController();
    this.runAbort.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const ctx = browser.context(domain, { zip: this.request.zip, signal: abort.signal, log: (m) => this.log(m, store) });
    const shop: Shop = { store, domain, key, adapter, browser, ctx, abort };
    this.shops.set(key, shop);
    let liveUrl: string | undefined;
    if (this.o.watchLinks !== false && !this.o.openBrowser && this.pool) {
      try {
        const l = await this.pool.client.createLiveLink(browser.agentId, { scope: "view", ttlSeconds: 3600 });
        liveUrl = l?.live_url;
      } catch { /* watching is optional */ }
    }
    this.emit({ type: "store_started", store, ...(liveUrl ? { liveUrl } : {}), ...(store === "shopify" ? { domain } : {}), ...(browser.exit ? { exit: browser.exit.label } : {}) });
    return shop;
  }

  private async searchStore(store: StoreId, domain: string): Promise<void> {
    let shop: Shop;
    try {
      // With a browser cap the store may wait its turn for a browser: that wait is not its search time.
      shop = await withTimeout(this.openShop(store, domain), this.pool?.capped ? 3_600_000 : this.o.stepTimeoutMs ?? 300_000, `opening ${STORE_NAMES[store]}`);
    } catch (e) {
      this.fail(store, "search", e, domain);
      return;
    }
    const deadline = Date.now() + (this.o.storeTimeoutMs ?? 360_000);
    const limit = this.o.searchLimit ?? 8;
    let failedItems = 0;
    for (const item of this.request.items) {
      if (shop.abort.signal.aborted) break;
      const left = deadline - Date.now();
      if (left <= 0) {
        this.fail(store, "search", new Error(`store timed out after ${Math.round((this.o.storeTimeoutMs ?? 360_000) / 1000)}s`), domain);
        shop.abort.abort();
        return;
      }
      try {
        let offers = await this.step(shop, () => shop.adapter.search(shop.ctx, item, limit), Math.min(left, this.o.stepTimeoutMs ?? 180_000), `searching ${STORE_NAMES[store]}`);
        offers = (Array.isArray(offers) ? offers : []).filter(isOffer).map((o) => ({ ...o, itemId: item.id, store, storeDomain: o.storeDomain || domain }));
        offers = this.checkCurrency(store, domain, offers);
        offers = this.checkCurrency(store, domain, await this.addDetails(shop, item, offers, deadline)).map(withUnits);
        this.offers.push(...offers);
        this.emit({ type: "offers", store, itemId: item.id, offers });
      } catch (e) {
        failedItems++;
        this.log(`Search for "${item.query}" failed: ${errText(e)}`, store);
        if (failedItems === this.request.items.length) this.fail(store, "search", e, domain);
      }
    }
  }

  /** Shops that already got the "showed prices in IDR" note in this run. */
  private currencyNoted = new Set<string>();

  /**
   * Mark offers a store priced in another currency than the run's (USD): they stay in the list,
   * never in the picks or totals. Says so once per shop, in one plain line.
   */
  private checkCurrency(store: StoreId, domain: string, offers: Offer[]): Offer[] {
    const currency = this.budget?.currency ?? "USD";
    const { offers: out, shown } = markCurrency(offers, currency);
    const key = shopKey(store, domain);
    if (shown.length && !this.currencyNoted.has(key)) {
      this.currencyNoted.add(key);
      this.log(currencyNote(store === "shopify" ? domain : STORE_NAMES[store], shown.join(", ")), store);
    }
    return out;
  }

  /** Catalog offers come from many Shopify stores: the same currency rule, noted once per store. */
  private checkCatalogCurrency(offers: Offer[]): Offer[] {
    return offers.map((o) => this.checkCurrency("shopify", o.storeDomain || "", [o])[0]!);
  }

  // ------------------------------------------------------------------------------------------
  // Shop catalog (opt-in): Shopify offers from Shopify's public catalog, opened later on each
  // store's own site by the Shopify adapter. Read-only, anonymous; never Shop's carts or checkout.

  /** The catalog said it needs a sign-in (or failed): say so once and stop using it this run. */
  private catalogFailed(e: unknown): void {
    if (e instanceof ShopCatalogAuthError) {
      this.log(`Shop catalog skipped: ${e.message}`, "shopify");
      this.catalog = undefined;
    } else {
      this.log(`Shop catalog search failed: ${errText(e)}`, "shopify");
    }
  }

  private async searchCatalog(): Promise<void> {
    if (!this.catalog) return;
    this.log(`Searching Shop's catalog of Shopify stores (Shopify's API terms apply: ${SHOP_CATALOG_TERMS})`, "shopify");
    const limit = this.o.searchLimit ?? 8;
    for (const item of this.request.items) {
      if (!this.catalog || this.runAbort.signal.aborted) return;
      try {
        const offers = this.checkCatalogCurrency(await this.catalog.search(item, limit, this.request.zip)).map(withUnits);
        if (!offers.length) continue;
        this.offers.push(...offers);
        this.emit({ type: "offers", store: "shopify", itemId: item.id, offers });
        this.log(`Shop catalog: ${offers.length} offer${offers.length === 1 ? "" : "s"} for "${item.query}" from ${new Set(offers.map((o) => o.storeDomain)).size} Shopify store(s); prices are checked again in the store's own cart`, "shopify");
      } catch (e) {
        this.catalogFailed(e);
      }
    }
  }

  /**
   * GTIN lookup: for each item, the GTINs read from product pages go to Shop's catalog, which names
   * Shopify stores selling exactly that product. Those offers are added as exact matches.
   */
  private async lookupSameItems(): Promise<void> {
    for (const item of this.request.items) {
      if (!this.catalog || this.runAbort.signal.aborted) return;
      const mine = this.offers.filter((o) => o.itemId === item.id);
      // GTINs from the stores' own product pages (not from the catalog's answers), best first.
      const ranked = scoreOffers(item, mine.filter((o) => o.raw?.source !== "shop_catalog"), { goal: this.request.goal, currency: this.budget?.currency });
      const gtins = [...new Set(ranked.flatMap((s) => (s.offer.ids?.gtin ? [s.offer.ids.gtin] : [])))].slice(0, 5);
      if (!gtins.length) continue;
      try {
        // GTIN-14 with leading zeros back to the UPC/EAN the catalog knows.
        const asked = gtins.map((g) => g.replace(/^0+(?=\d{12,13}$)/, ""));
        const found = await this.catalog.lookupGtins(asked, item.id);
        const have = new Set(mine.map((o) => `${o.storeDomain}|${o.url}`));
        const add = this.checkCatalogCurrency([...found.values()].flat().filter((o) => !have.has(`${o.storeDomain}|${o.url}`))).map(withUnits);
        if (!add.length) continue;
        this.offers.push(...add);
        this.emit({ type: "offers", store: "shopify", itemId: item.id, offers: add });
        this.log(`Shop catalog: the same product (GTIN) at ${new Set(add.map((o) => o.storeDomain)).size} Shopify store(s) for "${item.query}"`, "shopify");
      } catch (e) {
        this.catalogFailed(e);
      }
    }
  }

  private async addDetails(shop: Shop, item: ItemRequest, offers: Offer[], deadline: number): Promise<Offer[]> {
    const n = this.o.detailsTop ?? 2;
    if (!shop.adapter.details || n <= 0 || !offers.length) return offers;
    const top = scoreOffers(item, offers, { goal: this.request.goal, currency: this.budget?.currency }).filter((s) => !s.excluded).slice(0, n).map((s) => s.offer);
    const out = [...offers];
    for (const o of top) {
      const left = deadline - Date.now();
      if (left <= 5_000 || shop.abort.signal.aborted) break;
      try {
        const d = await this.step(shop, () => shop.adapter.details!(shop.ctx, o), Math.min(left, this.o.stepTimeoutMs ?? 120_000), "product page");
        if (d && isOffer(d)) out[out.indexOf(o)] = { ...o, ...d, itemId: o.itemId, store: o.store, storeDomain: o.storeDomain };
      } catch (e) {
        this.log(`Product page of "${o.title.slice(0, 60)}" failed: ${errText(e)}`, shop.store);
      }
    }
    return out;
  }

  /**
   * Stop the browsers of stores that got no pick: nothing more happens there, and it frees
   * browser slots and credits for the stores that fill carts.
   */
  private async releaseUnpicked(): Promise<void> {
    const picked = new Set(this.picks.map((p) => p.offer.store));
    for (const store of [...this.browsers.keys()]) {
      if (!picked.has(store)) await this.releaseStore(store, "No pick here; stopped this store's browser");
    }
  }

  /**
   * Stop a store's browser now when browsers are capped (OSA_MAX_BROWSERS), e.g. once its checkout
   * stop is reached, so the next store can open one. Its Phantom Live link stops working. No-op
   * without a cap.
   */
  /** True when this run's browsers are capped (OSA_MAX_BROWSERS). */
  get capped(): boolean { return !!this.pool?.capped; }

  async releaseCapped(store: StoreId): Promise<void> {
    if (!this.pool?.capped || this.closed) return;
    await this.releaseStore(store, "Stopped this browser to keep within the browser cap (OSA_MAX_BROWSERS); its live link is closed");
  }

  /** Stop one store's browser and forget its shops; a later step opens a fresh one. */
  private async releaseStore(store: StoreId, note: string): Promise<void> {
    const p = this.browsers.get(store);
    if (!p) return;
    this.browsers.delete(store);
    for (const [k, s] of [...this.shops.entries()]) if (s.store === store) { s.abort.abort(); this.shops.delete(k); }
    try {
      await (await p).close();
      this.log(note, store);
    } catch { /* it never opened */ }
  }

  /**
   * One adapter step with a deadline. When the store's tab died under it (crash, closed, dropped
   * connection), open a fresh tab in the same browser and run the step once more. Never used for
   * placeOrder.
   */
  private async step<T>(shop: Shop, fn: () => Promise<T>, ms: number, what: string): Promise<T> {
    try {
      return await withTimeout(fn(), ms, what);
    } catch (e) {
      if (!(await this.renewDeadTab(shop, e)) && !(await this.renewBrowser(shop, e))) throw e;
      return withTimeout(fn(), ms, what);
    }
  }

  /** Browser renewals per store in this run (an exit that failed the tunnel). */
  private renewals = new Map<StoreId, number>();

  /**
   * For an exit error (the proxy tunnel failed, e.g. net::ERR_TUNNEL_CONNECTION_FAILED): stop the
   * store's browser and open a fresh one on the same exit, which on a residential exit is a fresh
   * address, then rebind the store's shops to it. At most twice per store per run; never for a
   * saved profile (same address). The fresh browser has an empty cart.
   */
  private async renewBrowser(shop: Shop, e: unknown): Promise<boolean> {
    if (!isExitError(e) || shop.abort.signal.aborted || this.closed) return false;
    if (shop.browser.mode === "persistent") return false;
    const n = this.renewals.get(shop.store) ?? 0;
    if (n >= 2) return false;
    this.renewals.set(shop.store, n + 1);
    this.log(`The exit could not reach the store (${errText(e).match(/net::ERR_\w+/)?.[0] ?? "proxy error"}); retrying in a fresh browser (new address)`, shop.store);
    const old = this.browsers.get(shop.store);
    this.browsers.delete(shop.store);
    await old?.then((b) => b.close()).catch(() => {});
    try {
      const nb = await this.getBrowser(shop.store, shop.domain);
      for (const s of this.shops.values()) {
        if (s.store !== shop.store) continue;
        s.browser = nb;
        s.ctx = nb.context(s.domain, { zip: this.request.zip, signal: s.abort.signal, log: (m) => this.log(m, s.store) });
      }
      return true;
    } catch (x) {
      this.log(`A fresh browser could not be opened: ${errText(x)}`, shop.store);
      return false;
    }
  }

  /** For a dead-tab error: replace the tab (ctx.newPage) and return true; else false. */
  private async renewDeadTab(shop: Shop, e: unknown): Promise<boolean> {
    if (!isDeadPageError(e) || shop.abort.signal.aborted || this.closed) return false;
    this.log(`The browser tab died (${errText(e).split("\n")[0].slice(0, 120)}); retrying in a fresh tab`, shop.store);
    try { await shop.ctx.newPage(); return true; } catch (x) { this.log(`A fresh tab could not be opened: ${errText(x)}`, shop.store); return false; }
  }

  private pickNow(): void {
    const opts = { budget: this.budget, currency: this.budget?.currency ?? "USD" };
    const r = this.opts.everyStore ? pickEveryStore(this.request, this.offers, opts) : pickAll(this.request, this.offers, opts);
    if (this.opts.everyStore) this.log("Every store: each store gets its own cart with every item, to compare real delivered totals");
    // Each alternative says whether it is the same product as the pick (GTIN, or brand and MPN).
    this.picks = r.picks.map((p) => ({ ...p, alternatives: labelSameItem(p.offer, p.alternatives) }));
    this.total = r.total;
    this.overBudget = r.overBudget;
    for (const u of r.unpicked) {
      const item = this.request.items.find((i) => i.id === u.itemId);
      this.log(u.itemId === "*" ? `No cart: ${u.reason}` : `No pick for "${item?.query ?? u.itemId}": ${u.reason}`);
    }
    this.emit({ type: "picks", picks: this.picks, total: r.total, overBudget: r.overBudget });
    if (r.overBudget && this.budget) this.log(`The picks come to ${formatMoney(r.total)}, over the ${formatMoney(this.budget)} budget`);
  }

  // ------------------------------------------------------------------------------------------
  // carts

  /** Add every pick to its store's cart and read the carts back. Refuses when over budget. */
  async fillCarts(): Promise<Cart[]> {
    return this.fillPicks(this.picks);
  }

  /**
   * Fill one store's cart with its picks and read it back (for Shopify: one shop, or every shop
   * when domain is omitted). Lets a front end ask the person per store. Refuses when over budget.
   */
  async fillCart(store: StoreId, domain?: string): Promise<Cart[]> {
    return this.fillPicks(this.picks.filter((p) => p.offer.store === store && (!domain || p.offer.storeDomain === domain)));
  }

  private async fillPicks(picks: Pick[]): Promise<Cart[]> {
    this.assertOpen();
    if (this.overBudget) {
      throw new LimitError("budget", `the picks total ${formatMoney(this.total)} is over the ${formatMoney(this.budget)} budget; change the request or raise the budget`);
    }
    const groups = new Map<string, Pick[]>();
    for (const p of picks) {
      const k = shopKey(p.offer.store, p.offer.storeDomain);
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    const out: Cart[] = [];
    const ordered = [...groups.entries()];
    // Shopify shops share a browser: run their groups one after another.
    const byStore = new Map<StoreId, [string, Pick[]][]>();
    for (const g of ordered) {
      const store = g[1][0].offer.store;
      byStore.set(store, [...(byStore.get(store) ?? []), g]);
    }
    await mapLimit([...byStore.values()], Math.max(1, this.o.concurrency ?? 6), async (gs) => {
      for (const [, picks] of gs) {
        const cart = await this.fillOne(picks);
        if (cart) out.push(cart);
      }
    });
    await this.writeSummary();
    return out;
  }

  private async fillOne(picks: Pick[]): Promise<Cart | undefined> {
    const { store, storeDomain } = picks[0].offer;
    let shop: Shop;
    try {
      shop = await this.openShop(store, storeDomain);
    } catch (e) {
      this.fail(store, "cart", e, storeDomain);
      return undefined;
    }
    let cart: Cart | undefined;
    // On an exit error the store gets a fresh browser (new address, empty cart): add every pick again.
    for (let round = 0; round < 3; round++) {
      let exitErr: { e: unknown; p: Pick } | undefined;
      for (const p of picks) {
        if (p.offer.subscription) { if (round === 0) this.log(`Skipped a subscription offer: ${p.offer.title}`, store); continue; }
        const item = this.request.items.find((i) => i.id === p.itemId);
        try {
          const ms = this.o.stepTimeoutMs ?? 180_000; // opening the item from the results takes longer on slow exits
          try {
            cart = await withTimeout(shop.adapter.addToCart(shop.ctx, p.offer, item?.quantity ?? 1, item?.options), ms, "adding to the cart");
          } catch (e) {
            if (!(await this.renewDeadTab(shop, e))) throw e;
            // The add may have gone through before the tab died: read the cart before adding again.
            const now = await withTimeout(shop.adapter.readCart(shop.ctx), ms, "reading the cart");
            const there = now.lines.some((l) => (p.offer.productId && l.productId === p.offer.productId) || l.url === p.offer.url);
            cart = there ? now : await withTimeout(shop.adapter.addToCart(shop.ctx, p.offer, item?.quantity ?? 1, item?.options), ms, "adding to the cart");
          }
        } catch (e) {
          if (isExitError(e)) { exitErr = { e, p }; break; }
          // A slow page can time the step out after the add went through (seen live on Best Buy):
          // the cart decides.
          if (/timed out after/.test(errText(e)) && !shop.abort.signal.aborted) {
            const now = await withTimeout(shop.adapter.readCart(shop.ctx), this.o.stepTimeoutMs ?? 120_000, "reading the cart").catch(() => undefined);
            if (now?.lines.some((l) => (p.offer.productId && l.productId === p.offer.productId) || l.url === p.offer.url)) {
              this.log(`Adding "${p.offer.title.slice(0, 60)}" timed out, but the cart shows it`, store);
              cart = now;
              continue;
            }
          }
          this.fail(store, "cart", new Error(`"${p.offer.title.slice(0, 60)}": ${errText(e)}`), storeDomain);
        }
      }
      if (!exitErr) break;
      if (await this.renewBrowser(shop, exitErr.e)) { cart = undefined; continue; }
      this.fail(store, "cart", new Error(`"${exitErr.p.offer.title.slice(0, 60)}": ${errText(exitErr.e)}`), storeDomain);
      break;
    }
    if (!cart) {
      try { cart = await this.step(shop, () => shop.adapter.readCart(shop.ctx), this.o.stepTimeoutMs ?? 120_000, "reading the cart"); } catch { return undefined; }
    }
    const bad = forbiddenLines(cart.lines);
    if (bad.length) cart = { ...cart, warnings: [...cart.warnings, ...bad.map((b) => `The cart has a ${b.why} line: ${b.line.title}. Remove it before checkout.`)] };
    this.carts.set(shop.key, cart);
    this.emit({ type: "cart", cart });
    if (this.o.screenshots !== false) {
      const path = await this.recorder?.screenshot(store, "cart", shop.ctx.page);
      if (path) this.log(`Screenshot: ${path}`, store);
    }
    return cart;
  }

  // ------------------------------------------------------------------------------------------
  // checkout review and approval

  private async reviewAll(): Promise<void> {
    const keys = [...this.carts.keys()];
    const groups = new Map<StoreId, string[]>();
    for (const k of keys) {
      const shop = this.shops.get(k);
      if (shop) groups.set(shop.store, [...(groups.get(shop.store) ?? []), shop.domain]);
    }
    await mapLimit([...groups.entries()], Math.max(1, this.o.concurrency ?? 6), async ([store, domains]) => {
      for (const d of domains) {
        try { await this.reviewCheckout(store, d); } catch { /* reported as store_failed */ }
      }
    });
  }

  /** Go to the store's checkout and stop on the review page. Emits awaiting_approval or needs_user. */
  async reviewCheckout(store: StoreId, domain?: string): Promise<CheckoutReview> {
    this.assertOpen();
    const shop = this.findShop(store, domain);
    if (!shop) throw new Error(`${STORE_NAMES[store]} has no cart in this run`);
    // After an order that is (or may be) placed, or while placing, the checkout is not opened again.
    const now = this.orderStates.state(shop.key);
    if (blocksNewOrder(now)) {
      throw new LimitError("approval", now === "placed"
        ? `An order was already placed at ${STORE_NAMES[store]} in this run`
        : now === "placing" ? `An order at ${STORE_NAMES[store]} is being placed now`
        : `The last order at ${STORE_NAMES[store]} may have gone through; check your orders on the store before you try again`);
    }
    let review: CheckoutReview;
    try {
      const ms = this.o.stepTimeoutMs ?? 180_000;
      try {
        review = await withTimeout(shop.adapter.reviewCheckout(shop.ctx), ms, "checkout review");
      } catch (e) {
        if (await this.renewDeadTab(shop, e)) {
          review = await withTimeout(shop.adapter.reviewCheckout(shop.ctx), ms, "checkout review");
        } else if (await this.renewBrowser(shop, e)) {
          // A fresh browser has an empty cart: fill it again, then review.
          await this.fillOne(this.picks.filter((p) => shopKey(p.offer.store, p.offer.storeDomain) === shop.key));
          review = await withTimeout(shop.adapter.reviewCheckout(shop.ctx), ms, "checkout review");
        } else throw e;
      }
    } catch (e) {
      this.fail(store, "checkout", e, shop.domain);
      throw e;
    }
    review = { ...review, store, storeDomain: review.storeDomain || shop.domain, reviewedAt: review.reviewedAt || nowIso() };
    this.reviews.set(shop.key, review);
    const dom = store === "shopify" ? { domain: shop.domain } : {};
    if (this.o.screenshots !== false) {
      const path = await this.recorder?.screenshot(store, "review", shop.ctx.page);
      if (path) this.log(`Screenshot: ${path}`, store);
    }
    this.moveOrder(shop, "proposed", { total: review.total });
    if (review.needsUser) {
      this.emit({ type: "needs_user", store, needs: review.needsUser, ...dom });
    } else {
      this.emit({ type: "checkout_review", review });
      const bad = forbiddenLines(review.lines);
      if (bad.length) this.log(`The checkout has a ${bad[0].why} line (${bad[0].line.title}); it cannot be approved`, store);
      if (this.budget && this.placedTotal().cents + review.total.cents > this.budget.cents) {
        this.log(`The checkout total ${formatMoney(review.total)} would go over the ${formatMoney(this.budget)} budget; it cannot be approved`, store);
      }
      this.moveOrder(shop, "awaiting_approval", { total: review.total });
      let declined: string | undefined;
      if (this.mandate) {
        // The person approved up front: the engine makes the approval from this review and places
        // the order through the same gate as a clicked approval. Outside the mandate it asks.
        const approval = mandateApprovalFor(review, this.mandate);
        declined = this.gateProblem(shop, review, approval);
        if (!declined) {
          this.log(`Buying without asking: ${formatMoney(review.total)} is within your up-front approval (${mandateText(mandateLimits(this.mandate))})`, store);
          try {
            await this.placeWith(store, approval, store === "shopify" ? shop.domain : undefined);
            return review;
          } catch (e) {
            // Refused by the gate before anything happened at the store (another order took the room): ask.
            if (!(e instanceof LimitError) || this.orderStates.state(shop.key) !== "awaiting_approval") throw e;
            declined = e.message.replace(/^Order not placed: /, "");
          }
        }
        this.log(`Not bought without asking: ${declined}. It waits for your OK of the exact total.`, store);
      }
      this.emit({ type: "awaiting_approval", store, review, ...dom, ...(declined ? { mandateDeclined: declined } : {}) });
    }
    await this.writeSummary();
    return review;
  }

  /** The gate's answer for this approval of this shop's review, with the run's limits and mandate. */
  private gateProblem(shop: Shop, review: CheckoutReview | undefined, approval: Approval | undefined): string | undefined {
    return approvalProblem({
      store: shop.store, storeDomain: shop.store === "shopify" ? shop.domain : undefined, review, approval, limits: this.limits,
      budget: this.budget, placed: this.committedTotal(), ordered: this.ordered,
      mandate: this.mandate, mandateOrders: this.mandateOrders.size,
    });
  }

  /** The last order result at this store (Shopify: this shop) in the run. */
  orderResult(store: StoreId, domain?: string): OrderResult | undefined {
    const shop = this.findShop(store, domain);
    return shop ? this.lastResults.get(shop.key) : undefined;
  }

  /** The order state of this store's checkout (Shopify: this shop). */
  orderStateOf(store: StoreId, domain?: string): OrderState | undefined {
    const shop = this.findShop(store, domain);
    return shop ? this.orderStates.state(shop.key) : undefined;
  }

  /**
   * Place the order, only when the approval matches this run's review of the store exactly and the
   * limits hold. Throws LimitError("approval") otherwise, without touching the store.
   */
  async approve(store: StoreId, approval: Approval, domain?: string): Promise<OrderResult> {
    // An approval under the mandate is made by the engine only (in reviewCheckout), never handed in.
    if (approval?.source === "mandate") {
      const msg = "Order not placed: an up-front approval is applied by the engine itself; approve the exact total instead";
      this.log(msg, store);
      throw new LimitError("approval", msg);
    }
    return this.placeWith(store, approval, domain);
  }

  /** The approval gate, then the adapter's Place order (it re-reads the total first), then the order state. */
  private async placeWith(store: StoreId, approval: Approval, domain?: string): Promise<OrderResult> {
    this.assertOpen();
    const shop = this.findShop(store, domain ?? approval?.storeDomain);
    const review = shop ? this.reviews.get(shop.key) : undefined;
    let problem = shop ? this.gateProblem(shop, review, approval) : approvalProblem({
      store, review, approval, limits: this.limits, budget: this.budget, placed: this.committedTotal(), ordered: this.ordered,
      mandate: this.mandate, mandateOrders: this.mandateOrders.size,
    });
    const state = shop ? this.orderStates.state(shop.key) : undefined;
    if (!problem && shop) {
      if (state === "placing") problem = "this order is being placed now";
      else if (state === "placed") problem = "an order was already placed for this store in this run";
      else if (state === "unknown") problem = "the last order at this store may have gone through; check your orders on the store before you try again";
      else if (state !== "awaiting_approval") problem = "this checkout is not waiting for approval; review it again";
    }
    // One approval places at most one order: the same approval sent twice (a double click) is refused.
    const id = approval?.approvedTotal ? approvalId(this.runId, approval) : undefined;
    if (!problem && shop && id && !this.orderStates.useApproval(id)) problem = "this approval was already used";
    if (problem || !shop || !review || !id) {
      const msg = `Order not placed: ${problem ?? "no store"}`;
      this.log(msg, store);
      throw new LimitError("approval", msg);
    }
    // Mark first so a second approve() for the same store cannot race this one.
    this.ordered.add(shop.key);
    const source: ApprovalSource = approval.source === "mandate" ? "mandate" : "user";
    const how = source === "mandate" && this.mandate ? { approval_source: source, mandate: mandateLimits(this.mandate) } : { approval_source: source };
    if (source === "mandate") this.mandateOrders.add(shop.key);
    // Counted against the budget and the mandate while it is placed, so a parallel order cannot pass the gate on the same room.
    this.placingTotals.set(shop.key, approval.approvedTotal);
    this.moveOrder(shop, "placing", { approvalId: id, total: approval.approvedTotal, ...how });
    await this.writeSummary(); // "placing" is in the history before the click

    let raw: OrderResult | undefined;
    let thrown: unknown;
    const call = shop.adapter.placeOrder(shop.ctx, approval);
    call.catch(() => {}); // a late rejection after a timeout is handled below, never unhandled
    try {
      raw = await withTimeout(call, this.o.stepTimeoutMs ?? 180_000, "placing the order");
    } catch (e) {
      thrown = e;
      // The adapter may still be on the page after a timeout: wait for it before reading the page.
      if (/timed out after/.test(errText(e))) {
        const late = await withTimeout(call, this.o.orderGraceMs ?? 30_000, "placing the order").catch(() => undefined);
        if (late) { raw = late; thrown = undefined; this.log("Placing the order answered after its time limit", store); }
      }
    }
    if (thrown) this.fail(store, "place_order", thrown, shop.domain);
    const result: OrderResult = { ...(await this.settleOrder(shop, approval, id, raw, thrown)), ...how };
    this.placingTotals.delete(shop.key);
    this.lastResults.set(shop.key, result);

    if (result.state === "failed" && result.error) this.log(`Order not placed: ${result.error}`, store);
    if (result.state === "unknown") this.log(`Order state unknown${result.error ? ` (${result.error})` : ""}. ${result.checkMessage}`, store);
    if (result.placed && result.total && result.total.cents > approval.approvedTotal.cents) {
      this.log(`The store charged ${formatMoney(result.total)}, more than the approved ${formatMoney(approval.approvedTotal)}`, store);
    }
    // Only a failure the agent knows about (nothing submitted, nobody needed) frees the store again.
    if (result.state === "failed" && !result.needsUser) this.ordered.delete(shop.key);
    // Nothing was submitted: it does not count as an order under the mandate.
    if (result.state === "failed") this.mandateOrders.delete(shop.key);
    if (result.state === "placed" && source === "mandate" && this.mandate) this.log(`${boughtUnderMandateText(this.mandate)}: ${formatMoney(result.total ?? approval.approvedTotal)}`, store);
    this.moveOrder(shop, result.state!, {
      approvalId: id, orderId: result.orderId, orderUrl: result.orderUrl, total: result.total ?? approval.approvedTotal,
      message: result.state === "unknown" ? result.checkMessage : result.state === "failed" ? result.error : undefined, ...how,
    });
    if (result.needsUser) this.emit({ type: "needs_user", store, needs: result.needsUser, ...(store === "shopify" ? { domain: shop.domain } : {}) });
    this.orders.push(result);
    this.emit({ type: "order", result });
    if (this.o.screenshots !== false) {
      const path = await this.recorder?.screenshot(store, "order", shop.ctx.page);
      if (path) this.log(`Screenshot: ${path}`, store);
    }
    await this.writeSummary();
    return result;
  }

  /**
   * Decide placed, failed or unknown from what placeOrder returned (or threw). Only an order number
   * counts as placed. When the click may have happened and no number came back, the page is read
   * again in the same browser (no reload, no click) for the store's confirmation.
   */
  private async settleOrder(shop: Shop, approval: Approval, id: string, raw: OrderResult | undefined, thrown: unknown): Promise<OrderResult> {
    const { store } = shop;
    const pages = orderPages(store);
    const ordersUrl = pages.ordersUrl(shop.domain);
    const base = { store, approvalId: id, ordersUrl };
    // The adapter saw an order number on the confirmation page.
    if (!thrown && raw?.placed && raw.orderId) {
      const conf = await this.readConfirmation(shop, 1, 0);
      return {
        ...raw, ...base, placed: true, state: "placed", placedAt: raw.placedAt ?? nowIso(),
        orderUrl: raw.orderUrl ?? (conf?.orderId === raw.orderId ? conf.orderUrl : undefined) ?? pages.orderUrl(raw.orderId, shop.domain),
      };
    }
    // Refused before the click (the total changed, the store needs the person first).
    if (!thrown && raw && !raw.placed && !raw.submitted && (raw.error || raw.needsUser)) {
      return { ...raw, ...base, placed: false, state: "failed" };
    }
    // The click may have gone through: only the store's confirmation decides.
    const conf = await this.readConfirmation(shop);
    if (conf) {
      this.log(`The store's confirmation page shows order ${conf.orderId}`, store);
      return {
        ...(raw ?? {}), ...base, placed: true, state: "placed", orderId: conf.orderId, orderUrl: conf.orderUrl ?? pages.orderUrl(conf.orderId, shop.domain),
        total: raw?.total ?? conf.total ?? approval.approvedTotal, confirmationText: raw?.confirmationText ?? conf.confirmationText, placedAt: raw?.placedAt ?? nowIso(),
        error: undefined, needsUser: undefined,
      };
    }
    const why = thrown ? errText(thrown) : raw?.placed ? "the store showed no order number" : raw?.error ?? raw?.needsUser?.message ?? "the store did not confirm the order";
    return {
      ...(raw ?? {}), ...base, placed: false, state: "unknown", submitted: raw?.submitted ?? true, error: why,
      total: raw?.total ?? approval.approvedTotal, checkMessage: unknownMessage(STORE_NAMES[store] === "Shopify" ? shop.domain : STORE_NAMES[store], ordersUrl),
    };
  }

  /** Read the page as it is now, a few times, for the store's order confirmation with an order number. */
  private async readConfirmation(shop: Shop, attempts = this.o.orderVerifyAttempts ?? 3, delayMs = this.o.orderVerifyDelayMs ?? 5000): Promise<ConfirmationInfo | undefined> {
    const pages = orderPages(shop.store);
    for (let i = 0; i < Math.max(1, attempts); i++) {
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      try {
        const conf = pages.confirmation(await extractPage(shop.ctx.page, 15_000), shop.domain);
        if (conf) return conf;
      } catch { /* a dead or busy tab: try again, then give up */ }
    }
    return undefined;
  }

  /** Move one store's order state and record it (event and history). A move the machine refuses is logged, not thrown. */
  private moveOrder(shop: Shop, to: OrderState, extra: { approvalId?: string; orderId?: string; orderUrl?: string; total?: Money; message?: string; approval_source?: ApprovalSource; mandate?: MandateLimits } = {}): void {
    let at: string;
    try {
      at = this.orderStates.move(shop.key, to, { store: shop.store, domain: shop.store === "shopify" ? shop.domain : undefined, orderId: extra.orderId, message: extra.message }).at;
    } catch (e) {
      if (e instanceof OrderStateError) { this.log(`Order state not changed: ${e.message}`, shop.store); return; }
      throw e;
    }
    const ev: RunEvent = { type: "order_state", store: shop.store, state: to, at, ...(shop.store === "shopify" ? { domain: shop.domain } : {}) };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) (ev as Record<string, unknown>)[k] = v;
    this.emit(ev);
  }

  private placedTotal(): Money {
    const currency = this.budget?.currency ?? "USD";
    let cents = 0;
    // An order in the "unknown" state may have been charged: it counts against the budget too.
    for (const o of this.orders) if (o.placed || o.state === "unknown") cents += o.total?.cents ?? this.reviews.get(o.store)?.total.cents ?? 0;
    return { cents, currency };
  }

  /** Orders placed or unknown, plus the ones being placed right now. */
  private committedTotal(): Money {
    const t = this.placedTotal();
    let cents = t.cents;
    for (const m of this.placingTotals.values()) if (m.currency === t.currency) cents += m.cents;
    return { cents, currency: t.currency };
  }

  private findShop(store: StoreId, domain?: string): Shop | undefined {
    if (domain) return this.shops.get(shopKey(store, domain));
    const own = this.shops.get(store);
    if (own) return own;
    const all = [...this.shops.values()].filter((s) => s.store === store);
    return all.length === 1 ? all[0] : undefined;
  }

  // ------------------------------------------------------------------------------------------
  // end

  /** The run so far. */
  summary(): RunSummary {
    const s: RunSummary = {
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? nowIso(),
      picks: this.picks,
      carts: [...this.carts.values()],
      reviews: [...this.reviews.values()],
      orders: this.orders,
      failures: this.failures.map(({ store, stage, error }) => ({ store, stage, error })),
    };
    if (this.creditsUsed !== undefined) s.creditsUsed = this.creditsUsed;
    if (this.creditsUsed !== undefined && this.creditsEstimated) s.creditsEstimated = true;
    if (this.recorder?.screenshots.length) s.screenshots = [...this.recorder.screenshots];
    const states = this.orderStates.snapshot();
    if (Object.keys(states).length) s.orderStates = states;
    if (this.mandate) s.mandate = mandateLimits(this.mandate);
    return s;
  }

  /** Delivered total of the picks for one item, for front ends. */
  pickTotal(p: Pick): Money {
    const item = this.request.items.find((i) => i.id === p.itemId);
    return deliveredTotal(p.offer, item?.quantity ?? 1);
  }

  private async writeSummary(): Promise<void> {
    await this.recorder?.summary(this.summary());
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("this run is closed");
  }

  get isClosed(): boolean { return this.closed; }

  /**
   * Stop every browser of the run (saved profiles are kept), count credits, emit "done".
   * `settle: false` (a stop by the person) does not wait for late data charges; the count then
   * says "about" when an exit billed per GB was used.
   */
  async close(opts: { settle?: boolean } = {}): Promise<RunSummary> {
    if (this.closed) return this.summary();
    this.closed = true;
    this.runAbort.abort();
    const opened = await Promise.allSettled([...this.browsers.values()]);
    await Promise.allSettled(opened.map((r) => (r.status === "fulfilled" ? r.value.close() : Promise.resolve())));
    await this.pool?.closeAll();
    // No Browsa credits on your own Chrome or a CDP browser.
    if (!this.openFn && this.meter) {
      try {
        const settle = opts.settle !== false && this.meter.dataBilled;
        if (settle) await sleep(this.o.creditSettleMs ?? 16_000);
        const m = await this.meter.measure();
        this.creditsUsed = m.credits;
        this.creditsEstimated = !m.exact || (this.meter.dataBilled && !settle);
      } catch { /* unknown */ }
    }
    this.finishedAt = nowIso();
    const s = this.summary();
    this.emit({ type: "done", summary: s });
    await this.writeSummary();
    await this.recorder?.flush();
    return s;
  }
}

// ---------------------------------------------------------------------------------------------
// helpers

export function shopKey(store: StoreId, domain: string): string {
  return store === "shopify" ? `shopify:${domain}` : store;
}

/** Validate a ShoppingRequest given directly (API, MCP): ids, quantities, stores. */
export function normalizeRequest(r: ShoppingRequest): ShoppingRequest {
  if (!r || !Array.isArray(r.items)) throw new Error("request.items is required");
  const items = r.items
    .filter((i) => i && typeof i.query === "string" && i.query.trim())
    .map((i, n) => ({
      ...i,
      id: i.id && typeof i.id === "string" ? i.id : `item-${n + 1}`,
      query: i.query.trim(),
      description: (i.description ?? i.query).trim(),
      quantity: Number.isInteger(i.quantity) && i.quantity > 0 ? Math.min(i.quantity, 99) : 1,
      condition: i.condition === "new" || i.condition === "used" || i.condition === "any" ? i.condition : undefined,
    }))
    .map((i) => { if (!i.condition) delete i.condition; return i; });
  const ids = new Set<string>();
  for (const i of items) {
    if (ids.has(i.id)) i.id = `${i.id}-${ids.size + 1}`;
    ids.add(i.id);
  }
  const stores = (Array.isArray(r.stores) && r.stores.length ? r.stores : ALL_STORES).filter((s) => ALL_STORES.includes(s));
  return { ...r, prompt: r.prompt ?? items.map((i) => i.description).join(", "), items, stores: [...new Set(stores)], goal: r.goal ?? "best_value" };
}

function isOffer(o: unknown): o is Offer {
  const x = o as Offer;
  return !!x && typeof x.title === "string" && typeof x.url === "string" && !!x.price && Number.isFinite(x.price.cents) && typeof x.inStock === "boolean";
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/agt_[A-Za-z0-9_]+/g, "agt_***").slice(0, 500);
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

function pickKeys<T extends object, K extends keyof T>(o: T, keys: K[]): { [P in K]?: T[P] } {
  const out = {} as { [P in K]?: T[P] };
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

async function mapLimit<T>(xs: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (i < xs.length) {
      const x = xs[i++];
      try { await fn(x); } catch { /* each task reports its own failures */ }
    }
  });
  await Promise.all(workers);
}
