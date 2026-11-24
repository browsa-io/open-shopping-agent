// Captchas solved by Browsa in the session (src/stores/captcha.ts), offline with a fake CDP session:
// solved, failed then hand-off, unsupported then OSA's own steps, timeout, and nothing asked off Browsa.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { StoreContext } from "../../src/stores/adapter.js";
import type { Offer, RunEvent, StoreId } from "../../src/core/types.js";
import type { BrowserCapabilities } from "../../src/core/providers/types.js";
import { BROWSA_CAPABILITIES, isBotBlock } from "../../src/core/providers/index.js";
import { ShoppingAgent } from "../../src/core/engine.js";
import { askBrowsa, solveWithBrowsa } from "../../src/stores/captcha.js";
import { BotCheckError, CaptchaHandoffError, passBotCheck, passPressAndHold } from "../../src/stores/util.js";
import { FakeAdapter } from "../core/fake-adapter.js";

type Handler = (p: Record<string, unknown>) => void;

/** A fake Playwright CDPSession: answers Target.getTargetInfo and Browsa.solveCaptcha as told. */
function fakeSession(answer: () => Promise<unknown>) {
  const handlers = new Map<string, Handler[]>();
  const s = {
    sent: [] as { method: string; params?: Record<string, unknown> }[],
    detached: 0,
    on(event: string, fn: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return s; },
    off(event: string, fn: Handler) { handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn)); return s; },
    emit(event: string, p: Record<string, unknown>) { for (const f of handlers.get(event) ?? []) f(p); },
    async send(method: string, params?: Record<string, unknown>) {
      s.sent.push({ method, params });
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "TARGET-1", type: "page" } };
      if (method === "Browsa.solveCaptcha") {
        s.emit("Browsa.captchaSolving", {});
        return answer();
      }
      throw new Error(`unexpected ${method}`);
    },
    async detach() { s.detached++; },
  };
  return s;
}

/** A fake page with a press-and-hold box (#px-captcha) that is shown while `blocked.on`. */
function fakePage(session: ReturnType<typeof fakeSession> | undefined, blocked: { on: boolean; fallback?: boolean }) {
  const mouse = { downs: 0, ups: 0, reloads: 0 };
  // HUMAN's "check your internet connection" page (its script did not load): shown while blocked.fallback
  const fb = {
    count: async () => (blocked.fallback ? 1 : 0),
    first: () => fb,
    isVisible: async () => !!blocked.fallback,
    boundingBox: async () => null,
    waitFor: async () => {},
  };
  const box = {
    count: async () => (blocked.on ? 1 : 0),
    first: () => box,
    isVisible: async () => blocked.on,
    boundingBox: async () => (blocked.on ? { x: 10, y: 10, width: 100, height: 40 } : null),
    waitFor: async () => {},
  };
  const page = {
    mouse: {
      move: async () => {},
      down: async () => { mouse.downs++; blocked.on = false; }, // OSA's own hold clears it
      up: async () => { mouse.ups++; },
    },
    locator: (sel: string) => (sel.startsWith("text=") ? fb : box),
    url: () => "https://www.target.com/",
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    reload: async () => { mouse.reloads++; if (blocked.fallback) { blocked.fallback = false; blocked.on = true; } return null; },
    context: () => ({ newCDPSession: async () => { if (!session) throw new Error("no CDP"); return session; } }),
  };
  return { page: page as unknown as Page, mouse };
}

function ctxOn(page: Page, capabilities?: BrowserCapabilities): StoreContext & { logs: string[]; links: number } {
  const c = {
    store: "target" as StoreId, domain: "target.com", page, agentId: "agt_1", signal: new AbortController().signal,
    logs: [] as string[], links: 0,
    log: (m: string) => { c.logs.push(m); },
    aiTask: async () => { throw new Error("no AI here"); },
    liveLink: async () => { c.links++; return "https://browsa.io/live#once"; },
    newPage: async () => page,
    ...(capabilities ? { capabilities } : {}),
  };
  return c as unknown as StoreContext & { logs: string[]; links: number };
}

