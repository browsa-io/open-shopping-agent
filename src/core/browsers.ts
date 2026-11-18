// One Phantom browser per store, on Browsa. Opens the store's browser, attaches Playwright over CDP
// and builds the StoreContext adapters work with. Three kinds of browser:
//
//   persistent  a saved Browsa identity per store (persona "osa-<store>", id kept in
//               .osa/agents.json): cookies, carts and sign-ins survive between runs. Creating one
//               costs 50 credits a month; each run opens a session on it (1 credit).
//   burner      a fresh browser for this run (1 credit per started 12 minutes, 5 reserved up
//               front and the unused part refunded). Nothing is kept. AI fallback tasks run in a
//               separate fresh browser that does not have this store's cookies.
//   session     a fresh browser opened by a Browsa task session (about 12 credits to open), so
//               AI fallback tasks run on the very same browser, same cart, no restart.
//
// "auto" (the default) uses the saved identity when .osa/agents.json has one for the store, and a
// burner otherwise. Browsers are always stopped at the end; saved identities are kept.
//
// Exit per store (the IP address stores see): the user's own proxy when one is set (OSA_PROXY or
// settings; own proxies are free on Browsa) for every store. Else Amazon, Target and Best Buy,
// which block Browsa's default exit (measured 2026-11-18: Amazon "I am human" page, Target 429,
// Best Buy resets), get Browsa's built-in residential US exit when the account's proxy network
// lists it (billed per GB from credits), and the default exit with a warning otherwise. Walmart,
// eBay and Shopify work on the default exit and stay there.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { Client } from "browsa";
import type { StoreId } from "./types.js";
import type { StoreContext } from "../stores/adapter.js";
import { STORE_NAMES } from "../stores/index.js";
import { extractJSON } from "./llm.js";

export type BrowserMode = "auto" | "persistent" | "burner" | "session";

/** The part of the Browsa client this module uses (the real `Client` of npm `browsa` 0.3.1). */
export type BrowsaClient = Pick<Client,
  "createAgent" | "getAgent" | "destroyAgent" | "openSession" | "createLiveLink" | "runTask" | "createTask" |
  "waitForJob" | "createSession" | "runMessage" | "stopSession" | "credits" | "listIdentities">
  & Partial<Pick<Client, "proxyNetwork">>;

/** Stores that block Browsa's default exit (measured 2026-11-18) and get a US exit when one is available. */
export const US_EXIT_STORES: readonly StoreId[] = ["amazon", "target", "bestbuy"];
/** Browsa's built-in residential network, US exit. */
export const US_RESIDENTIAL = { network: "residential", country: "us" } as const;

export type ExitKind = "own" | "residential_us" | "default";
/** The exit a store's browser uses, for run events and the UI. */
export interface ExitInfo {
  kind: ExitKind;
  label: string;                    // "your proxy", "Browsa residential (US)", "Browsa default"
}
export const EXIT_LABELS: Record<ExitKind, string> = {
  own: "your proxy", residential_us: "Browsa residential (US)", default: "Browsa default",
};
const exitInfo = (kind: ExitKind): ExitInfo => ({ kind, label: EXIT_LABELS[kind] });

/**
 * The user's own proxy from text (OSA_PROXY, settings): "http://user:pass@host:port",
 * "socks5://host:port", "host:port", or a JSON object in Browsa's proxy form. Empty -> undefined.
 */
export function proxyFromText(text: string | undefined | null): Record<string, unknown> | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  if (t.startsWith("{")) {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("OSA_PROXY JSON must be an object");
    return o;
  }
  if (!/^((https?|socks5):\/\/)?([^\s/@]+@)?[^\s/:@]+:\d{2,5}\/?$/.test(t)) {
    throw new Error("OSA_PROXY must look like http://user:pass@host:port, socks5://host:port or host:port");
  }
  return { server: t.replace(/\/$/, "") };
}

/** URL patterns the data saver blocks: images, video, fonts, ad and analytics hosts. */
export const DATA_SAVER_BLOCKED = [
  "*.jpg*", "*.jpeg*", "*.png*", "*.gif*", "*.webp*", "*.avif*", "*.svg*", "*.ico*", "*.mp4*", "*.webm*", "*.m3u8*",
  "*.woff*", "*.woff2*", "*.ttf*", "*.otf*",
  "*m.media-amazon.com/images*", "*i5.walmartimages.com*", "*i.ebayimg.com*", "*pisces.bbystatic.com/image2*", "*target.scene7.com*",
  "*doubleclick.net*", "*googlesyndication.com*", "*googleadservices.com*", "*google-analytics.com*", "*googletagmanager.com*",
  "*facebook.net*", "*facebook.com/tr*", "*bat.bing.com*", "*criteo*", "*adsafeprotected.com*", "*contentsquare.net*",
  "*tiktok*", "*pinterest*", "*snapchat*", "*quantummetric*", "*clarity.ms*", "*adtrafficquality*", "*amazon-adsystem.com*",
];

