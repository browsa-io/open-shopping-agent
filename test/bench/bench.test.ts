import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cart, CheckoutReview, Offer, StoreId } from "../../src/core/types.js";
import type { StoreAdapter, StoreContext } from "../../src/stores/adapter.js";
import {
  judgeSearch, judgeDetails, judgeCart, judgeCheckout, pickForCart, lineMatches, loadTasks, validateTasks,
  renderTable, replaceBetweenMarkers, mergeResults, summarize, BENCH_START, BENCH_END, type BenchResults, type TaskFile,
} from "../../bench/lib.js";
import { defaultLoader } from "../../bench/adapters.js";
import { runBench, guard } from "../../bench/run.js";
import type { ContextFactory } from "../../bench/browser.js";

const here = dirname(fileURLToPath(import.meta.url));

const offer = (i: number, extra: Partial<Offer> = {}): Offer => ({
  store: "walmart", storeDomain: "walmart.com", itemId: "item-1", title: `Duracell AA Batteries ${i} pack`,
  url: `https://www.walmart.com/ip/${i}`, productId: String(i), price: { cents: 999 + i, currency: "USD" },
  rating: { stars: 4.5, count: 100 }, inStock: true, condition: "new", ...extra,
});

const cart = (lines: Cart["lines"], warnings: string[] = []): Cart => ({ store: "walmart", storeDomain: "walmart.com", lines, readAt: "", warnings });

test("tasks.json is valid and has about 10 tasks per store", async () => {
  const f = await loadTasks(join(here, "..", "..", "bench", "tasks.json"));
  assert.deepEqual(f.stores.map((s) => s.store), ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"]);
  for (const s of f.stores) {
    assert.ok(s.tasks.length >= 8 && s.tasks.length <= 12, `${s.store} has ${s.tasks.length} tasks`);
    assert.ok(s.tasks.some((t) => t.stages.includes("checkout")), `${s.store} reaches checkout`);
    if (s.store === "shopify") for (const t of s.tasks) assert.ok(t.domain, `${t.id} needs a shop domain`);
  }
});

test("validateTasks rejects bad files", () => {
  const ok = { version: 1, stores: [{ store: "walmart", domain: "walmart.com", tasks: [{ id: "a", query: "q", stages: ["search"] }] }] };
  assert.doesNotThrow(() => validateTasks(ok));
  assert.throws(() => validateTasks({ version: 2, stores: [] }), /version: 1/);
  assert.throws(() => validateTasks({ ...ok, stores: [{ ...ok.stores[0], store: "costco" }] }), /unknown store/);
  assert.throws(() => validateTasks({ ...ok, stores: [{ ...ok.stores[0], tasks: [{ id: "a", query: "q", stages: ["cart"] }] }] }), /start with the search/);
  assert.throws(() => validateTasks({ ...ok, stores: [{ ...ok.stores[0], tasks: [{ id: "a", query: "q", stages: ["search", "checkout"] }] }] }), /checkout needs the cart/);
  assert.throws(() => validateTasks({ ...ok, stores: [{ ...ok.stores[0], tasks: [ok.stores[0].tasks[0], ok.stores[0].tasks[0]] }] }), /repeated/);
});

test("judgeSearch counts offers, prices, ratings and relevance", () => {
  const five = [1, 2, 3, 4, 5].map((i) => offer(i));
  assert.equal(judgeSearch(five, { minOffers: 5, minRated: 3, titleAny: ["batter"] }).pass, true);
  const r = judgeSearch(five.slice(0, 3), { minOffers: 5 });
  assert.equal(r.pass, false);
  assert.match(r.note!, /3 offers, want 5/);
  assert.match(judgeSearch(five.map((o) => ({ ...o, rating: undefined })), { minRated: 3 }).note!, /0 with a rating/);
  assert.match(judgeSearch(five, { titleAny: ["monitor"] }).note!, /0 relevant titles/);
});

test("pickForCart skips sponsored, used, subscription and out-of-stock offers", () => {
  const list = [offer(1, { inStock: false }), offer(2, { sponsored: true }), offer(3, { condition: "used" }), offer(4, { subscription: true }), offer(5)];
  assert.equal(pickForCart(list)?.productId, "5");
  assert.equal(pickForCart([offer(2, { sponsored: true })])?.productId, "2", "sponsored only when nothing else");
  assert.equal(pickForCart([offer(1, { inStock: false })]), undefined);
});

test("judgeDetails, lineMatches, judgeCart and judgeCheckout", () => {
  const o = offer(7);
  assert.equal(judgeDetails(o, o).pass, true);
  assert.match(judgeDetails(o, { ...o, price: { cents: 0, currency: "USD" } }).note!, /no price/);
  assert.match(judgeDetails(o, o, true).note!, /no shipping or delivery/);
  assert.equal(judgeDetails(o, { ...o, deliveryText: "Arrives Thu" }, true).pass, true);

  assert.equal(lineMatches(o, { title: "anything", productId: "7" }), true);
  assert.equal(lineMatches(o, { title: "Duracell AA Batteries, 7 Pack" }), true);
  assert.equal(lineMatches(o, { title: "Paper towels" }), false);

  const line = { title: o.title, quantity: 1, price: o.price, productId: "7" };
  assert.equal(judgeCart(o, cart([line]), cart([line])).pass, true);
  assert.match(judgeCart(o, cart([]), cart([line])).note!, /not in the cart after adding/);
  assert.match(judgeCart(o, cart([line]), cart([])).note!, /read back/);

  const review = (x: Partial<CheckoutReview>): CheckoutReview => ({ store: "walmart", storeDomain: "walmart.com", lines: [], total: { cents: 0, currency: "USD" }, reviewedAt: "", ...x });
  assert.deepEqual(judgeCheckout(review({ needsUser: { reason: "sign_in", message: "Sign in or continue as guest" } })), { pass: true, note: "sign-in or guest page" });
  assert.equal(judgeCheckout(review({ total: { cents: 1299, currency: "USD" } })).pass, true);
  assert.equal(judgeCheckout(review({ needsUser: { reason: "captcha_handoff", message: "" } })).pass, false);
  assert.equal(judgeCheckout(review({})).pass, false);
});

test("renderTable says pending first run before any results, and never invents numbers", () => {
  const t = renderTable();
  assert.equal(t.split("\n").filter((l) => l.includes("pending first run")).length, 6);
  assert.ok(!/\d+%/.test(t));
  const readme = `# x\n${BENCH_START}\nold\n${BENCH_END}\nrest\n`;
  const next = replaceBetweenMarkers(readme, t);
  assert.ok(next.startsWith(`# x\n${BENCH_START}\n| Store |`));
  assert.ok(next.endsWith(`${BENCH_END}\nrest\n`));
  assert.equal(replaceBetweenMarkers(next, t), next, "idempotent");
  assert.throws(() => replaceBetweenMarkers("no markers", t), /missing/);
});

test("the README has the bench markers", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(join(here, "..", "..", "README.md"), "utf8");
  assert.doesNotThrow(() => replaceBetweenMarkers(text, renderTable()));
});

