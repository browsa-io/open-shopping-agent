// Bring your own model key: which model the AI fallback uses on each browser provider.
//
//   Browsa provider: a Browsa agent task with the user's key (`llm: "anthropic:<model>"` plus
//   `llmApiKey`, or `llmBaseUrl` for an OpenAI-compatible API such as OpenRouter; Browsa adds no
//   markup), or a saved Browsa key (OSA_AI_LLM_KEY_ID). Without a key: Browsa's hosted tier "browsa".
//   Local and CDP providers: the local agent loop (agent-loop.ts) with the user's key. Without a key
//   the AI fallback is off there, and request parsing uses the rule parser.

import type { LLMConfig } from "../llm.js";

export interface BrowsaTaskLlm {
  aiLlm: string;
  aiLlmApiKey?: string;
  aiLlmBaseUrl?: string;
  aiLlmKeyId?: string;
  /** "own key", "saved Browsa key" or "Browsa hosted". */
  source: "own" | "saved" | "hosted";
}

const HOSTED = new Set(["browsa", "browsa-fast", "browsa-smart"]);

/**
 * The Browsa task model for the AI fallback. Explicit options win (aiLlm, OSA_AI_LLM), then the
 * user's own model config, then a saved Browsa key id, then the hosted tier.
 */
export function browsaTaskLlm(o: {
  llm?: LLMConfig;
  aiLlm?: string;
  aiLlmApiKey?: string;
  env?: Record<string, string | undefined>;
}): BrowsaTaskLlm {
  const env = o.env ?? process.env;
  const explicit = o.aiLlm ?? env.OSA_AI_LLM;
  const keyId = env.OSA_AI_LLM_KEY_ID?.trim() || undefined;
  if (explicit) {
    if (HOSTED.has(explicit)) return { aiLlm: explicit, source: "hosted" };
    if (o.aiLlmApiKey) return { aiLlm: explicit, aiLlmApiKey: o.aiLlmApiKey, source: "own" };
    if (o.llm && explicit.startsWith(`${o.llm.provider}:`)) return { aiLlm: explicit, aiLlmApiKey: o.llm.apiKey, ...(o.llm.baseUrl ? { aiLlmBaseUrl: o.llm.baseUrl } : {}), source: "own" };
    if (keyId) return { aiLlm: explicit, aiLlmKeyId: keyId, source: "saved" };
    return { aiLlm: explicit, source: "own" };
  }
  if (o.llm) {
    return {
      aiLlm: `${o.llm.provider}:${o.llm.model}`, aiLlmApiKey: o.llm.apiKey,
      ...(o.llm.baseUrl ? { aiLlmBaseUrl: o.llm.baseUrl } : {}), source: "own",
    };
  }
  if (keyId) return { aiLlm: env.OSA_AI_LLM_MODEL || "anthropic:claude-sonnet-5-5", aiLlmKeyId: keyId, source: "saved" };
  return { aiLlm: "browsa", source: "hosted" };
}

/** One line for the UI and logs, never the key. */
export function describeFallback(provider: "browsa" | "local" | "cdp", llm: LLMConfig | undefined, t?: BrowsaTaskLlm): string {
  if (provider === "browsa") {
    if (!t || t.source === "hosted") return "AI fallback: Browsa hosted model";
    return `AI fallback: ${t.aiLlm} with your ${t.source === "saved" ? "saved Browsa" : "own"} key`;
  }
  return llm ? `AI fallback: ${llm.provider}:${llm.model} with your key, on this browser` : "AI fallback is off: no model key (set OSA_LLM and OSA_LLM_API_KEY, or run with Browsa)";
}
