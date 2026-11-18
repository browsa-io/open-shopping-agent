import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalFor, approvalProblem, balanceOf, CreditMeter, defaultLimits, effectiveBudget, forbiddenLines, LimitError, resolveLimits,
  type ApprovalCheck,
} from "../../src/core/limits.js";
import type { CheckoutReview, Limits } from "../../src/core/types.js";
import { usd } from "./fake-adapter.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const review = (extra: Partial<CheckoutReview> = {}): CheckoutReview => ({
  store: "amazon", storeDomain: "amazon.com", lines: [{ title: "USB-C Hub", quantity: 1, price: usd(30) }],
  total: usd(32.4), reviewedAt: new Date(NOW.getTime() - 60_000).toISOString(), ...extra,
});
const check = (extra: Partial<ApprovalCheck> = {}): ApprovalCheck => {
  const r = extra.review === undefined && !("review" in extra) ? review() : extra.review;
  return {
    store: "amazon", review: r, approval: r ? approvalFor(r, NOW) : undefined, limits: defaultLimits(),
    placed: undefined, ordered: new Set(), now: NOW, ...extra,
  };
};

test("defaults are the safe ones and cannot be turned off", () => {
  const d = defaultLimits();
  assert.equal(d.requireApproval, true);
  assert.equal(d.allowSubscriptions, false);
  assert.equal(d.allowMembershipOffers, false);
  assert.equal(d.maxCreditsPerRun, 40);
  assert.throws(() => resolveLimits({ requireApproval: false } as unknown as Partial<Limits>), LimitError);
  assert.throws(() => resolveLimits({ allowSubscriptions: true } as unknown as Partial<Limits>), LimitError);
  assert.throws(() => resolveLimits({ allowMembershipOffers: true } as unknown as Partial<Limits>), LimitError);
  assert.deepEqual(resolveLimits({ allowedStores: ["amazon", "nope" as never] }).allowedStores, ["amazon"]);
  assert.equal(resolveLimits({ maxCreditsPerRun: -3 }).maxCreditsPerRun, 40);
});

test("effectiveBudget takes the tighter one", () => {
  assert.deepEqual(effectiveBudget({ ...defaultLimits(), budget: usd(100) }, { prompt: "", items: [], stores: [], budget: usd(80) }), usd(80));
  assert.deepEqual(effectiveBudget({ ...defaultLimits(), budget: usd(60) }, { prompt: "", items: [], stores: [], budget: usd(80) }), usd(60));
  assert.equal(effectiveBudget(defaultLimits()), undefined);
});

test("approval gate: an exact approval of a fresh review passes", () => {
  assert.equal(approvalProblem(check()), undefined);
});

test("approval gate: refuses every mismatch", () => {
  const r = review();
  const a = approvalFor(r, NOW);
  const cases: [string, Partial<ApprovalCheck>, RegExp][] = [
    ["no approval", { approval: undefined }, /no approval/],
    ["one cent less", { approval: { ...a, approvedTotal: { cents: r.total.cents - 1, currency: "USD" } } }, /does not match/],
    ["one cent more", { approval: { ...a, approvedTotal: { cents: r.total.cents + 1, currency: "USD" } } }, /does not match/],
    ["other currency", { approval: { ...a, approvedTotal: { cents: r.total.cents, currency: "EUR" } } }, /does not match/],
    ["other store", { approval: { ...a, store: "walmart" } }, /for walmart/],
    ["not the user", { approval: { ...a, by: "agent" as "user" } }, /from the user/],
    ["no review", { review: undefined, approval: a }, /no checkout review/],
    ["needs user", { review: { ...r, needsUser: { reason: "sign_in", message: "sign in" } } }, /needs the person/],
    ["old review", { review: { ...r, reviewedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString() } }, /too old/],
    ["approved before review", { approval: { ...a, approvedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() } }, /before this review/],
    ["already ordered", { ordered: new Set(["amazon"]) }, /already placed/],
    ["store not allowed", { limits: { ...defaultLimits(), allowedStores: ["walmart"] } }, /not an allowed store/],
    ["over budget", { budget: usd(30) }, /over the \$30\.00 budget/],
    ["over budget with earlier orders", { budget: usd(50), placed: usd(20) }, /over the \$50\.00 budget/],
    ["approval off", { limits: { ...defaultLimits(), requireApproval: false as true } }, /requireApproval/],
    ["zero total", { review: { ...r, total: usd(0) }, approval: { ...a, approvedTotal: usd(0) } }, /zero/],
  ];
  for (const [name, extra, re] of cases) {
    const p = approvalProblem(check(extra));
    assert.ok(p && re.test(p), `${name}: got ${p}`);
  }
});

test("approval gate: membership and subscription lines block the order", () => {
  for (const title of ["Amazon Prime free trial", "Walmart+ membership", "Coffee pods (Subscribe & Save)", "Shipping Pass"]) {
    const r = review({ lines: [...review().lines, { title, quantity: 1, price: usd(0) }] });
    const p = approvalProblem(check({ review: r, approval: approvalFor(r, NOW) }));
    assert.ok(p && /(membership|subscription) line/.test(p), `${title}: ${p}`);
  }
  assert.deepEqual(forbiddenLines([{ title: "Prime Hydration drink 12 pack", quantity: 1, price: usd(20) }, { title: "Industrial fan", quantity: 1, price: usd(50) }]), []);
});

test("credit meter: measured from the balance, refuses over the cap, caps AI tasks", async () => {
  let balance = 100;
  const m = new CreditMeter(async () => ({ balance }), 40);
  await m.begin();
  assert.equal(await m.spend(5, "browser"), 5);
  balance -= 5;
  balance -= 20;
  assert.equal(await m.used(), 25);
  assert.equal(await m.spend(15, "AI task"), 15);
  balance -= 15;
  await assert.rejects(m.spend(1, "another browser"), (e: unknown) => e instanceof LimitError && e.code === "credits");
});

test("credit meter: estimates when the balance cannot be read", async () => {
  const m = new CreditMeter(async () => { throw new Error("offline"); }, 10);
  await m.begin();
  await m.spend(5, "a");
  await m.spend(5, "b");
  await assert.rejects(m.spend(1, "c"), LimitError);
  assert.equal(await m.used(), 10);
  assert.equal(balanceOf({ balance: "12" }), 12);
  assert.equal(balanceOf({ credits: 7 }), 7);
  assert.equal(balanceOf({}), undefined);
});