// ---- full runs with a fake adapter and a fake browser -------------------------------------------

function fakeAdapter(store: StoreId, calls: string[]): StoreAdapter {
  const lines: Cart["lines"] = [];
  const mk = () => cart([...lines]);
  return {
    id: store, name: "Fake", domains: ["walmart.com"],
    searchUrl: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
    async search(ctx, item) { calls.push(`search:${ctx.domain}:${item.query}`); return [1, 2, 3, 4, 5].map((i) => offer(i)); },
    async details(_ctx, o) { calls.push("details"); return { ...o, deliveryText: "Arrives Thu" }; },
    async addToCart(_ctx, o, q) { calls.push("addToCart"); lines.push({ title: o.title, quantity: q, price: o.price, productId: o.productId }); return mk(); },
    async readCart() { calls.push("readCart"); return mk(); },
    async clearCart() { calls.push("clearCart"); lines.length = 0; },
    async reviewCheckout() { calls.push("reviewCheckout"); return { store, storeDomain: "walmart.com", lines: [], total: { cents: 0, currency: "USD" }, reviewedAt: "", needsUser: { reason: "sign_in", message: "Sign in" } }; },
    async placeOrder() { calls.push("placeOrder"); return { store, placed: true }; },
  };
}

const fakeFactory = (opened: string[], closed: string[]): ContextFactory => async (store, domain) => {
  opened.push(store);
  const ctx = { store, domain, page: {} as never, agentId: "agent-1", aiTask: async () => { throw new Error("no ai"); },
    liveLink: async () => { throw new Error("no live"); }, newPage: async () => { throw new Error("no page"); }, log: () => undefined, signal: new AbortController().signal } as StoreContext;
  return { ctx, close: async () => { closed.push(store); } };
};

const smallTasks: TaskFile = validateTasks({
  version: 1, stores: [
    { store: "walmart", domain: "walmart.com", tasks: [
      { id: "w1", query: "AA batteries", stages: ["search", "details", "cart", "checkout"], expect: { minOffers: 5, minRated: 3, titleAny: ["batter"] } },
      { id: "w2", query: "dish soap", stages: ["search"], expect: { minOffers: 6 } },
    ] },
    { store: "amazon", domain: "amazon.com", tasks: [{ id: "a1", query: "x", stages: ["search"] }] },
  ],
});