/** "host:port" of a proxy for display, never the user name or password. */
export function proxyDisplay(p: Record<string, unknown> | undefined): string | undefined {
  if (!p) return undefined;
  if (typeof p.server === "string") return p.server.replace(/^[a-z0-9]+:\/\//i, "").replace(/^[^@]*@/, "");
  if (typeof p.host === "string") return `${p.host}${p.port ? `:${p.port}` : ""}`;
  return undefined;
}

export interface BrowserPoolOptions {
  apiKey: string;
  baseUrl?: string;                 // default https://browsa.io
  client?: BrowsaClient;            // default: new Client({ apiKey, baseUrl })
  dataDir?: string;                 // default ".osa"
  mode?: BrowserMode;               // default "auto"
  /** Model of AI fallback tasks: a hosted tier ("browsa", "browsa-fast", "browsa-smart") or "provider:model". */
  aiLlm?: string;                   // default "browsa"
  aiLlmApiKey?: string;             // the user's own key for aiLlm, when it is not a hosted tier
  aiMaxCredits?: number;            // cap per AI fallback task, default 15
  aiMaxSteps?: number;              // default 25
  country?: string;                 // fingerprint locale, default "us"
  /** The user's own proxy for every store (Browsa's proxy form, see proxyFromText). Free on Browsa. */
  proxy?: Record<string, unknown>;
  /** Give US_EXIT_STORES Browsa's residential US exit when the account has it. Default true. */
  usExit?: boolean;
  /** How long opening a browser waits for a free browser slot (HTTP 429). Default 240000 (4 min). */
  slotWaitMs?: number;
  /** Data saver (see BrowserPool.saveData): "residential" (default), "always" or "never". */
  saveData?: "residential" | "always" | "never";
  ttlSeconds?: number;              // burner and session browser lifetime, default 1800 (max 3600)
  /**
   * Called before anything that costs credits, with the most it can cost. Throw to refuse (the
   * engine uses it for Limits.maxCreditsPerRun). May return a lower cap for AI tasks.
   */
  spend?: (maxCredits: number, what: string) => Promise<number | void> | number | void;
  /** Attach Playwright. Default: chromium.connectOverCDP with the X-API-Key header. */
  connect?: (cdpHttp: string, apiKey: string) => Promise<Browser>;
  log?: (store: StoreId, message: string) => void;
  fetch?: typeof globalThis.fetch;
}

/** What the engine gets back per store. */
export interface StoreBrowser {
  store: StoreId;
  agentId: string;
  mode: Exclude<BrowserMode, "auto">;
  page: Page;
  /** The exit this browser uses (optional for custom openBrowser hooks). */
  exit?: ExitInfo;
  /** Build a StoreContext for one domain on this browser (Shopify domains share one browser). */
  context(domain: string, extra: { zip?: string; signal: AbortSignal; log?: (m: string) => void }): StoreContext;
  /** Stop the browser (a saved identity is kept). Safe to call twice. */
  close(): Promise<void>;
}

interface SavedAgent { agentId: string; persona: string; createdAt: string; exit?: ExitKind }
type AgentsFile = Partial<Record<StoreId, SavedAgent>>;

export const PERSISTENT_CREATE_CREDITS = 50;
export const PERSISTENT_SESSION_CREDITS = 1;
export const BURNER_CREDITS = 5;
export const SESSION_OPEN_CREDITS = 15;

export const STORE_HOME: Record<StoreId, (domain: string) => string> = {
  amazon: () => "https://www.amazon.com/",
  walmart: () => "https://www.walmart.com/",
  ebay: () => "https://www.ebay.com/",
  bestbuy: () => "https://www.bestbuy.com/",
  target: () => "https://www.target.com/",
  shopify: (d) => `https://${d}/`,
};

const HOSTED = new Set(["browsa", "browsa-fast", "browsa-smart"]);

export class BrowserPool {
  readonly client: BrowsaClient;
  private readonly o: Required<Pick<BrowserPoolOptions, "dataDir" | "mode" | "aiLlm" | "aiMaxCredits" | "aiMaxSteps" | "country" | "ttlSeconds">> & BrowserPoolOptions;
  private open = new Set<StoreBrowser>();
  private usNetwork?: Promise<boolean>;
  /** True once opening a browser had to wait for a slot (the engine then frees slots early). */
  slotsShort = false;
  /** Stores whose residential exit failed to connect in this pool: they use the default exit. */
  private forcedDefault = new Set<StoreId>();

  constructor(opts: BrowserPoolOptions) {
    if (!opts.apiKey && !opts.client) throw new Error("BROWSA_API_KEY is missing: get a key at https://app.browsa.io/dashboard/keys");
    // Options passed as undefined (engine pass-through) must not override the defaults: an undefined
    // aiMaxCredits gave AI tasks a NaN cap, which reached Browsa as no cap.
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as BrowserPoolOptions;
    this.o = { dataDir: ".osa", mode: "auto", aiLlm: "browsa", aiMaxCredits: 15, aiMaxSteps: 25, country: "us", ttlSeconds: 1800, ...given };
    this.client = opts.client ?? new Client({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, timeoutMs: 90_000 });
  }

  private log(store: StoreId, m: string) { this.o.log?.(store, m); }
  private async spend(n: number, what: string): Promise<number> {
    const r = await this.o.spend?.(n, what);
    return typeof r === "number" ? Math.min(r, n) : n;
  }

  /** True when the account's Browsa proxy network lists a residential US exit (asked once). */
  hasUsResidential(): Promise<boolean> {
    this.usNetwork ??= (async () => {
      if (typeof this.client.proxyNetwork !== "function") return false;
      try {
        const n = await this.client.proxyNetwork();
        return !!n?.enabled && (n.tiers ?? []).some((t) => t.network === "residential" && (t.countries ?? []).map((c) => String(c).toLowerCase()).includes("us"));
      } catch {
        return false;
      }
    })();
    return this.usNetwork;
  }

  /** The exit a new browser for this store gets, and the proxy to ask Browsa for. */
  async exitFor(store: StoreId): Promise<{ exit: ExitInfo; proxy?: Record<string, unknown> }> {
    if (this.o.proxy) return { exit: exitInfo("own"), proxy: this.o.proxy };
    if (US_EXIT_STORES.includes(store) && this.o.usExit !== false && !this.forcedDefault.has(store) && await this.hasUsResidential()) {
      return { exit: exitInfo("residential_us"), proxy: { ...US_RESIDENTIAL } };
    }
    return { exit: exitInfo("default") };
  }

  /**
   * A warning naming the stores of this run that will use the default exit although they block
   * it; undefined when each of them has a US exit (or none is in the run).
   */
  async exitWarning(stores: StoreId[]): Promise<string | undefined> {
    const risky: StoreId[] = [];
    for (const s of new Set(stores)) {
      if (!US_EXIT_STORES.includes(s)) continue;
      if ((await this.modeFor(s)) === "persistent") {
        const saved = (await this.readAgents())[s];
        if (saved) { if ((saved.exit ?? "default") === "default") risky.push(s); continue; }
      }
      if ((await this.exitFor(s)).exit.kind === "default") risky.push(s);
    }
    return risky.length ? exitWarningText(risky) : undefined;
  }

  /** Which kind of browser a store will get, without opening it. */
  async modeFor(store: StoreId): Promise<Exclude<BrowserMode, "auto">> {
    if (this.o.mode !== "auto") return this.o.mode;
    const saved = (await this.readAgents())[store];
    return saved ? "persistent" : "burner";
  }

  /** Open the store's browser and attach Playwright. */
  async openStore(store: StoreId, domain = defaultDomain(store)): Promise<StoreBrowser> {
    const mode = await this.modeFor(store);
    const home = STORE_HOME[store](domain);
    let agentId = "";
    let cdpHttp = "";
    let sessionId: string | undefined;
    let exit: ExitInfo;
    let exitProxy: Record<string, unknown> | undefined;

    if (mode === "persistent") {
      ({ agentId, cdpHttp, exit } = await this.openIdentity(store, home));
    } else if (mode === "burner") {
      await this.spend(BURNER_CREDITS, `${store} browser`);
      const made = await this.withExit(store, (proxy, tag) => this.client.createAgent({
        ttl: `${Math.min(3600, this.o.ttlSeconds)}s`, country: this.o.country, initial_url: tagUrl(home, tag),
        ...(proxy ? { proxy: proxy as never } : {}),
      }));
      ({ exit, proxy: exitProxy } = made);
      agentId = String(made.value.id ?? "");
      cdpHttp = String(made.value.cdp_http ?? "");
      this.log(store, `opened a Phantom browser (${agentId}), exit: ${exit.label}`);
    } else {
      const cap = await this.spend(SESSION_OPEN_CREDITS, `${store} browser session`);
      const made = await this.withExit(store, (proxy) => this.client.createSession({
        task: `Open ${home} and wait until the page has loaded. Do nothing else. Reply with the page title only.`,
        initialUrl: home, llm: this.o.aiLlm, maxSteps: 3, maxCredits: cap,
        browserTtlSeconds: Math.min(3600, Math.max(300, this.o.ttlSeconds)),
        ...(this.o.aiLlmApiKey && !HOSTED.has(this.o.aiLlm) ? { llmApiKey: this.o.aiLlmApiKey } : {}),
        ...(proxy ? { proxy: proxy as never } : {}),
      }));
      ({ exit, proxy: exitProxy } = made);
      const job = made.value;
      sessionId = job.sessionId ?? job.id;
      const done = await this.client.waitForJob(job.id, { timeoutMs: 240_000 });
      if (done.status !== "completed") throw new Error(`browser session did not open: ${done.errorCode ?? done.status} ${done.errorMessage ?? ""}`.trim());
      agentId = done.agentId ?? job.agentId ?? "";
      if (!agentId) throw new Error("browser session opened without an agent id");
      const a = await this.client.getAgent(agentId);
      cdpHttp = String(a.cdp_http ?? "");
      this.log(store, `opened a Phantom browser session (${agentId}), exit: ${exit.label}`);
    }
    if (!cdpHttp) throw new Error(`Browsa returned no cdp_http for ${agentId}`);

    let browser: Browser;
    try {
      browser = await this.attach(cdpHttp);
    } catch (e) {
      await this.release(mode, agentId, sessionId, store).catch(() => {});
      throw e;
    }
    await this.saveData(browser, exit, store);
    let page = await firstPage(browser);
    // Browsa's residential exit cannot reach some stores at all (seen live: every amazon.com load
    // answered net::ERR_TUNNEL_CONNECTION_FAILED). Check once; on a fresh browser, start again on
    // the default exit with a warning instead of failing the store.
    if (exit.kind === "residential_us") {
      const broken = await tunnelFails(page, home);
      if (broken) {
        this.log(store, `the residential US exit cannot reach ${new URL(home).hostname} (${broken})`);
        if (mode !== "persistent") {
          await browser.close().catch(() => {});
          await this.release(mode, agentId, sessionId, store).catch(() => {});
          this.forcedDefault.add(store);
          this.log(store, exitWarningText([store]));
          return this.openStore(store, domain);
        }
      }
    }
    const pool = this;
    let closed = false;
    let running = false; // an AI task owns the browser

    const sb: StoreBrowser = {
      store, agentId, mode, exit,
      get page() { return page; },
      context(dom, extra): StoreContext {
        const log = extra.log ?? ((m: string) => pool.log(store, m));
        return {
          store, domain: dom, zip: extra.zip, agentId, signal: extra.signal, log,
          get page() { return page; },
          aiTask: async <T = unknown>(task: string, opts: { schema?: object; maxSteps?: number; startUrl?: string; sameBrowser?: boolean } = {}): Promise<T> => {
            if (running) throw new Error("an AI task is already running on this browser");
            if (extra.signal.aborted) throw new Error("run stopped");
            if (opts.sameBrowser && mode === "burner") {
              // A standalone task has its own browser and cart: it cannot act on ours. Do not pay for it.
              throw new Error("the AI fallback cannot act on this fresh browser's page or cart (it would run in a separate browser); use saved store profiles (persistent) or session browsers for that");
            }
            running = true;
            try {
              const r = await pool.runAiTask(store, mode, { agentId, sessionId, page, browser, proxy: exitProxy, exit }, task, opts, log,
                (b, p) => { browser = b; page = p; });
              return r.result as T;
            } finally {
              running = false;
            }
          },
          liveLink: async () => {
            const l = await pool.client.createLiveLink(agentId, { scope: "control", ttlSeconds: 3600 });
            if (!l?.live_url) throw new Error("Browsa returned no live link");
            return l.live_url;
          },
          newPage: async () => {
            if (closed) throw new Error("the store's browser is closed");
            if (running) throw new Error("an AI task owns the browser");
            // A dropped CDP connection: attach again (a saved profile opens a new session).
            if (typeof browser.isConnected === "function" && !browser.isConnected()) {
              if (mode === "persistent") ({ browser, page } = await pool.reattachIdentity(store, agentId));
              else { browser = await pool.attach(cdpHttp); page = await firstPage(browser); }
              await pool.saveData(browser, exit, store, true);
              log("attached to the browser again");
              if (!page.isClosed()) return page;
            }
            const old = page;
            const bctx = browser.contexts()[0] ?? (await browser.newContext());
            page = await bctx.newPage();
            await old.close().catch(() => {});
            log("opened a fresh tab in the same browser");
            return page;
          },
        } as StoreContext;
      },
      async close() {
        if (closed) return;
        closed = true;
        pool.open.delete(sb);
        await browser.close().catch(() => {});
        await pool.release(mode, agentId, sessionId, store);
      },
    };
    this.open.add(sb);
    return sb;
  }

  /** Stop every browser this pool opened. */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.open].map((b) => b.close()));
  }

  // -------------------------------------------------------------------------------------------

  /**
   * Data saver: on a browser whose exit is billed per GB (Browsa's residential network), do not
   * load images, video, fonts and ad or analytics scripts (DATA_SAVER_BLOCKED), on every tab.
   * Off with saveData: "never" (OSA_SAVE_DATA=0); "always" applies it to every exit.
   */
  async saveData(browser: Browser, exit: ExitInfo, store: StoreId, quiet = false): Promise<void> {
    const on = this.o.saveData ?? "residential";
    if (on === "never" || (on === "residential" && exit.kind !== "residential_us")) return;
    const bctx = browser.contexts()[0];
    if (!bctx || typeof bctx.newCDPSession !== "function") return;
    const apply = async (p: Page) => {
      try {
        const s = await bctx.newCDPSession(p);
        await s.send("Network.enable");
        await s.send("Network.setBlockedURLs", { urls: DATA_SAVER_BLOCKED });
      } catch { /* a closed tab: nothing to save */ }
    };
    for (const p of bctx.pages()) await apply(p);
    bctx.on("page", (p) => { void apply(p); });
    if (!quiet) this.log(store, "data saver on: images, video, fonts and ad scripts are not loaded (this exit is billed per GB)");
  }

  /** Attach Playwright to a browser's CDP endpoint (three tries). */
  async attach(cdpHttp: string): Promise<Browser> {
    if (this.o.connect) return this.o.connect(cdpHttp, this.o.apiKey);
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await chromium.connectOverCDP(cdpHttp, { headers: { "X-API-Key": this.o.apiKey }, timeout: 60_000 });
      } catch (e) {
        last = e;
        await sleep(2000 * (i + 1));
      }
    }
    throw new Error(`could not attach to the browser: ${(last as Error)?.message ?? last}`);
  }

  /**
   * Create a browser on the store's exit. When Browsa refuses the residential US exit, fall back to
   * the default exit with a warning instead of failing the store. An own proxy is never dropped.
   */
  private async withExit<T>(store: StoreId, create: (proxy?: Record<string, unknown>, tag?: string) => Promise<T>): Promise<{ value: T; exit: ExitInfo; proxy?: Record<string, unknown> }> {
    const { exit, proxy } = await this.exitFor(store);
    const make = (p?: Record<string, unknown>) => this.waitForSlot(store, async () => {
      const tag = `osa-${Math.random().toString(36).slice(2, 12)}`;
      try {
        return await create(p, tag);
      } catch (e) {
        // A gateway timeout can leave the browser queued on Browsa, billed, with no id for us
        // (seen live: HTTP 504 and a residential browser stuck "queued"). Find it by its tag.
        if (!isSlotsBusy(e)) await this.reapOrphans(store, tag);
        throw e;
      }
    });
    try {
      return { value: await make(proxy), exit, proxy };
    } catch (e) {
      if (exit.kind !== "residential_us" || isSlotsBusy(e)) throw e;
      this.log(store, `Browsa refused the residential US exit (${String((e as Error)?.message ?? e).slice(0, 160)}); using the default exit`);
      this.log(store, exitWarningText([store]));
      return { value: await make(undefined), exit: exitInfo("default") };
    }
  }

  /** Destroy browsers this pool asked for but never got back (their initial_url carries `tag`). */
  private async reapOrphans(store: StoreId, tag: string): Promise<void> {
    try {
      const base = (this.o.baseUrl || "https://browsa.io").replace(/\/+$/, "");
      const f = this.o.fetch ?? globalThis.fetch;
      const r = await f(`${base}/v1/agents?limit=50`, { headers: { "X-API-Key": this.o.apiKey, Accept: "application/json", "User-Agent": "open-shopping-agent" } });
      if (!r.ok) return;
      const b = await r.json() as { agents?: Record<string, any>[]; data?: Record<string, any>[] } | Record<string, any>[];
      const list = Array.isArray(b) ? b : b.agents ?? b.data ?? [];
      for (const a of list) {
        if (String(a?.options?.initial_url ?? "").includes(tag) && !/destroyed|stopped|expired/.test(String(a.status))) {
          await this.client.destroyAgent(String(a.id)).catch(() => {});
          this.log(store, `stopped browser ${a.id} that Browsa created although the request failed`);
        }
      }
    } catch { /* best effort */ }
  }

  /**
   * Browsa answers 429 when the account's browser slots are all in use (other runs share them):
   * wait for one to free up (Retry-After, else 20 s) for at most slotWaitMs, then give up.
   */
  private async waitForSlot<T>(store: StoreId, create: () => Promise<T>): Promise<T> {
    const until = Date.now() + (this.o.slotWaitMs ?? 240_000);
    for (let i = 0; ; i++) {
      try {
        return await create();
      } catch (e) {
        if (!isSlotsBusy(e) || Date.now() >= until) throw e;
        this.slotsShort = true;
        const waitS = Math.min(60, Math.max(1, Number((e as { retryAfter?: number }).retryAfter) || 20));
        if (i === 0) this.log(store, `all browser slots are in use; waiting for one (up to ${Math.round((until - Date.now()) / 1000)} s)`);
        await sleep(Math.min(waitS * 1000, Math.max(0, until - Date.now())));
      }
    }
  }

  private async openIdentity(store: StoreId, home: string): Promise<{ agentId: string; cdpHttp: string; exit: ExitInfo }> {
    const agents = await this.readAgents();
    let saved = agents[store];
    if (saved) {
      const a = await this.client.getAgent(saved.agentId).catch(() => undefined);
      if (!a || a.status !== "running" || a.mode !== "persistent") {
        this.log(store, `saved browser profile ${saved.agentId} is gone (${a?.status ?? "not found"}); making a new one`);
        delete agents[store];
        await this.writeAgents(agents);
        saved = undefined;
      }
    }
    if (!saved) {
      // Lost .osa folder: look for an identity made by an earlier run.
      const persona = `osa-${store}`;
      const list = await this.client.listIdentities().catch(() => [] as Record<string, any>[]);
      const found = list.find((a) => a.mode === "persistent" && a.status === "running" && (a.persona === persona || a.options?.persona === persona));
      if (found?.id) {
        saved = { agentId: String(found.id), persona, createdAt: String(found.created_at ?? new Date().toISOString()) };
        agents[store] = saved;
        await this.writeAgents(agents);
      }
    }
    if (saved) {
      await this.spend(PERSISTENT_SESSION_CREDITS, `${store} browser session`);
      const s = await this.client.openSession(saved.agentId);
      // A saved profile keeps the exit it was made with.
      const exit = exitInfo(saved.exit ?? "default");
      this.log(store, `opened saved browser profile ${saved.agentId}, exit: ${exit.label}`);
      return { agentId: saved.agentId, cdpHttp: String(s.cdp_http ?? ""), exit };
    }
    await this.spend(PERSISTENT_CREATE_CREDITS, `new saved browser profile for ${store} (50 credits a month)`);
    const made = await this.withExit(store, (proxy, tag) => this.client.createAgent({
      mode: "persistent", persona: `osa-${store}`, country: this.o.country, initial_url: tagUrl(home, tag),
      ...(proxy ? { proxy: proxy as never } : {}),
    }));
    const a = made.value;
    const agentId = String(a.id ?? "");
    agents[store] = { agentId, persona: `osa-${store}`, createdAt: new Date().toISOString(), exit: made.exit.kind };
    await this.writeAgents(agents);
    this.log(store, `created saved browser profile ${agentId}, exit: ${made.exit.label}`);
    return { agentId, cdpHttp: String(a.cdp_http ?? ""), exit: made.exit };
  }

  private async runAiTask(
    store: StoreId, mode: Exclude<BrowserMode, "auto">,
    cur: { agentId: string; sessionId?: string; page: Page; browser: Browser; proxy?: Record<string, unknown>; exit?: ExitInfo },
    task: string, opts: { schema?: object; maxSteps?: number; startUrl?: string }, log: (m: string) => void,
    swap: (browser: Browser, page: Page) => void,
  ): Promise<{ result: unknown }> {
    const cap = await this.spend(this.o.aiMaxCredits, `${store} AI task`);
    const startUrl = opts.startUrl ?? safeUrl(cur.page);
    const text = aiTaskText(task, opts.schema);
    const llm: Record<string, unknown> = { llm: this.o.aiLlm };
    if (this.o.aiLlmApiKey && !HOSTED.has(this.o.aiLlm)) llm.llmApiKey = this.o.aiLlmApiKey;
    const maxSteps = opts.maxSteps ?? this.o.aiMaxSteps;
    log(`AI task (${this.o.aiLlm}, at most ${cap} credits): ${task.slice(0, 120)}`);

    if (mode === "session" && cur.sessionId) {
      const job = await this.client.runMessage(cur.sessionId, text, { ...llm, maxCredits: cap, maxSteps, timeoutMs: 600_000 } as never);
      swap(cur.browser, await firstPage(cur.browser, true));
      logJob(log, job);
      return { result: jobResult(job) };
    }
    if (mode === "burner") {
      // A task with agent_id needs a persistent agent ("sessions can only be opened on persistent
      // agents"), so on a fresh browser the AI task is a standalone Browsa task: its own browser on
      // the same exit, starting at the current page. Its cookies and cart are separate from ours.
      log("this browser keeps no profile, so the AI task runs in its own browser (separate cookies and cart)");
      const job = await this.client.runTask({
        task: text, ...llm, maxCredits: cap, maxSteps, initialUrl: startUrl, country: this.o.country, timeoutMs: 600_000,
        ...(cur.proxy ? { proxy: cur.proxy } : {}),
      } as never);
      logJob(log, job);
      return { result: jobResult(job) };
    }
    // persistent: the task opens its own session on the identity, which stops ours. Disconnect,
    // save the cookies, run the task, then attach to the browser again.
    await cur.browser.close().catch(() => {});
    await this.closeIdentitySession(cur.agentId).catch((e) => log(`saving the session first failed: ${(e as Error).message}`));
    let job: Awaited<ReturnType<BrowsaClient["runTask"]>> | undefined;
    let err: unknown;
    try {
      job = await this.client.runTask({ task: text, ...llm, maxCredits: cap, maxSteps, initialUrl: startUrl, agentId: cur.agentId, timeoutMs: 600_000 } as never);
    } catch (e) {
      err = e;
    }
    // Attach again whatever happened, so the adapter keeps a working page.
    const re = await this.reattachIdentity(store, cur.agentId);
    if (cur.exit) await this.saveData(re.browser, cur.exit, store, true);
    swap(re.browser, re.page);
    if (err) throw err;
    logJob(log, job!);
    return { result: jobResult(job!) };
  }

  /** Open a new session on a saved profile and attach to it. */
  async reattachIdentity(store: StoreId, agentId: string): Promise<{ browser: Browser; page: Page }> {
    await this.spend(PERSISTENT_SESSION_CREDITS, `${store} browser session`);
    const s = await this.client.openSession(agentId);
    const browser = await this.attach(String(s.cdp_http ?? ""));
    return { browser, page: await firstPage(browser) };
  }

  private async release(mode: Exclude<BrowserMode, "auto">, agentId: string, sessionId: string | undefined, store: StoreId): Promise<void> {
    try {
      if (mode === "persistent") await this.closeIdentitySession(agentId);
      else if (mode === "session" && sessionId) await this.client.stopSession(sessionId);
      else await this.client.destroyAgent(agentId);
      this.log(store, mode === "persistent" ? `stopped the browser, profile ${agentId} kept` : `stopped browser ${agentId}`);
    } catch (e) {
      this.log(store, `stopping browser ${agentId} failed: ${(e as Error).message}`);
      if (mode === "session") await this.client.destroyAgent(agentId).catch(() => {});
    }
  }

  /** DELETE /v1/agents/{id}/sessions: stop an identity's browser and save its cookies (not in SDK 0.3.1). */
  private async closeIdentitySession(agentId: string): Promise<void> {
    const base = (this.o.baseUrl || "https://browsa.io").replace(/\/+$/, "");
    const f = this.o.fetch ?? globalThis.fetch;
    const r = await f(`${base}/v1/agents/${encodeURIComponent(agentId)}/sessions`, {
      method: "DELETE", headers: { "X-API-Key": this.o.apiKey, Accept: "application/json", "User-Agent": "open-shopping-agent" },
    });
    if (!r.ok && r.status !== 404) throw new Error(`closing the browser session: HTTP ${r.status}`);
  }

  private get agentsPath() { return join(this.o.dataDir, "agents.json"); }

  async readAgents(): Promise<AgentsFile> {
    try { return JSON.parse(await readFile(this.agentsPath, "utf8")) as AgentsFile; } catch { return {}; }
  }

  private async writeAgents(a: AgentsFile): Promise<void> {
    await mkdir(this.o.dataDir, { recursive: true });
    const tmp = `${this.agentsPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.agentsPath);
  }
}

/** The start URL with a fragment tag that finds the browser again (fragments never reach the store). */
function tagUrl(url: string, tag?: string): string {
  return tag ? `${url.split("#")[0]}#${tag}` : url;
}

