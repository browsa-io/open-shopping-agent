// A small AI fallback for any browser, with the user's own model key: read the page as an
// accessibility snapshot, ask the model for one action as JSON, do it with Playwright, repeat until
// "done" or the step budget (default 8). It runs on the store's own page, so it sees the same
// cookies and cart. On Browsa the fallback is a Browsa agent task instead (see browsers.ts).
//
// Safety: it never clicks a final order or pay button, never signs in and never types card
// details. Those actions are refused before they reach the page.

import type { Page } from "playwright-core";
import { completeJSON, type JSONRequest, type LLMConfig } from "../llm.js";

export type LoopAction =
  | { action: "click"; role?: string; name?: string; text?: string }
  | { action: "type"; role?: string; name?: string; text: string; submit?: boolean }
  | { action: "select"; role?: string; name?: string; value: string }
  | { action: "press"; key: string }
  | { action: "scroll"; direction?: "down" | "up" }
  | { action: "navigate"; url: string }
  | { action: "done"; result?: unknown };

export interface LoopOptions {
  llm: LLMConfig;
  schema?: object;
  maxSteps?: number;                  // default 8
  log?: (message: string) => void;
  signal?: AbortSignal;
  /** The model call (tests pass a scripted fake). Default: completeJSON on `llm`. */
  complete?: (cfg: LLMConfig, req: JSONRequest) => Promise<unknown>;
  /** Longest snapshot sent to the model, in characters. Default 14000. */
  maxSnapshot?: number;
}

export interface LoopResult {
  result: unknown;
  steps: number;
}

const FORBIDDEN = /place (your )?order|pay now|^pay\b|buy now|complete (order|purchase)|submit order|confirm (order|purchase)|sign ?in|log ?in|start (free )?trial|join prime|subscribe/i;
const CARD_FIELD = /card number|cvv|cvc|security code|expir/i;

const SYSTEM = [
  "You control a web browser to finish one small shopping step for a person. Each turn you get the page URL, title and its accessibility snapshot",
  "(lines like: - button \"Add to cart\" or - link \"Product name\"). Answer with exactly one JSON object, one action:",
  '{"action":"click","role":"button","name":"Add to cart"}  (role and accessible name from the snapshot; or {"action":"click","text":"visible text"})',
  '{"action":"type","role":"textbox","name":"Search","text":"usb c hub","submit":true}',
  '{"action":"select","role":"combobox","name":"Size","value":"Large"}',
  '{"action":"press","key":"Enter"}   {"action":"scroll","direction":"down"}   {"action":"navigate","url":"https://..."}',
  '{"action":"done","result": <the answer the task asks for>}',
  "Rules: never place an order or click a final Place order or Pay button, never sign in, never type card details, never accept a membership,",
  "subscription or free trial. If the page needs a person (sign-in, code, captcha), answer done with a result that says so.",
].join("\n");

/** Run the loop on `page`. Returns the "done" result (parsed JSON when the task has a schema). */
export async function runLocalAgent(page: Page, task: string, o: LoopOptions): Promise<LoopResult> {
  const max = Math.max(1, o.maxSteps ?? 8);
  const complete = o.complete ?? ((cfg, req) => completeJSON(cfg, req));
  const history: string[] = [];
  for (let step = 1; step <= max; step++) {
    if (o.signal?.aborted) throw new Error("run stopped");
    const snap = await snapshot(page, o.maxSnapshot ?? 14_000);
    const user = [
      `Task: ${task}`,
      o.schema ? `When done, "result" must match this JSON schema: ${JSON.stringify(o.schema)}` : "",
      `Step ${step} of ${max}.${history.length ? `\nWhat happened so far:\n${history.slice(-6).join("\n")}` : ""}`,
      `URL: ${safeUrl(page)}`,
      `Title: ${await page.title().catch(() => "")}`,
      "Snapshot:",
      snap,
    ].filter(Boolean).join("\n");
    let a: LoopAction;
    try {
      a = normalize(await complete(o.llm, { system: SYSTEM, user, maxTokens: 800 }));
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      // The model API itself failed (rate limit, bad key, no credit, network): asking again at once
      // only spends the person's calls. Stop here; a bad answer (not an action) is retried.
      if (/: HTTP \d{3}\b|network error|request timed out/.test(m)) throw new Error(`the model API failed: ${m.slice(0, 200)}`);
      history.push(`step ${step}: the answer was not a valid action (${m.slice(0, 120)})`);
      continue;
    }
    if (a.action === "done") {
      o.log?.(`AI fallback (your model) done in ${step} step${step === 1 ? "" : "s"}`);
      return { result: a.result, steps: step };
    }
    const outcome = await act(page, a).then(() => "ok", (e: unknown) => `failed: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 160)}`);
    history.push(`step ${step}: ${describe(a)} -> ${outcome}`);
    o.log?.(`AI fallback step ${step}: ${describe(a)} (${outcome})`);
  }
  throw new Error(`the AI fallback did not finish in ${max} steps`);
}