test("captcha: Browsa solves the check in the session; the run's notes say so in plain words", async () => {
  const blocked = { on: true };
  const session = fakeSession(async () => { blocked.on = false; return { solved: true, kind: "press_hold", rounds: 1, seconds: 9.2, puzzle: false }; });
  const { page, mouse } = fakePage(session, blocked);
  const ctx = ctxOn(page);
  assert.equal(await passPressAndHold(ctx, { name: "Target" }), true);
  const ask = session.sent.find((x) => x.method === "Browsa.solveCaptcha");
  assert.deepEqual(ask?.params, { targetId: "TARGET-1" }, "the page's own target");
  assert.equal(mouse.downs, 0, "OSA's own press and hold did not run");
  assert.ok(ctx.logs.includes("Target showed a press-and-hold check; Browsa solved it in 9 s"), ctx.logs.join(" | "));
  assert.ok(ctx.logs.some((l) => /Browsa is solving/.test(l)));
  assert.equal(session.detached, 1);
  assert.equal(ctx.links, 0);
});

test("captcha: solved through passBotCheck (Walmart, Amazon) with no waiting loop", async () => {
  const blocked = { on: true };
  const session = fakeSession(async () => { blocked.on = false; return { solved: true, kind: "recaptcha", rounds: 2, seconds: 21 }; });
  const ctx = ctxOn(fakePage(session, blocked).page);
  await passBotCheck(ctx, "Walmart", async () => blocked.on);
  assert.ok(ctx.logs.includes("Walmart showed a reCAPTCHA; Browsa solved it in 21 s"));
  assert.ok(!ctx.logs.some((l) => /waiting for Phantom/.test(l)));
});

test("captcha: Browsa fails -> hand-off with a Phantom Live link (no own press and hold)", async () => {
  const blocked = { on: true };
  const session = fakeSession(async () => ({ solved: false, kind: "press_hold", reason: "rounds", message: "the answers were not accepted", rounds: 3, seconds: 40 }));
  const { page, mouse } = fakePage(session, blocked);
  const ctx = ctxOn(page);
  const err = await passPressAndHold(ctx, { name: "Target" }).catch((e) => e);
  assert.ok(err instanceof CaptchaHandoffError);
  assert.ok(err instanceof BotCheckError);
  assert.ok(isBotBlock(err));
  assert.equal(err.handoff.reason, "captcha_handoff");
  assert.equal(err.handoff.liveUrl, "https://browsa.io/live#once");
  assert.match(err.handoff.message, /^Target shows a press-and-hold check that Browsa could not solve/);
  assert.equal(mouse.downs, 0);
  assert.ok(ctx.logs.includes("Target showed a press-and-hold check; Browsa could not solve it (the answers were not accepted)"));
  assert.ok(ctx.logs.some((l) => /handing the check to you in Phantom Live/.test(l)));
});

test("captcha: press-and-hold failure reasons (not_cleared, no_button, refused, timeout) all hand off", async () => {
  for (const reason of ["not_cleared", "no_button", "refused", "timeout"]) {
    const blocked = { on: true };
    const session = fakeSession(async () => ({ solved: false, kind: "press_hold", reason, rounds: 2, seconds: 61 }));
    const { page, mouse } = fakePage(session, blocked);
    const err = await passPressAndHold(ctxOn(page), { name: "Walmart" }).catch((e) => e);
    assert.ok(err instanceof CaptchaHandoffError, reason);
    assert.equal(mouse.downs, 0, reason);
  }
});

test("captcha: Browsa says solved but the page still shows the check -> hand-off", async () => {
  const blocked = { on: true };
  const session = fakeSession(async () => ({ solved: true, kind: "press_hold", seconds: 5 }));
  const ctx = ctxOn(fakePage(session, blocked).page);
  const r = await solveWithBrowsa(ctx, { store: "Target", isBlocked: async () => blocked.on, recheckMs: 0 });
  assert.equal(r.status, "failed");
  assert.equal(r.status === "failed" && r.reason, "still_shown");
});

