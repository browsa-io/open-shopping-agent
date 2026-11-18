import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRules, parseRequest, normalizeLLMAnswer, splitItems } from "../../src/core/parse.js";
import { llmFromEnv, completeJSON, extractJSON } from "../../src/core/llm.js";

test("rule parser: items, quantity, per-item limit, must-haves, budget, stores", () => {
  const r = parseRules("2x USB-C cables under $15, a USB-C hub with HDMI and 100W pass-through, and an AAA battery pack. Budget $120 total, on Amazon or Walmart");
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.quantity), [2, 1, 1]);
  assert.equal(r.items[0].query, "USB-C cables");
  assert.deepEqual(r.items[0].maxPrice, { cents: 1500, currency: "USD" });
  assert.deepEqual(r.items[1].mustHave, ["HDMI", "100W pass-through"]);
  assert.equal(r.items[2].query, "AAA battery pack");
  assert.deepEqual(r.budget, { cents: 12000, currency: "USD" });
  assert.deepEqual(r.stores, ["amazon", "walmart"]);
  assert.equal(r.goal, "best_value");
  assert.deepEqual(r.items.map((i) => i.id), ["item-1", "item-2", "item-3"]);
});

test("rule parser: Shopify domain, size, ZIP, goal", () => {
  const r = parseRules("I need a black hoodie size L under $40 from allbirds.com, ship to 82001");
  assert.deepEqual(r.stores, ["shopify"]);
  assert.deepEqual(r.shopifyDomains, ["allbirds.com"]);
  assert.equal(r.items[0].options?.size, "L");
  assert.equal(r.items[0].maxPrice?.cents, 4000);
  assert.equal(r.zip, "82001");
  assert.equal(parseRules("cheapest 6 ft HDMI cable").goal, "cheapest");
  assert.equal(parseRules("cheapest 6 ft HDMI cable").items[0].query, "6 ft HDMI cable");
  assert.equal(parseRules("the fastest phone charger").goal, "fastest");
  assert.equal(parseRules("top rated air fryer").goal, "top_rated");
});

test("rule parser: number words, packs, pairs, '6 ft' is not a quantity", () => {
  const r = parseRules("buy two packs of paper towels and a pair of AirPods Pro");
  assert.equal(r.items[0].query, "paper towels");
  assert.equal(r.items[0].quantity, 2);
  assert.equal(r.items[1].query, "AirPods Pro");
  assert.equal(r.items[1].quantity, 1);
  assert.equal(parseRules("6 ft HDMI cable").items[0].quantity, 1);
  assert.equal(parseRules("3 notebooks").items[0].quantity, 3);
  assert.equal(parseRules("notebooks x4").items[0].quantity, 4);
});

test("rule parser: an option after a comma stays with its item", () => {
  const r = parseRules("hoodie in black, size M");
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].options, { color: "Black", size: "M" });
});

test("rule parser: default stores leave out Shopify without a domain; Target only as a store phrase", () => {
  const r = parseRules("a desk lamp");
  assert.deepEqual(r.stores, ["amazon", "walmart", "ebay", "bestbuy", "target"]);
  assert.deepEqual(parseRules("a monitor at Best Buy or Target").stores, ["bestbuy", "target"]);
  assert.ok(!parseRules("dog toys, target price $20").stores.every((s) => s === "target"));
});

test("splitItems keeps 'black and white' together but splits before a new item", () => {
  assert.deepEqual(splitItems("a black and white poster and 2 frames"), ["a black and white poster", "2 frames"]);
});

test("normalizeLLMAnswer converts dollars, options, stores and drops bad values", () => {
  const r = normalizeLLMAnswer("p", {
    items: [
      { query: "usb c hub", description: "a hub", quantity: 0, options: [{ name: "Color", value: "Gray" }], maxPriceUsd: 39.99, mustHave: ["HDMI"], niceToHave: [] },
      { query: "  ", description: "", quantity: 1 },
    ],
    stores: ["amazon", "nope"], shopifyDomains: ["https://www.allbirds.com/", "amazon.com"], budgetUsd: 100, zip: "8200", goal: "fastest",
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].quantity, 1);
  assert.deepEqual(r.items[0].options, { color: "Gray" });
  assert.deepEqual(r.items[0].maxPrice, { cents: 3999, currency: "USD" });
  assert.deepEqual(r.stores, ["amazon", "shopify"]);
  assert.deepEqual(r.shopifyDomains, ["allbirds.com"]);
  assert.equal(r.budget?.cents, 10000);
  assert.equal(r.zip, undefined);
  assert.equal(r.goal, "fastest");
});

test("parseRequest falls back to rules when the LLM fails", async () => {
  const logs: string[] = [];
  const failing = async () => new Response("nope", { status: 500 });
  const r = await parseRequest("2 lightning cables", {
    llm: { provider: "anthropic", model: "m", apiKey: "k", fetch: failing as typeof fetch },
    onLog: (m) => logs.push(m),
  });
  assert.equal(r.items[0].quantity, 2);
  assert.match(logs[0], /LLM parse failed/);
});

test("llmFromEnv picks the provider and key", () => {
  assert.equal(llmFromEnv({}), undefined);
  assert.equal(llmFromEnv({ OSA_LLM: "none", ANTHROPIC_API_KEY: "a" }), undefined);
  assert.deepEqual(llmFromEnv({ ANTHROPIC_API_KEY: "a" }), { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "a", baseUrl: undefined });
  const or = llmFromEnv({ OSA_LLM: "openrouter:anthropic/claude-sonnet-5.5", OPENROUTER_API_KEY: "o" });
  assert.equal(or?.provider, "openai");
  assert.equal(or?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(llmFromEnv({ OSA_LLM: "google:gemini-2.5-pro", GEMINI_API_KEY: "g" })?.model, "gemini-2.5-pro");
  assert.equal(llmFromEnv({ OSA_LLM: "openai:gpt-x" }), undefined);
  assert.throws(() => llmFromEnv({ OSA_LLM: "foo:bar", OSA_LLM_KEY: "x" }));
});

test("completeJSON speaks each provider's API", async () => {
  const seen: { url: string; body: any; headers: Record<string, string> }[] = [];
  const answer = (url: string) => {
    if (url.includes("anthropic")) return { content: [{ type: "text", text: '{"ok":1}' }], stop_reason: "end_turn" };
    if (url.includes("chat/completions")) return { choices: [{ message: { content: '```json\n{"ok":2}\n```' } }] };
    return { candidates: [{ content: { parts: [{ text: '{"ok":3}' }] } }] };
  };
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(answer(url)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const req = { system: "s", user: "u", schema: { type: "object" } };
  assert.deepEqual(await completeJSON({ provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "a", fetch: f }, req), { ok: 1 });
  assert.deepEqual(await completeJSON({ provider: "openai", model: "x", apiKey: "o", baseUrl: "https://openrouter.ai/api/v1", fetch: f }, req), { ok: 2 });
  assert.deepEqual(await completeJSON({ provider: "google", model: "gemini-2.5-flash", apiKey: "g", fetch: f }, req), { ok: 3 });
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen[0].headers["x-api-key"], "a");
  assert.deepEqual(seen[0].body.output_config, { format: { type: "json_schema", schema: { type: "object" } } });
  assert.equal(seen[1].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seen[1].headers.Authorization, "Bearer o");
  assert.match(seen[2].url, /models\/gemini-2\.5-flash:generateContent$/);
});

test("extractJSON tolerates prose around the object", () => {
  assert.deepEqual(extractJSON('Here you go: {"a": [1]} done'), { a: [1] });
  assert.throws(() => extractJSON("no json"));
});
