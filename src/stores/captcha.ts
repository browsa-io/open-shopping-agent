// Captchas and bot checks solved by Browsa in the browser's own session.
//
// On Browsa, the CDP socket answers one extra command itself (it never reaches the browser):
//
//   Browsa.solveCaptcha {targetId?}  ->  {solved, kind, reason, message?, rounds, seconds, puzzle}
//
// with the events Browsa.captchaSolving, Browsa.captchaSolved and Browsa.captchaFailed on the same
// socket. Adapters do not call this file directly: util's passBotCheck and passPressAndHold try
// Browsa first, then OSA's own code (waiting, press and hold) when Browsa does not handle the
// check, and hand the browser to the person (Phantom Live) when Browsa tried and failed.
//
// On your own Chrome or a CDP browser nothing here runs: captchas solved in-session need Browsa.

import type { NeedsUser } from "../core/types.js";
import type { StoreContext } from "./adapter.js";

/** A bot check that did not clear. The engine reports it as a bot block. */
export class BotCheckError extends Error {}

/**
 * Browsa tried the check and failed: the browser goes to the person. `handoff` carries the
 * Phantom Live link; the engine sends it as needs_user (captcha_handoff).
 */
export class CaptchaHandoffError extends BotCheckError {
  constructor(message: string, readonly handoff: NeedsUser) { super(message); }
}

/** The part of a Playwright CDPSession this file uses (tests pass a fake). */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on?(event: string, fn: (params: Record<string, unknown>) => void): unknown;
  off?(event: string, fn: (params: Record<string, unknown>) => void): unknown;
  detach?(): Promise<void>;
}

/** Browsa.solveCaptcha's reply. */
export interface CaptchaReply {
  solved: boolean;
  kind?: string;
  reason?: string;
  message?: string;
  rounds?: number;
  seconds?: number;
  puzzle?: boolean;
}

export type CaptchaOutcome =
  /** Browsa solved it and the page no longer shows the check. */
  | { status: "solved"; kind?: string; seconds: number }
  /** Browsa tried and failed (or timed out, or the check is still shown): hand off. */
  | { status: "failed"; kind?: string; reason: string; seconds: number }
  /** Browsa does not handle this check (unknown command, no solver, a kind it does not solve): use OSA's own code. */
  | { status: "unsupported"; reason: string }
  /** Not on Browsa: nothing was asked. */
  | { status: "skipped" };

/** Reasons that mean "Browsa does not handle this one": fall back to OSA's own code. */
const UNSUPPORTED = new Set(["not_supported", "no_widget", "other_puzzle", "captcha_unavailable", "not_entitled", "captcha_limit", "unknown_command"]);

/** Default wait for one solve (a press-and-hold takes about 30 to 80 s). Then the page is checked again. */
export const CAPTCHA_TIMEOUT_MS = 120_000;

const KIND_WORDS: Record<string, string> = {
  press_hold: "a press-and-hold check", recaptcha: "a reCAPTCHA", hcaptcha: "an hCaptcha", geetest: "a GeeTest puzzle",
  awswaf: "an AWS WAF captcha", image_text: "a text captcha", arkose: "an Arkose puzzle", cloudflare: "a Cloudflare check",
};

/** "a press-and-hold check", "a reCAPTCHA"; `fallback` when the kind is unknown. */
export function captchaWords(kind: string | undefined, fallback = "a bot check"): string {
  return (kind && KIND_WORDS[kind]) || fallback;
}

/** True on a browser where Browsa solves captchas (Phantom on Browsa leaves capabilities unset). */
export function solvesInSession(ctx: StoreContext): boolean {
  return !ctx.capabilities || ctx.capabilities.captchaSolving;
}

/**
 * Send Browsa.solveCaptcha on one CDP session and map the answer. Never throws: an unknown
 * command is "unsupported", a dropped socket "failed", no answer in time "timeout".
 */
export async function askBrowsa(
  session: CdpLike, targetId: string | undefined, o: { timeoutMs?: number; log?: (m: string) => void } = {},
): Promise<{ reply?: CaptchaReply; error?: "unknown_command" | "timeout" | "socket"; detail?: string }> {
  const solving = (p: Record<string, unknown>) => o.log?.(`Browsa is solving ${captchaWords(typeof p?.kind === "string" ? p.kind : undefined, "the check")}`);
  session.on?.("Browsa.captchaSolving", solving);
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), o.timeoutMs ?? CAPTCHA_TIMEOUT_MS); });
    const sent = session.send("Browsa.solveCaptcha", targetId ? { targetId } : {}).then(
      (v) => ({ v }),
      (e: unknown) => ({ e }),
    );
    const r = await Promise.race([sent, timeout]);
    if (r === "timeout") return { error: "timeout" };
    if ("e" in r) {
      const msg = String((r.e as Error)?.message ?? r.e);
      // Chrome's own answer to a domain it does not have: "'Browsa.solveCaptcha' wasn't found" (-32601).
      if (/-32601|wasn.t found|not found|unknown method|method not found/i.test(msg)) return { error: "unknown_command", detail: msg };
      return { error: "socket", detail: msg };
    }
    const v = (r.v ?? {}) as CaptchaReply;
    return { reply: { ...v, solved: v.solved === true } };
  } finally {
    if (timer) clearTimeout(timer);
    session.off?.("Browsa.captchaSolving", solving);
  }
}

