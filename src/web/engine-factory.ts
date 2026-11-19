// Picks the engine for the surfaces (web app, CLI, MCP): the real engine when it has a browser
// (Phantom on Browsa with a key, a CDP URL, or a local Chrome; see providerFor) and OSA_DEMO is not
// 1, else the demo engine (MockEngine), which shows "Demo data" and contacts no store.

import type { AlertsPort } from "./alerts-port.js";
import { WatchAlerts } from "./alerts-port.js";
import type { OsaConfig } from "./config.js";
import { ConfigStore, osaHome } from "./config.js";
import type { EnginePort } from "./engine-port.js";
import { MockEngine } from "./mock-engine.js";
import { RealEngine, type RealEngineOptions } from "./real-engine.js";
import { llmFromEnv, type LLMConfig } from "../core/llm.js";
import { createWatchCheck } from "../core/watch-check.js";
import type { CheckFn } from "../alerts/types.js";
import type { StoreId } from "../core/types.js";
import { CdpProvider, chooseProvider, LocalProvider, localChromeAvailable, ProxyPlan, type ProviderId } from "../core/providers/index.js";

export interface EngineChoice {
  demo?: boolean;            // force the demo engine (OSA_DEMO=1 or --demo)
  speed?: number;            // demo pace (1 = realistic, 0 = instant)
  /** Demo Phantom Live placeholder path; the web app serves one, the CLI and MCP have none. */
  demoLiveBase?: string | null;
  /** Folder for run history and saved browser profiles. Default osaHome(). */
  dataDir?: string;
  /** Extra options for the real engine (tests). */
  real?: Partial<RealEngineOptions>;
  /** Browser provider from the CLI (--browser); wins over OSA_BROWSER and the settings. */
  browser?: string;
}

/** The browser provider for these settings: --browser, OSA_BROWSER, settings, then browsa with a key, else local. */
export function providerFor(config: OsaConfig, choice: EngineChoice = {}): { id: ProviderId; why: string } {
  return chooseProvider({ flag: choice.browser, setting: config.browser, hasBrowsaKey: !!config.browsaApiKey, env: { ...process.env, OSA_CDP_URL: config.cdpUrl ?? process.env.OSA_CDP_URL } });
}

/**
 * True when the surfaces should use the real engine: Browsa with a key, a CDP URL, or a local
 * Chrome (chosen, or found on this computer when nothing else is set). Else the demo engine.
 */
export function wantsReal(config: OsaConfig, choice: EngineChoice = {}): boolean {
  if (choice.demo || process.env.OSA_DEMO === "1") return false;
  const p = providerFor(config, choice);
  if (p.id === "browsa") return !!config.browsaApiKey;
  if (p.id === "cdp") return !!(config.cdpUrl || process.env.OSA_CDP_URL);
  return p.why !== "default" || localChromeAvailable();
}

export async function createEngine(config: OsaConfig, choice: EngineChoice = {}): Promise<EnginePort> {
  if (wantsReal(config, choice)) return new RealEngine(realOptions(config, choice));
  const speed = choice.speed ?? (process.env.OSA_DEMO_SPEED ? Number(process.env.OSA_DEMO_SPEED) : 1);
  // OSA_DEMO_UNKNOWN_STORE=walmart: that store's demo order ends "unknown" (to see the check-the-store screens).
  const unknown = process.env.OSA_DEMO_UNKNOWN_STORE as StoreId | undefined;
  return new MockEngine({ speed, liveBase: choice.demoLiveBase ?? null, ...(unknown ? { unknownStore: unknown } : {}) });
}

export function realOptions(config: OsaConfig, choice: EngineChoice = {}): RealEngineOptions {
  return {
    apiKey: config.browsaApiKey,
    dataDir: choice.dataDir ?? osaHome(),
    browserMode: config.browserMode === "persistent" ? "persistent" : "burner",
    ...(config.proxy ? { proxy: config.proxy } : {}),
    llm: llmFor(config),
    browser: providerFor(config, choice).id,
    ...(config.cdpUrl ? { cdpUrl: config.cdpUrl } : {}),
    ...(config.storeProxies || config.proxyPool ? { proxies: { perStore: config.storeProxies, pool: config.proxyPool } } : {}),
    ...(config.shopCatalog ? { shopCatalog: true } : {}),
    ...choice.real,
  };
}

/**
 * The model that parses the request: the settings' own provider key when one is saved, else the
 * environment (OSA_LLM and the provider key). "browsa" in settings means no own key: the rule
 * parser runs unless the environment names a model.
 */
export function llmFor(config: OsaConfig): LLMConfig | undefined {
  const spec = config.llm?.trim();
  if (spec && spec !== "browsa" && config.llmApiKey) {
    try {
      const c = llmFromEnv({ OSA_LLM: spec, OSA_LLM_KEY: config.llmApiKey, OSA_LLM_BASE_URL: config.llmBaseUrl });
      if (c) return c;
    } catch { /* unknown provider: fall back to the environment */ }
  }
  try { return llmFromEnv(); } catch { return undefined; }
}

/**
 * The watch check on the store registry: on Browsa with a key, else on a headless local Chrome or
 * the CDP browser when one is set up (see wantsReal); undefined when there is no browser.
 */
export function checkFor(config: OsaConfig, dataDir = osaHome()): CheckFn | undefined {
  if (config.browsaApiKey && providerFor(config).id === "browsa") return createWatchCheck({ apiKey: config.browsaApiKey, dataDir, zip: config.zip });
  if (!wantsReal(config)) return undefined;
  const id = providerFor(config).id;
  if (id === "browsa") return undefined;
  const plan = new ProxyPlan({ all: config.proxy, perStore: config.storeProxies, pool: config.proxyPool });
  const provider = id === "cdp"
    ? new CdpProvider({ url: config.cdpUrl, llm: llmFor(config) })
    : new LocalProvider({ dataDir, headless: true, llm: llmFor(config) });
  return createWatchCheck({
    dataDir, zip: config.zip,
    openBrowser: async (store, domain) => provider.open(store, { domain, ...(id === "local" ? { proxy: (await plan.forStore(store)) ?? null } : {}) }),
  });
}

/** The real alerts store in <home>/watches.json. Checks read the current settings each time. */
export function createAlerts(home = osaHome(), config = new ConfigStore(home)): AlertsPort {
  return new WatchAlerts({
    dir: home,
    getCheck: async () => checkFor(await config.effective(), home),
    defaults: async () => {
      const c = await config.effective();
      return { stores: c.allowedStores, shopifyDomains: c.shopifyDomains };
    },
  });
}