test("runBench runs stages, skips missing adapters, closes browsers and never places an order", async () => {
  const calls: string[] = [], opened: string[] = [], closed: string[] = [];
  const results = await runBench({
    tasks: smallTasks,
    loader: async (s) => (s === "walmart" ? fakeAdapter(s, calls) : undefined),
    factory: fakeFactory(opened, closed),
  });
  const w = results.stores.find((s) => s.store === "walmart")!;
  const a = results.stores.find((s) => s.store === "amazon")!;
  assert.equal(w.status, "ran");
  assert.equal(a.status, "not_installed");
  assert.deepEqual(opened, ["walmart"]);
  assert.deepEqual(closed, ["walmart"]);
  assert.ok(!calls.includes("placeOrder"));
  assert.deepEqual(calls, ["search:walmart.com:AA batteries", "details", "addToCart", "readCart", "reviewCheckout", "clearCart", "search:walmart.com:dish soap"]);
  const [w1, w2] = w.tasks;
  assert.equal(w1.stages.search?.pass, true);
  assert.equal(w1.stages.details?.pass, true);
  assert.equal(w1.stages.cart?.pass, true);
  assert.deepEqual({ pass: w1.stages.checkout?.pass, note: w1.stages.checkout?.note }, { pass: true, note: "sign-in or guest page" });
  assert.equal(w2.stages.search?.pass, false);
  assert.deepEqual(summarize(w).search, { pass: 1, total: 2 });

  const table = renderTable(results);
  assert.match(table, /\| Walmart \| 50% \(1\/2\) \| 100% \(1\/1\) \| 100% \(1\/1\) \| 100% \(1\/1\) \|/);
  assert.match(table, /\| Amazon \| not installed \|/);
  assert.match(table, /\| Target \| pending first run \|/);
});

test("guard blocks placeOrder", async () => {
  const g = guard(fakeAdapter("walmart", []));
  await assert.rejects(g.placeOrder({} as never, {} as never), /blocked in the bench/);
});

test("runBench dry run loads adapters but opens no browser; failures in a stage are recorded", async () => {
  const dry = await runBench({ tasks: smallTasks, loader: async (s) => (s === "walmart" ? fakeAdapter(s, []) : undefined) });
  assert.deepEqual(dry.stores.map((s) => [s.store, s.status, s.note]), [["walmart", "skipped", "dry run"], ["amazon", "not_installed", "not installed"]]);

  const broken = fakeAdapter("walmart", []);
  broken.search = async () => { throw new Error("selector not found\nstack"); };
  const r = await runBench({ tasks: smallTasks, stores: ["walmart"], loader: async () => broken, factory: fakeFactory([], []) });
  const w1 = r.stores[0].tasks[0];
  assert.deepEqual(w1.stages.search, { pass: false, ms: w1.stages.search!.ms, note: "selector not found" });
  assert.equal(w1.stages.cart?.note, "no in-stock offer to add");
  assert.equal(w1.stages.checkout?.note, "the cart stage did not pass");
  assert.equal(r.stores[1].note, "not selected");
});

test("runBench stops at the credit cap", async () => {
  let balance = 100;
  const adapter = fakeAdapter("walmart", []);
  const search = adapter.search;
  adapter.search = async (...args) => { balance -= 6; return search(...args); };
  const r = await runBench({
    tasks: smallTasks, maxCredits: 5, credits: async () => balance,
    loader: async (s) => (s === "walmart" ? adapter : fakeAdapter(s, [])), factory: fakeFactory([], []),
  });
  assert.equal(r.stores[0].tasks.length, 1, "second task not run after the cap");
  assert.equal(r.creditsUsed, 6);
  assert.equal(r.stores[0].credits, 6);
  assert.match(r.stopped!, /credit cap/);
  assert.equal(r.stores[1].status, "skipped");
});

test("mergeResults keeps earlier stores for a partial run", () => {
  const prev: BenchResults = { date: "2026-11-17", startedAt: "", finishedAt: "", stores: [{ store: "amazon", status: "ran", tasks: [], ms: 0 }] };
  const cur: BenchResults = { date: "2026-11-18", startedAt: "", finishedAt: "", stores: [{ store: "amazon", status: "skipped", note: "not selected", tasks: [], ms: 0 }, { store: "walmart", status: "ran", tasks: [], ms: 0, date: "2026-11-18" }] };
  const m = mergeResults(prev, cur);
  assert.equal(m.stores[0].status, "ran");
  assert.equal(m.stores[0].date, "2026-11-17");
  assert.equal(m.stores[1].date, "2026-11-18");
});

test("defaultLoader finds adapters in index.ts or in the store file, and reports missing ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "osa-stores-"));
  const a = await mkdtemp(join(tmpdir(), "osa-stores-"));
  await mkdir(dir, { recursive: true });
  const body = (id: string) => `export default { id: "${id}", name: "X", domains: [], searchUrl: () => "", search: async () => [], addToCart: async () => ({}), readCart: async () => ({}), reviewCheckout: async () => ({}), placeOrder: async () => ({}) };\n`;
  await writeFile(join(dir, "ebay.js"), body("ebay"));
  await writeFile(join(a, "index.js"), `const target = ${body("target").replace("export default ", "").trim().replace(/;$/, "")};\nexport async function loadAdapter(id) { return id === "target" ? target : undefined; }\n`);

  const fromFile = defaultLoader(dir);
  assert.equal((await fromFile("ebay"))?.id, "ebay");
  assert.equal(await fromFile("amazon"), undefined);

  const fromIndex = defaultLoader(a);
  assert.equal((await fromIndex("target"))?.id, "target");
  assert.equal(await fromIndex("walmart"), undefined);
});
