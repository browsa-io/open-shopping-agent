// A small provider-neutral LLM client for JSON answers. No SDKs: plain fetch, so the package keeps
// two runtime dependencies. Used only to parse the shopping request; the store work runs on
// Browsa (direct code first, Browsa agent tasks as the fallback).
//
//   OSA_LLM=anthropic:claude-sonnet-5-5      key: ANTHROPIC_API_KEY
//   OSA_LLM=openai:gpt-4o-mini                   key: OPENAI_API_KEY   (OSA_LLM_BASE_URL for any compatible API)
//   OSA_LLM=openrouter:anthropic/claude-sonnet-5.5   key: OPENROUTER_API_KEY
//   OSA_LLM=google:gemini-2.5-flash          key: GOOGLE_API_KEY or GEMINI_API_KEY
//   OSA_LLM_KEY overrides the key for any provider. OSA_LLM=none turns the LLM off.

export type LLMProvider = "anthropic" | "openai" | "google";

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;                    // OpenAI-compatible base, e.g. https://openrouter.ai/api/v1
  timeoutMs?: number;                  // default 60s
  fetch?: typeof globalThis.fetch;
}

export interface JSONRequest {
  system: string;
  user: string;
  /** JSON schema of the answer. Sent as structured output where the provider supports it. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

const DEFAULT_MODEL: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
};

/**
 * Read the LLM config from the environment. Returns undefined when there is no key (the rule
 * parser is used then). OSA_LLM picks the provider and model; without it the first key found wins.
 */
export function llmFromEnv(env: Record<string, string | undefined> = process.env): LLMConfig | undefined {
  const spec = env.OSA_LLM?.trim();
  if (spec && /^(none|off|false|0)$/i.test(spec)) return undefined;
  let provider: string | undefined;
  let model: string | undefined;
  if (spec) {
    const i = spec.indexOf(":");
    provider = (i < 0 ? spec : spec.slice(0, i)).toLowerCase();
    model = i < 0 ? undefined : spec.slice(i + 1);
  }
  const keyFor = (p: string): string | undefined => {
    if (env.OSA_LLM_KEY) return env.OSA_LLM_KEY;
    if (p === "anthropic") return env.ANTHROPIC_API_KEY;
    if (p === "openai") return env.OPENAI_API_KEY;
    if (p === "openrouter") return env.OPENROUTER_API_KEY;
    if (p === "google" || p === "gemini") return env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
    return undefined;
  };
  if (!provider) {
    if (env.ANTHROPIC_API_KEY) provider = "anthropic";
    else if (env.OPENAI_API_KEY) provider = "openai";
    else if (env.OPENROUTER_API_KEY) provider = "openrouter";
    else if (env.GOOGLE_API_KEY || env.GEMINI_API_KEY) provider = "google";
    else return undefined;
  }
  const apiKey = keyFor(provider);
  if (!apiKey) return undefined;
  if (provider === "openrouter") {
    return { provider: "openai", model: model || "anthropic/claude-sonnet-5.5", apiKey, baseUrl: env.OSA_LLM_BASE_URL || "https://openrouter.ai/api/v1" };
  }
  if (provider === "gemini") provider = "google";
  if (provider !== "anthropic" && provider !== "openai" && provider !== "google") {
    throw new Error(`OSA_LLM: unknown provider "${provider}" (use anthropic, openai, openrouter or google)`);
  }
  return { provider, model: model || DEFAULT_MODEL[provider], apiKey, baseUrl: env.OSA_LLM_BASE_URL || undefined };
}

export function describeLLM(cfg: LLMConfig | undefined): string {
  return cfg ? `${cfg.provider}:${cfg.model}` : "rules (no LLM key)";
}

/** Ask the model for one JSON object and parse it. Throws on HTTP errors or unparsable output. */
export async function completeJSON<T = unknown>(cfg: LLMConfig, req: JSONRequest): Promise<T> {
  const text = await completeText(cfg, req);
  return extractJSON<T>(text);
}

async function completeText(cfg: LLMConfig, req: JSONRequest): Promise<string> {
  const maxTokens = req.maxTokens ?? 4000;
  if (cfg.provider === "anthropic") {
    const base = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    };
    if (req.schema) body.output_config = { format: { type: "json_schema", schema: req.schema } };
    const headers = { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" };
    let r = await post(cfg, `${base}/v1/messages`, headers, body);
    if (r.status === 400 && req.schema) {
      // Older model or proxy without structured outputs: ask for JSON in the prompt instead.
      delete body.output_config;
      r = await post(cfg, `${base}/v1/messages`, headers, body);
    }
    const j = await readJSON(r, "anthropic");
    if (j.stop_reason === "refusal") throw new Error("anthropic: the model declined the request");
    const blocks = Array.isArray(j.content) ? j.content : [];
    return blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
  }
  if (cfg.provider === "openai") {
    const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
      response_format: { type: "json_object" },
    };
    const headers = { Authorization: `Bearer ${cfg.apiKey}` };
    let r = await post(cfg, `${base}/chat/completions`, headers, body);
    if (r.status === 400) {
      // Some compatible servers reject response_format or max_tokens (newer OpenAI models want
      // max_completion_tokens). Retry with the plainest body.
      delete body.response_format;
      delete body.max_tokens;
      r = await post(cfg, `${base}/chat/completions`, headers, body);
    }
    const j = await readJSON(r, "openai");
    return j.choices?.[0]?.message?.content ?? "";
  }
  // Google Gemini generateContent.
  const base = (cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: maxTokens },
  };
  const r = await post(cfg, `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`, { "x-goog-api-key": cfg.apiKey }, body);
  const j = await readJSON(r, "google");
  const parts = j.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: any) => p?.text ?? "").join("");
}

async function post(cfg: LLMConfig, url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  const f = cfg.fetch ?? globalThis.fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 60_000);
  try {
    return await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`${cfg.provider}: request timed out`);
    throw new Error(`${cfg.provider}: network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

async function readJSON(r: Response, who: string): Promise<any> {
  const text = await r.text();
  if (!r.ok) {
    // Never echo request headers; the body of an error answer is safe to show in part.
    throw new Error(`${who}: HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${who}: answer was not JSON`);
  }
}

/** Parse the first JSON object in a model answer (tolerates ```json fences and prose around it). */
export function extractJSON<T = unknown>(text: string): T {
  const t = text.trim();
  try {
    return JSON.parse(t) as T;
  } catch { /* fall through */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1]) as T; } catch { /* fall through */ }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) as T; } catch { /* fall through */ }
  }
  throw new Error("the model answer had no JSON object");
}