test("captcha: an unknown command (-32601) falls back to OSA's own press and hold", async () => {
  const blocked = { on: true };
  const session = fakeSession(async () => { throw new Error("Protocol error (Browsa.solveCaptcha): 'Browsa.solveCaptcha' wasn't found"); });
  const { page, mouse } = fakePage(session, blocked);
  const ctx = ctxOn(page);
  assert.equal(await passPressAndHold(ctx, { name: "Target" }), true);
  assert.equal(mouse.downs, 1, "OSA held it itself");
  assert.equal(blocked.on, false);
  assert.ok(ctx.logs.some((l) => /no in-session solver, using OSA's own steps/.test(l)));
});

test("captcha: a reply that says not supported (no_widget, not_supported) falls back too", async () => {
  for (const reason of ["no_widget", "not_supported", "captcha_unavailable"]) {
    const blocked = { on: true };
    const session = fakeSession(async () => ({ solved: false, kind: "", reason, rounds: 0, seconds: 0.4 }));
    const { page, mouse } = fakePage(session, blocked);
    const ctx = ctxOn(page);
    assert.equal(await passPressAndHold(ctx, { name: "Target" }), true, reason);
    assert.equal(mouse.downs, 1, reason);
    assert.ok(ctx.logs.some((l) => /Browsa does not solve this one/.test(l)), reason);
  }
  // passBotCheck: the old wait-for-Phantom loop runs after an unsupported reply.
  let checks = 0;
  const session = fakeSession(async () => ({ solved: false, reason: "no_widget" }));
  const ctx = ctxOn(fakePage(session, { on: true }).page);
  await passBotCheck(ctx, "Amazon", async () => ++checks < 3);
  assert.ok(ctx.logs.some((l) => /waiting for Phantom to pass it/.test(l)));
  assert.ok(ctx.logs.includes("Amazon: bot check passed"));
});

test("captcha: no answer in time -> re-check the page; still shown is a hand-off, cleared is solved", async () => {
  const never = () => new Promise<unknown>(() => {});
  // still shown after the timeout
  const blocked = { on: true };
  const ctx = ctxOn(fakePage(fakeSession(never), blocked).page);
  const err = await passPressAndHold(ctx, { name: "Target", timeoutMs: 20 }).catch((e) => e);
  assert.ok(err instanceof CaptchaHandoffError, String(err));
  assert.ok(ctx.logs.some((l) => /^Target showed a press-and-hold check; Browsa did not solve it in \d+ s$/.test(l)), ctx.logs.join(" | "));
  // cleared while Browsa was still at it
  const gone = { on: true };
  const ctx2 = ctxOn(fakePage(fakeSession(never), gone).page);
  setTimeout(() => { gone.on = false; }, 5);
  const r = await solveWithBrowsa(ctx2, { store: "Target", isBlocked: async () => gone.on, timeoutMs: 30 });
  assert.equal(r.status, "solved");
});

test("captcha: askBrowsa maps a dropped socket to an error, not unknown_command", async () => {
  const r = await askBrowsa(fakeSession(async () => { throw new Error("Target page, context or browser has been closed"); }), "T", { timeoutMs: 1000 });
  assert.equal(r.error, "socket");
  const u = await askBrowsa(fakeSession(async () => { throw Object.assign(new Error("Method not found"), { code: -32601 }); }), "T", { timeoutMs: 1000 });
  assert.equal(u.error, "unknown_command");
});

test("captcha: on your Chrome or a CDP browser Browsa is never asked", async () => {
  const local: BrowserCapabilities = { liveLink: "window", aiFallback: false, captchaSolving: false, residentialExit: false, savedProfiles: false, fingerprint: "standard" };
  const blocked = { on: true };
  const session = fakeSession(async () => ({ solved: true }));
  const { page, mouse } = fakePage(session, blocked);
  const ctx = ctxOn(page, local);
  assert.equal(await passPressAndHold(ctx, { name: "Target" }), true);
  assert.equal(session.sent.length, 0);
  assert.equal(mouse.downs, 1, "the existing press and hold");
  const r = await solveWithBrowsa(ctx, { store: "Target", isBlocked: async () => true });
  assert.equal(r.status, "skipped");
});

test("captcha: a page without a CDP session (older test fakes) uses OSA's own steps quietly", async () => {
  const blocked = { on: true };
  const { page, mouse } = fakePage(undefined, blocked);
  const ctx = ctxOn(page, BROWSA_CAPABILITIES);
  assert.equal(await passPressAndHold(ctx, { name: "Target" }), true);
  assert.equal(mouse.downs, 1);
});

test("engine: a failed Browsa solve becomes needs_user (captcha_handoff) with the Phantom Live link", async () => {
  class HandoffAdapter extends FakeAdapter {
    async search(): Promise<Offer[]> {
      throw new CaptchaHandoffError("Target shows a press-and-hold check that Browsa could not solve. Solve it in the live browser, then retry.",
        { reason: "captcha_handoff", message: "Target shows a press-and-hold check that Browsa could not solve. Solve it in the live browser, then retry.", liveUrl: "https://browsa.io/live#once" });
    }
  }
  const page = fakePage(undefined, { on: false }).page;
  const provider = {
    id: "browsa" as const, label: "Phantom on Browsa", capabilities: BROWSA_CAPABILITIES,
    async open(store: StoreId) {
      return {
        store, agentId: "agt_1", mode: "burner" as const, page, provider: "browsa" as const, capabilities: BROWSA_CAPABILITIES,
        context: () => ctxOn(page), close: async () => {},
      };
    },
  };
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({ llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-cap-")), browser: provider, adapters: { target: new HandoffAdapter("target", { catalog: {} }) } });
  await agent.run("socks on target", { onEvent: (e) => events.push(e), until: "picks" });
  const nu = events.find((e) => e.type === "needs_user");
  assert.ok(nu && nu.type === "needs_user" && nu.needs.reason === "captcha_handoff" && nu.needs.liveUrl === "https://browsa.io/live#once");
  const f = events.find((e) => e.type === "store_failed");
  assert.ok(f && f.type === "store_failed" && !f.hint, "no 'use Browsa' hint on Browsa");
});

test("captcha: HUMAN's 'check your internet connection' page after a solve is not a pass (hand-off, not 'solved')", async () => {
  // Target 2026-11-24: Browsa answered solved while the page showed HUMAN's fallback (its script did not load)
  const blocked: { on: boolean; fallback?: boolean } = { on: true };
  const session = fakeSession(async () => { blocked.on = false; blocked.fallback = true; return { solved: true, kind: "press_hold", rounds: 1, seconds: 28 }; });
  const ctx = ctxOn(fakePage(session, blocked).page);
  const err = await passPressAndHold(ctx, { name: "Target", timeoutMs: 1000 }).catch((e) => e);
  assert.ok(err instanceof CaptchaHandoffError, String(err));
  assert.ok(!ctx.logs.some((l) => /Browsa solved it/.test(l)), ctx.logs.join(" | "));
  assert.ok(ctx.logs.some((l) => /reported it solved in 28 s, but the page still shows it/.test(l)), ctx.logs.join(" | "));
});

test("captcha: HUMAN's fallback page counts as a check, and OSA's own hold loads the page again first", async () => {
  const blocked: { on: boolean; fallback?: boolean } = { on: false, fallback: true };
  const { page, mouse } = fakePage(undefined, blocked);          // no Browsa session: OSA holds it itself
  const ctx = ctxOn(page);
  assert.equal(await passPressAndHold(ctx, { name: "Target" }), true);
  assert.equal(mouse.reloads, 1, "loaded again before the hold");
  assert.equal(mouse.downs, 1, "then held the check that came back");
  assert.ok(ctx.logs.some((l) => /did not load \("check your internet connection"\); loading the page again/.test(l)), ctx.logs.join(" | "));
});