/** The proxy error when the exit cannot open `url` at all (two tries), else undefined. */
async function tunnelFails(page: Page, url: string): Promise<string | undefined> {
  let last: string | undefined;
  for (let i = 0; i < 2; i++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
      return undefined;
    } catch (e) {
      const m = String((e as Error)?.message ?? e).match(/net::ERR_(TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED)/)?.[0];
      if (!m) return undefined; // another error is the store's or the page's, not the exit's
      last = m;
      await sleep(2000);
    }
  }
  return last;
}

/** One log line per finished AI task: id, status, credits. */
function logJob(log: (m: string) => void, job: { id?: string; status?: string; creditsCharged?: number }): void {
  log(`AI task ${job.id ?? "?"}: ${job.status ?? "?"}${typeof job.creditsCharged === "number" ? `, ${job.creditsCharged} credits` : ""}`);
}

/** True for Browsa's "all browser slots in use" answer (HTTP 429 on creating a browser). */
export function isSlotsBusy(e: unknown): boolean {
  const x = e as { status?: number; message?: string; name?: string };
  return x?.status === 429 || x?.name === "RateLimitError" || /\b429\b|too many (running|concurrent)|slots? (are )?(busy|in use|full)|concurren(t|cy) limit/i.test(String(x?.message ?? ""));
}

