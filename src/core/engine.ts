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
  Approval, Cart, CheckoutReview, ItemRequest, Limits, Money, NeedsUser, Offer, OrderResult, Pick, RunEvent, RunSummary,
  ShoppingRequest, Stage, StoreId,
} from "./types.js";
import type { StoreAdapter, StoreContext } from "../stores/adapter.js";
import { loadAdapter, STORE_NAMES } from "../stores/index.js";
import { currencyNote, formatMoney, isDeadPageError, isExitError, nowIso } from "../stores/util.js";
import { parseRequest, ALL_STORES } from "./parse.js";
import { llmFromEnv, type LLMConfig } from "./llm.js";
import { BrowserPool, defaultDomain, proxyFromText, type BrowserMode, type BrowsaClient, type StoreBrowser } from "./browsers.js";
import { deliveredTotal, markCurrency, pickAll, pickEveryStore, scoreOffers } from "./rank.js";
import type { SpendEvent } from "./credits.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
import {
  allowedStores, approvalProblem, CreditMeter, effectiveBudget, forbiddenLines, LimitError, resolveLimits,
} from "./limits.js";
import { newRunId, RunRecorder } from "./history.js";
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
   * After the browsers stop, wait this long before counting credits when a browser used an exit
   * billed per GB (its last data charge reaches the ledger a few seconds late). Default 16000.
   */
  creditSettleMs?: number;
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
  private readonly recorder?: RunRecorder;
  private meter!: CreditMeter;
  private pool?: BrowserPool;
  /** The browser provider of this run (unset with a custom openBrowser hook). */
  provider?: BrowserProvider;
  /** Opens a store's browser through a provider other than the engine's Browsa pool. */
  private openFn?: (store: StoreId, domain: string) => Promise<StoreBrowser>;
  private closed = false;
  private readonly runAbort = new AbortController();

  constructor(private readonly agent: ShoppingAgent, private readonly opts: RunOptions) {
    this.o = agent.options;
    this.runId = opts.runId ?? newRunId();
    if (this.o.history !== false) this.recorder = new RunRecorder(this.o.dataDir ?? ".osa", this.runId);
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
    this.request = typeof input === "string" ? await this.agent.parse(input, (m) => this.log(m), this.opts.defaultStores, !!this.opts.shopifyDomains?.length) : normalizeRequest(input);
    if (this.opts.zip && !this.request.zip) this.request.zip = this.opts.zip;
    if (this.opts.shopifyDomains?.length && this.request.stores.includes("shopify")) {
      this.request.shopifyDomains = [...new Set([...(this.request.shopifyDomains ?? []), ...this.opts.shopifyDomains])];
    }
    this.budget = effectiveBudget(this.limits, this.request);
    this.emit({ type: "parsed", request: this.request });
    void this.recorder?.request(this.request);

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

    const { stores, refused } = allowedStores(this.request, this.limits);
    for (const s of refused) this.fail(s, "search", new LimitError("store_not_allowed", `${STORE_NAMES[s]} is not in the allowed stores`));
    if (!this.request.items.length) this.log("No items found in the request");

    try {
      if (this.request.items.length && stores.length) await this.searchAll(stores);
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

  private shopsToOpen(stores: StoreId[]): { store: StoreId; domain: string }[] {
    const out: { store: StoreId; domain: string }[] = [];
    for (const s of stores) {
      if (s === "shopify") {
        const domains = this.request.shopifyDomains ?? [];
        if (!domains.length) this.fail("shopify", "search", new Error("no Shopify shop domain given (add one like allbirds.com to the request)"));
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
        offers = this.checkCurrency(store, domain, await this.addDetails(shop, item, offers, deadline));
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
    this.picks = r.picks;
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
    if (review.needsUser) {
      this.emit({ type: "needs_user", store, needs: review.needsUser, ...dom });
    } else {
      this.emit({ type: "checkout_review", review });
      const bad = forbiddenLines(review.lines);
      if (bad.length) this.log(`The checkout has a ${bad[0].why} line (${bad[0].line.title}); it cannot be approved`, store);
      if (this.budget && this.placedTotal().cents + review.total.cents > this.budget.cents) {
        this.log(`The checkout total ${formatMoney(review.total)} would go over the ${formatMoney(this.budget)} budget; it cannot be approved`, store);
      }
      this.emit({ type: "awaiting_approval", store, review, ...dom });
    }
    await this.writeSummary();
    return review;
  }

  /**
   * Place the order, only when the approval matches this run's review of the store exactly and the
   * limits hold. Throws LimitError("approval") otherwise, without touching the store.
   */
  async approve(store: StoreId, approval: Approval, domain?: string): Promise<OrderResult> {
    this.assertOpen();
    const shop = this.findShop(store, domain ?? approval?.storeDomain);
    const review = shop ? this.reviews.get(shop.key) : undefined;
    const problem = approvalProblem({
      store, storeDomain: shop?.domain && store === "shopify" ? shop.domain : undefined, review, approval, limits: this.limits,
      budget: this.budget, placed: this.placedTotal(), ordered: this.ordered,
    });
    if (problem || !shop || !review) {
      const msg = `Order not placed: ${problem ?? "no store"}`;
      this.log(msg, store);
      throw new LimitError("approval", msg);
    }
    // Mark first so a second approve() for the same store cannot race this one.
    this.ordered.add(store === "shopify" ? `${store}:${shop.domain}` : store);
    let result: OrderResult;
    try {
      result = await withTimeout(shop.adapter.placeOrder(shop.ctx, approval), this.o.stepTimeoutMs ?? 180_000, "placing the order");
    } catch (e) {
      // Adapters return { placed: false, error } on a changed total; a throw is handled the same way.
      this.fail(store, "place_order", e, shop.domain);
      result = { store, placed: false, error: errText(e) };
    }
    result = { ...result, store };
    if (!result.placed && result.error) this.log(`Order not placed: ${result.error}`, store);
    if (result.placed && result.total && result.total.cents > approval.approvedTotal.cents) {
      this.log(`The store charged ${formatMoney(result.total)}, more than the approved ${formatMoney(approval.approvedTotal)}`, store);
    }
    if (result.needsUser) this.emit({ type: "needs_user", store, needs: result.needsUser, ...(store === "shopify" ? { domain: shop.domain } : {}) });
    if (!result.placed && !result.needsUser) this.ordered.delete(store === "shopify" ? `${store}:${shop.domain}` : store);
    this.orders.push(result);
    this.emit({ type: "order", result });
    if (this.o.screenshots !== false) {
      const path = await this.recorder?.screenshot(store, "order", shop.ctx.page);
      if (path) this.log(`Screenshot: ${path}`, store);
    }
    await this.writeSummary();
    return result;
  }

  private placedTotal(): Money {
    const currency = this.budget?.currency ?? "USD";
    let cents = 0;
    for (const o of this.orders) if (o.placed) cents += o.total?.cents ?? this.reviews.get(o.store)?.total.cents ?? 0;
    return { cents, currency };
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
