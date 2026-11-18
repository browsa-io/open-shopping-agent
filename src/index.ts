// Open Shopping Agent: public API.

export * from "./core/types.js";
export type { StoreAdapter, StoreContext, AdapterUtil } from "./stores/adapter.js";

export { ShoppingAgent, ShoppingRun, normalizeRequest, shopKey, withTimeout, errText } from "./core/engine.js";
export type { ShoppingAgentOptions, RunOptions } from "./core/engine.js";

export { parseRequest, parseRules, parseWithLLM, normalizeLLMAnswer, splitItems, ALL_STORES } from "./core/parse.js";
export type { ParseOptions } from "./core/parse.js";

export { llmFromEnv, completeJSON, extractJSON, describeLLM } from "./core/llm.js";
export type { LLMConfig, LLMProvider, JSONRequest } from "./core/llm.js";

export {
  BrowserPool, STORE_HOME, aiTaskText, jobResult, defaultDomain,
  PERSISTENT_CREATE_CREDITS, PERSISTENT_SESSION_CREDITS, BURNER_CREDITS, SESSION_OPEN_CREDITS,
} from "./core/browsers.js";
export type { BrowserMode, BrowserPoolOptions, StoreBrowser, BrowsaClient } from "./core/browsers.js";

export {
  scoreOffers, pickForItem, pickAll, deliveredTotal, bayesianRating, titleMatch, missingRequirements,
  exclusionReason, reasonFor, dedupeOffers,
} from "./core/rank.js";
export type { Goal, RankOptions, ScoredOffer, PickResult } from "./core/rank.js";

export {
  LimitError, defaultLimits, resolveLimits, effectiveBudget, allowedStores, approvalProblem, approvalFor,
  forbiddenLines, CreditMeter, balanceOf, DEFAULT_MAX_CREDITS,
} from "./core/limits.js";
export type { LimitCode, ApprovalCheck } from "./core/limits.js";

export { createWatchCheck } from "./core/watch-check.js";
export type { WatchCheckOptions } from "./core/watch-check.js";

export { RunRecorder, listRuns, getRun, newRunId, runsDir, redactLive } from "./core/history.js";
export type { RunListItem, SavedRun } from "./core/history.js";

export {
  loadAdapter, loadAdapters, registerAdapter, unregisterAdapter, isAdapter, AdapterNotInstalledError, STORE_IDS, STORE_NAMES,
} from "./stores/index.js";

export {
  parseMoney, moneyFromParts, formatMoney, addMoney, parseStars, parseCount, clean, needsUser, firstVisible, nowIso,
} from "./stores/util.js";
