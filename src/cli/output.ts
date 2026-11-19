// Agent-readable output, shared by the CLI (--json) and the MCP server.
//
//   success: { "ok": true,  "v": 1, "data": {...}, "next": ["osa orders", ...] }
//   error:   { "ok": false, "v": 1, "error": { "code", "message", "retryable", "next": [...] }, "data"?: {...} }
//
// Exit codes (CLI): 0 ok, 1 user error, 2 store or network problem (retry later), 3 needs the person
// (captcha, sign-in, approval, an order to check on the store), 4 safety refusal.

import { CliError } from "./args.js";
import { LimitError } from "../core/limits.js";

export const OUTPUT_VERSION = 1;

export const EXIT = { ok: 0, user: 1, retry: 2, needsUser: 3, safety: 4 } as const;

const CODES = {
  // 1: the request or the arguments
  bad_args: EXIT.user,
  not_found: EXIT.user,
  nothing_to_do: EXIT.user,
  // 2: the store or the network; trying again later may work
  store_error: EXIT.retry,
  network: EXIT.retry,
  timeout: EXIT.retry,
  blocked: EXIT.retry,
  no_browser: EXIT.retry,
  // 3: a person has to act
  needs_sign_in: EXIT.needsUser,
  needs_captcha: EXIT.needsUser,
  needs_user: EXIT.needsUser,
  needs_approval: EXIT.needsUser,
  order_unknown: EXIT.needsUser,
  // 4: a safety rule refused it
  approval_mismatch: EXIT.safety,
  total_changed: EXIT.safety,
  over_budget: EXIT.safety,
  credits_cap: EXIT.safety,
  already_ordered: EXIT.safety,
  orders_disabled: EXIT.safety,
  safety_refusal: EXIT.safety,
  // anything else: a bug; do not retry blindly
  internal: EXIT.user,
} as const;

export type ErrorCode = keyof typeof CODES;

export interface OkEnvelope<T = unknown> { ok: true; v: number; data: T; next: string[] }
export interface ErrorBody { code: ErrorCode; message: string; retryable: boolean; next: string[] }
export interface ErrEnvelope { ok: false; v: number; error: ErrorBody; data?: unknown }
export type Envelope<T = unknown> = OkEnvelope<T> | ErrEnvelope;

export function exitCodeFor(code: ErrorCode): number {
  return CODES[code] ?? EXIT.user;
}

export function isRetryable(code: ErrorCode): boolean {
  return exitCodeFor(code) === EXIT.retry;
}

export function okEnvelope<T>(data: T, next: string[] = []): OkEnvelope<T> {
  return { ok: true, v: OUTPUT_VERSION, data, next };
}

export function errorEnvelope(code: ErrorCode, message: string, next: string[] = [], data?: unknown): ErrEnvelope {
  return { ok: false, v: OUTPUT_VERSION, error: { code, message, retryable: isRetryable(code), next }, ...(data === undefined ? {} : { data }) };
}

/** The error code for a message from the engine, a store or the approval gate. */
export function classify(message: string): ErrorCode {
  const m = message || "";
  if (/OSA_MCP_ALLOW_ORDERS|placing orders from MCP is off/i.test(m)) return "orders_disabled";
  if (/may have gone through|order state unknown|check your orders on/i.test(m)) return "order_unknown";
  if (/already placed|already used|being placed now/i.test(m)) return "already_ordered";
  if (/does not match the review total|approved total .* does not match|approval is for|approval must come from/i.test(m)) return "approval_mismatch";
  if (/total is now|total changed/i.test(m)) return "total_changed";
  if (/over (the|your) .*budget|budget is in/i.test(m)) return "over_budget";
  if (/credits?.*(cap|limit|left)|run limit/i.test(m)) return "credits_cap";
  if (/subscription|membership|trial line|not an allowed store|not in the allowed stores|requireApproval/i.test(m)) return "safety_refusal";
  if (/\bsign[ -]?in\b|\blog ?in\b/i.test(m)) return "needs_sign_in";
  if (/captcha|bot check|press[- ]and[- ]hold|are you a human|robot/i.test(m)) return "needs_captcha";
  if (/needs the person|needs you|verification code|3-?D Secure|live browser|phantom live/i.test(m)) return "needs_user";
  if (/not waiting for approval|waiting for approval|review it again|review the checkout again|review is too old/i.test(m)) return "needs_approval";
  if (/unknown (or finished )?run|run .* not found|not running|no such run|unknown store|nothing at .* is waiting/i.test(m)) return "not_found";
  if (/timed? ?out|took too long/i.test(m)) return "timeout";
  if (/browser slots|no free browser|slots? (are|is) (busy|full)/i.test(m)) return "no_browser";
  if (/ERR_[A-Z_]+|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|network|tunnel/i.test(m)) return "network";
  if (/status 40[13]|access denied|refused the page|blocked/i.test(m)) return "blocked";
  return "store_error";
}

/** The code and message for anything thrown. */
export function errorOf(e: unknown): { code: ErrorCode; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof CliError) return { code: "bad_args", message };
  if (e instanceof LimitError) {
    if (e.code === "budget") return { code: "over_budget", message };
    if (e.code === "credits") return { code: "credits_cap", message };
    if (e.code === "approval") {
      const c = classify(message);
      return { code: exitCodeFor(c) === EXIT.safety || c === "order_unknown" || c === "needs_approval" || c === "needs_user" ? c : "safety_refusal", message };
    }
    return { code: "safety_refusal", message };
  }
  return { code: classify(message), message };
}

/** The most pressing code among several (needs the person > safety > retry > user error). */
export function worstCode(codes: ErrorCode[]): ErrorCode | undefined {
  const rank = (c: ErrorCode) => ({ [EXIT.needsUser]: 4, [EXIT.safety]: 3, [EXIT.retry]: 2, [EXIT.user]: 1 } as Record<number, number>)[exitCodeFor(c)] ?? 0;
  return [...codes].sort((a, b) => rank(b) - rank(a))[0];
}

export function printJson(out: NodeJS.WritableStream, env: Envelope): void {
  out.write(JSON.stringify(env, null, 2) + "\n");
}
