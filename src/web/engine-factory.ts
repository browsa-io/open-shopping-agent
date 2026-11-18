// Picks the engine for the surfaces (web app, CLI, MCP): the real engine on Phantom browsers when a
// Browsa key is set (BROWSA_API_KEY or the saved settings key) and OSA_DEMO is not 1, else the demo
// engine (MockEngine), which shows "Demo data" and contacts no store.

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

export interface EngineChoice {
  demo?: boolean;            // force the demo engine (OSA_DEMO=1 or --demo)
  speed?: number;            // demo pace (1 = realistic, 0 = instant)
  /** Demo Phantom Live placeholder path; the web app serves one, the CLI and MCP have none. */
  demoLiveBase?: string | null;
  /** Folder for run history and saved browser profiles. Default osaHome(). */
  dataDir?: string;
  /** Extra options for the real engine (tests). */
  real?: Partial<RealEngineOptions>;
}

/** True when the surfaces should use the real engine. */
export function wantsReal(config: OsaConfig, choice: EngineChoice = {}): boolean {
  return !choice.demo && process.env.OSA_DEMO !== "1" && !!config.browsaApiKey;
}

export async function createEngine(config: OsaConfig, choice: EngineChoice = {}): Promise<EnginePort> {
  if (wantsReal(config, choice)) return new RealEngine(realOptions(config, choice));
  const speed = choice.speed ?? (process.env.OSA_DEMO_SPEED ? Number(process.env.OSA_DEMO_SPEED) : 1);
  return new MockEngine({ speed, liveBase: choice.demoLiveBase ?? null });
}

export function realOptions(config: OsaConfig, choice: EngineChoice = {}): RealEngineOptions {
  return {
    apiKey: config.browsaApiKey,
    dataDir: choice.dataDir ?? osaHome(),
    browserMode: config.browserMode === "persistent" ? "persistent" : "burner",
    ...(config.proxy ? { proxy: config.proxy } : {}),
    llm: llmFor(config),
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
      const c = llmFromEnv({ OSA_LLM: spec, OSA_LLM_KEY: config.llmApiKey });
      if (c) return c;
    } catch { /* unknown provider: fall back to the environment */ }
  }
  try { return llmFromEnv(); } catch { return undefined; }
}

/** The watch check on the store registry, or undefined without a Browsa key. */
export function checkFor(config: OsaConfig, dataDir = osaHome()): CheckFn | undefined {
  if (!config.browsaApiKey) return undefined;
  return createWatchCheck({ apiKey: config.browsaApiKey, dataDir, zip: config.zip });
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