/** Open a raw CDP session on the store's page and read its target id. */
async function openSession(ctx: StoreContext): Promise<{ session: CdpLike; targetId?: string } | undefined> {
  const page = ctx.page as unknown as { context?: () => { newCDPSession?: (p: unknown) => Promise<CdpLike> } };
  const bctx = typeof page.context === "function" ? page.context() : undefined;
  if (!bctx || typeof bctx.newCDPSession !== "function") return undefined;
  const session = await bctx.newCDPSession(ctx.page);
  const info = await session.send("Target.getTargetInfo").catch(() => undefined) as { targetInfo?: { targetId?: string } } | undefined;
  return { session, targetId: info?.targetInfo?.targetId };
}

/**
 * Ask Browsa to solve the check on the store's page, then look at the page again. Writes one
 * plain line to the run's notes ("Target showed a press-and-hold check; Browsa solved it in 9 s").
 * Never throws; the caller acts on the outcome.
 */
export async function solveWithBrowsa(
  ctx: StoreContext,
  o: { store: string; isBlocked: () => Promise<boolean>; check?: string; timeoutMs?: number; recheckMs?: number },
): Promise<CaptchaOutcome> {
  if (!solvesInSession(ctx)) return { status: "skipped" };
  let opened: Awaited<ReturnType<typeof openSession>>;
  try { opened = await openSession(ctx); } catch (e) { opened = undefined; ctx.log(`${o.store}: no CDP session for Browsa's solver (${(e as Error).message.split("\n")[0]})`); }
  if (!opened) return { status: "unsupported", reason: "no_session" };
  const t0 = Date.now();
  const secs = () => Math.max(1, Math.round((Date.now() - t0) / 1000));
  const shown = (kind?: string) => `${o.store} showed ${captchaWords(kind, o.check)}`;
  try {
    const r = await askBrowsa(opened.session, opened.targetId, { timeoutMs: o.timeoutMs, log: ctx.log });
    if (r.error === "unknown_command") {
      ctx.log(`${shown()}; this browser has no in-session solver, using OSA's own steps`);
      return { status: "unsupported", reason: "unknown_command" };
    }
    if (r.error === "socket") {
      ctx.log(`${shown()}; asking Browsa to solve it failed (${(r.detail ?? "").slice(0, 120)})`);
      return { status: "failed", reason: "socket", seconds: secs() };
    }
    if (r.error === "timeout") {
      if (!(await stillBlocked(ctx, o.isBlocked, 0))) {
        ctx.log(`${shown()}; it cleared after ${secs()} s`);
        return { status: "solved", seconds: secs() };
      }
      ctx.log(`${shown()}; Browsa did not solve it in ${secs()} s`);
      return { status: "failed", reason: "timeout", seconds: secs() };
    }
    const reply = r.reply!;
    const took = typeof reply.seconds === "number" && reply.seconds > 0 ? Math.round(reply.seconds) : secs();
    if (reply.solved) {
      if (await stillBlocked(ctx, o.isBlocked, o.recheckMs ?? 15_000)) {
        ctx.log(`${shown(reply.kind)}; Browsa reported it solved in ${took} s, but the page still shows it`);
        return { status: "failed", kind: reply.kind, reason: "still_shown", seconds: took };
      }
      ctx.log(`${shown(reply.kind)}; Browsa solved it in ${took} s`);
      return { status: "solved", kind: reply.kind, seconds: took };
    }
    const reason = reply.reason || "failed";
    if (UNSUPPORTED.has(reason)) {
      ctx.log(`${shown(reply.kind)}; Browsa does not solve this one (${reply.message ?? reason}), using OSA's own steps`);
      return { status: "unsupported", reason };
    }
    ctx.log(`${shown(reply.kind)}; Browsa could not solve it (${reply.message ?? reason})`);
    return { status: "failed", kind: reply.kind, reason, seconds: took };
  } finally {
    await opened.session.detach?.().catch(() => {});
  }
}

/** Poll the page for up to `ms` (PerimeterX reloads the page after a pass); true when the check stays. */
async function stillBlocked(ctx: StoreContext, isBlocked: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (!(await isBlocked().catch(() => true))) return false;
    if (Date.now() >= until || ctx.signal.aborted) return true;
    await ctx.page.waitForTimeout(1000).catch(() => {});
  }
}