/** The page as text for the model: Playwright's ARIA snapshot, else visible text. */
export async function snapshot(page: Page, max: number): Promise<string> {
  let s = "";
  try {
    s = await page.locator("body").ariaSnapshot({ timeout: 8000 });
  } catch {
    s = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  }
  return s.length > max ? `${s.slice(0, max)}\n... (cut)` : s;
}

function normalize(x: unknown): LoopAction {
  const a = x as Record<string, unknown>;
  if (!a || typeof a !== "object" || typeof a.action !== "string") throw new Error("no action");
  const action = a.action.toLowerCase();
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  switch (action) {
    case "click": return { action, role: str(a.role), name: str(a.name), text: str(a.text) };
    case "type": return { action, role: str(a.role), name: str(a.name), text: String(a.text ?? ""), submit: !!a.submit };
    case "select": return { action, role: str(a.role), name: str(a.name), value: String(a.value ?? "") };
    case "press": return { action, key: String(a.key ?? "Enter") };
    case "scroll": return { action, direction: a.direction === "up" ? "up" : "down" };
    case "navigate": return { action, url: String(a.url ?? "") };
    case "done": {
      let r = a.result;
      if (typeof r === "string") { try { r = JSON.parse(r); } catch { /* keep the text */ } }
      return { action, result: r };
    }
    default: throw new Error(`unknown action ${action}`);
  }
}

function describe(a: LoopAction): string {
  switch (a.action) {
    case "click": return `click ${a.role ?? ""} "${a.name ?? a.text ?? ""}"`.replace(/\s+/g, " ");
    case "type": return `type into ${a.role ?? ""} "${a.name ?? ""}"`.replace(/\s+/g, " ");
    case "select": return `select "${a.value}" in "${a.name ?? ""}"`;
    case "press": return `press ${a.key}`;
    case "scroll": return `scroll ${a.direction ?? "down"}`;
    case "navigate": return `open ${a.url.slice(0, 100)}`;
    default: return a.action;
  }
}

function target(page: Page, a: { role?: string; name?: string; text?: string }) {
  if (a.role && a.name) return page.getByRole(a.role as Parameters<Page["getByRole"]>[0], { name: a.name }).first();
  if (a.name) return page.getByLabel(a.name).or(page.getByText(a.name)).first();
  if (a.text) return page.getByText(a.text).first();
  throw new Error("the action names no element");
}

/** Do one action, refusing the ones the rules forbid. */
export async function act(page: Page, a: LoopAction): Promise<void> {
  const label = "name" in a || "text" in a ? `${(a as { name?: string }).name ?? ""} ${(a as { text?: string }).text ?? ""}` : "";
  switch (a.action) {
    case "click":
      if (FORBIDDEN.test(label)) throw new Error("refused: the agent never places orders, pays or signs in");
      await target(page, a).click({ timeout: 10_000 });
      break;
    case "type":
      if (CARD_FIELD.test(a.name ?? "")) throw new Error("refused: the agent never types card details");
      await target(page, a).fill(a.text, { timeout: 10_000 });
      if (a.submit) await page.keyboard.press("Enter");
      break;
    case "select":
      await target(page, a).selectOption({ label: a.value }, { timeout: 10_000 }).catch(() => target(page, a).selectOption(a.value, { timeout: 10_000 }));
      break;
    case "press":
      await page.keyboard.press(a.key);
      break;
    case "scroll":
      await page.mouse.wheel(0, a.direction === "up" ? -800 : 800);
      break;
    case "navigate":
      if (!/^https?:\/\//i.test(a.url)) throw new Error("refused: only http(s) pages");
      await page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      break;
    default:
      return;
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(600);
}

function safeUrl(page: Page): string {
  try { return page.url(); } catch { return ""; }
}