/** The warning for stores that block the default exit and have no US exit in this run. */
export function exitWarningText(stores: StoreId[]): string {
  const names = stores.map((s) => STORE_NAMES[s]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `${list} may block Browsa's default exit (not a US address). Set OSA_PROXY to your own US proxy (free on Browsa) to give ${names.length > 1 ? "them" : "it"} a US exit.`;
}

export function defaultDomain(store: StoreId): string {
  return store === "shopify" ? "" : `${store}.com`;
}

/** The task text sent to Browsa: the adapter's task plus the output contract. */
export function aiTaskText(task: string, schema?: object): string {
  const lines = [
    task.trim(),
    "",
    "Rules: never place an order, never click a final Place order or Pay button, never sign in, never enter card details,",
    "never accept a membership, subscription or free trial. If the page needs a person (sign-in, code, captcha), stop and say so.",
  ];
  if (schema) lines.push("", `Return only a JSON value that matches this JSON schema, nothing else:\n${JSON.stringify(schema)}`);
  return lines.join("\n");
}

/** A finished job's answer: parsed JSON when it is JSON, else the text. Throws for failed jobs. */
export function jobResult(job: { status: string; finalResult?: string; errorMessage?: string; errorCode?: string; raw?: Record<string, unknown> }): unknown {
  if (job.status !== "completed") {
    throw new Error(`AI task ${job.status}${job.errorCode ? ` (${job.errorCode})` : ""}: ${job.errorMessage ?? "no answer"}`);
  }
  const text = job.finalResult ?? "";
  try { return extractJSON(text); } catch { return text; }
}

async function firstPage(browser: Browser, preferLast = false): Promise<Page> {
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const pages = ctx.pages().filter((p) => !p.isClosed());
  if (pages.length) return preferLast ? pages[pages.length - 1] : pages[0];
  return ctx.newPage();
}

function safeUrl(page: Page): string | undefined {
  try {
    const u = page.url();
    return /^https?:/.test(u) ? u : undefined;
  } catch { return undefined; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
