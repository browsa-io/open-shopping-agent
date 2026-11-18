// Settings API for bring-your-own keys: "Test key" (the model answers a tiny prompt) and "Test proxy"
// (the exit IP and country through the proxy). Saved keys and proxies stay on the server: a masked
// or empty value in the body means "test the saved one". Results never include a key or password.

import type { OsaConfig } from "./config.js";
import { llmFor, providerFor } from "./engine-factory.js";
import { completeJSON, llmFromEnv, type LLMConfig } from "../core/llm.js";
import { maskProxyText, PROVIDER_LABELS, testProxy, type ProxyTestResult } from "../core/providers/index.js";
import { STORE_IDS } from "./format.js";
import type { StoreId } from "../core/types.js";

export interface KeyTestResult {
  ok: boolean;
  model?: string;
  ms?: number;
  error?: string;
}

const isMasked = (v: unknown) => typeof v !== "string" || !v.trim() || v.includes("•");

/** Ask the model for {"ok":true}. Body: { llm?, llmApiKey?, llmBaseUrl? }; empty or masked: the saved values. */
export async function testModelKey(body: unknown, saved: OsaConfig, o: { complete?: typeof completeJSON } = {}): Promise<KeyTestResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  let cfg: LLMConfig | undefined;
  try {
    const spec = typeof b.llm === "string" && b.llm.trim() ? b.llm.trim() : saved.llm;
    const key = isMasked(b.llmApiKey) ? saved.llmApiKey : String(b.llmApiKey).trim();
    const base = typeof b.llmBaseUrl === "string" && b.llmBaseUrl.trim() && !b.llmBaseUrl.includes("•") ? b.llmBaseUrl.trim() : saved.llmBaseUrl;
    cfg = spec && spec !== "browsa" && key ? llmFromEnv({ OSA_LLM: spec, OSA_LLM_KEY: key, OSA_LLM_BASE_URL: base }) : llmFor(saved);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!cfg) return { ok: false, error: "No model key: choose a provider and paste a key" };
  const t0 = Date.now();
  try {
    const r = await (o.complete ?? completeJSON)<{ ok?: boolean }>({ ...cfg, timeoutMs: 30_000 }, {
      system: "Answer with JSON only.", user: 'Reply with {"ok": true}', maxTokens: 50,
    });
    return { ok: r?.ok === true, model: `${cfg.provider}:${cfg.model}`, ms: Date.now() - t0, ...(r?.ok === true ? {} : { error: "the model answered, but not as asked" }) };
  } catch (e) {
    return { ok: false, model: `${cfg.provider}:${cfg.model}`, error: scrubKey(String((e as Error).message), cfg.apiKey) };
  }
}

/** Test a proxy. Body: { proxy } (typed now), or { store } / { pool: n } to test a saved one. */
export async function testProxyFromSettings(body: unknown, saved: OsaConfig, o: { test?: typeof testProxy } = {}): Promise<ProxyTestResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const test = o.test ?? testProxy;
  let text: string | undefined;
  if (typeof b.proxy === "string" && b.proxy.trim() && !b.proxy.includes("•") && !b.proxy.includes("(with login)") && b.proxy !== maskProxyText(saved.proxy)) text = b.proxy.trim();
  else if (typeof b.store === "string" && STORE_IDS.includes(b.store as StoreId)) text = saved.storeProxies?.[b.store as StoreId];
  else if (typeof b.pool === "number") text = saved.proxyPool?.[b.pool];
  else text = saved.proxy;
  if (!text) return { ok: false, proxy: "", error: "No proxy to test" };
  return test(text);
}

/** What /api/meta adds: the browser of new runs. */
export function browserMeta(c: OsaConfig): { browser: string; browserLabel: string } {
  const id = providerFor(c).id;
  return { browser: id, browserLabel: PROVIDER_LABELS[id] };
}

function scrubKey(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}
