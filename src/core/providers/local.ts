// The local provider: the Chrome or Edge installed on this computer, through Playwright.
// No signup and no credits. Headed by default, so the person can take over in the window (sign-in,
// a code, a bot check); OSA_HEADLESS=1 runs it headless. One profile folder per store in
// .osa/browsers/<store>, so logins and carts persist between runs on this computer. Your own proxy
// (OSA_PROXY, per store, or a pool) is the launch proxy. No captcha solving and no US home-internet
// exit: that is what Browsa adds. AI fallback only with your own model key (the local loop).

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { StoreId } from "../types.js";
import type { LLMConfig, JSONRequest } from "../llm.js";
import { buildProviderBrowser } from "./context.js";
import { proxyLabel, toPlaywrightProxy, type ProxySpec } from "./proxy.js";
import { PROVIDER_LABELS, type BrowserCapabilities, type BrowserProvider, type OpenOptions, type ProviderBrowser } from "./types.js";

export interface LocalProviderOptions {
  /** Folder for the store profiles (<dataDir>/browsers/<store>). Default ".osa". */
  dataDir?: string;
  /** Default: OSA_HEADLESS=1, or true on Linux with no display. */
  headless?: boolean;
  /** A browser binary. Default: OSA_CHROME_PATH, else the first installed Chrome or Edge. */
  chromePath?: string;
  /** The user's proxy for a store (see proxy.ts). */
  proxyFor?: (store: StoreId) => Promise<ProxySpec | undefined>;
  /** The user's own model, for the AI fallback loop. */
  llm?: LLMConfig;
  aiMaxSteps?: number;
  complete?: (cfg: LLMConfig, req: JSONRequest) => Promise<unknown>;
  /** Launch a persistent context (tests). Default: chromium.launchPersistentContext. */
  launch?: (userDataDir: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => Promise<BrowserContext>;
  env?: Record<string, string | undefined>;
}

/** Where installed browsers usually live, per platform, best first. */
export function chromeCandidates(platform = process.platform, home = homedir()): string[] {
  if (platform === "darwin") {
    const apps = ["Google Chrome", "Google Chrome Beta", "Microsoft Edge", "Chromium", "Brave Browser"];
    return apps.flatMap((a) => [`/Applications/${a}.app/Contents/MacOS/${a}`, join(home, "Applications", `${a}.app/Contents/MacOS/${a}`)]);
  }
  if (platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.flatMap((r) => [join(r, "Google/Chrome/Application/chrome.exe"), join(r, "Microsoft/Edge/Application/msedge.exe"), join(r, "Chromium/Application/chrome.exe")]);
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge", "/usr/bin/brave-browser"];
}

/** The browser binary to launch, or undefined when none is installed. */
export function findChrome(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  const own = env.OSA_CHROME_PATH?.trim();
  if (own) return own;
  return chromeCandidates().find((p) => exists(p));
}

export function localChromeAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return !!findChrome(env);
}

export const NO_CHROME =
  "No Chrome or Edge found on this computer. Install Google Chrome, set OSA_CHROME_PATH to a browser binary, set OSA_CDP_URL to a remote browser, or set BROWSA_API_KEY to use Phantom on Browsa.";

export function localCapabilities(headless: boolean, llm?: LLMConfig): BrowserCapabilities {
  return { liveLink: headless ? "none" : "window", aiFallback: !!llm, captchaSolving: false, residentialExit: false, savedProfiles: false, fingerprint: "standard" };
}

interface Shared { ctx: Promise<BrowserContext>; refs: number; firstTaken: boolean }

export class LocalProvider implements BrowserProvider {
  readonly id = "local" as const;
  readonly label = PROVIDER_LABELS.local;
  readonly capabilities: BrowserCapabilities;
  readonly headless: boolean;
  private readonly o: LocalProviderOptions;
  /** One running browser per profile folder: two runs on the same store share it (new tab each). */
  private readonly shared = new Map<string, Shared>();

  constructor(o: LocalProviderOptions = {}) {
    this.o = o;
    const env = o.env ?? process.env;
    const noDisplay = process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
    this.headless = o.headless ?? (env.OSA_HEADLESS === "1" || env.OSA_HEADLESS === "true" || noDisplay);
    this.capabilities = localCapabilities(this.headless, o.llm);
  }

  async open(store: StoreId, opts: OpenOptions = {}): Promise<ProviderBrowser> {
    const dir = join(this.o.dataDir ?? ".osa", "browsers", store);
    const proxy = opts.proxy !== undefined ? opts.proxy ?? undefined : await this.o.proxyFor?.(store);
    let sh = this.shared.get(dir);
    if (!sh) {
      sh = { ctx: this.launch(dir, proxy), refs: 0, firstTaken: false };
      this.shared.set(dir, sh);
      sh.ctx.catch(() => this.shared.delete(dir));
    }
    const ctx = await sh.ctx;
    sh.refs++;
    let page: Page;
    const blank = ctx.pages().find((p) => !p.isClosed());
    if (!sh.firstTaken && blank) { page = blank; sh.firstTaken = true; } else page = await ctx.newPage();
    const s = sh;
    opts.log?.(`opened ${this.headless ? "a headless" : "a"} local browser for ${store}${proxy ? `, proxy ${proxyLabel(proxy)}` : ""}`);
    return buildProviderBrowser({
      store, provider: "local", capabilities: this.capabilities, agentId: `local-${store}`, page, context: ctx,
      exit: proxy ? { kind: "own", label: `your proxy (${proxyLabel(proxy)})` } : { kind: "default", label: "this computer's connection" },
      llm: this.o.llm, aiMaxSteps: this.o.aiMaxSteps, complete: this.o.complete, log: opts.log,
      close: async (p) => {
        s.refs--;
        if (s.refs <= 0) {
          this.shared.delete(dir);
          await ctx.close().catch(() => {});
        } else {
          await p.close().catch(() => {});
        }
      },
    });
  }

  private async launch(dir: string, proxy: ProxySpec | undefined): Promise<BrowserContext> {
    const env = this.o.env ?? process.env;
    const exe = this.o.chromePath ?? findChrome(env);
    if (!exe && !this.o.launch) throw new Error(NO_CHROME);
    await mkdir(dir, { recursive: true });
    const options: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.headless,
      ...(exe ? { executablePath: exe } : {}),
      ...(proxy ? { proxy: toPlaywrightProxy(proxy) } : {}),
      viewport: this.headless ? { width: 1366, height: 900 } : null,
      // No "controlled by automated test software" bar in the person's window.
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--no-first-run", "--no-default-browser-check"],
      timeout: 60_000,
    };
    try {
      return await (this.o.launch ?? ((d, op) => chromium.launchPersistentContext(d, op)))(dir, options);
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory is already in use/i.test(m)) {
        throw new Error(`the local profile ${dir} is in use by another browser; close it or run one store at a time`);
      }
      throw new Error(`could not start the local browser (${exe ?? "custom launch"}): ${m.split("\n")[0].slice(0, 300)}`);
    }
  }

  async closeAll(): Promise<void> {
    const all = [...this.shared.values()];
    this.shared.clear();
    await Promise.allSettled(all.map(async (s) => (await s.ctx).close()));
  }
}
