import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WatchStore, normalizeWatch, evaluate, evaluateFailure, checkWatch, runDueWatches, startWatching,
  createNotifiers, parseEvery, runWatchCli, storeFromUrl, MIN_INTERVAL_MINUTES, FAILING_AFTER,
  type Alert, type HistoryEntry, type Notifier, type NotifyChannel, type Watch,
} from "../../src/alerts/index.js";
import { offer, tempDir } from "./helpers.js";

function captureNotifiers(): { notifiers: Record<NotifyChannel, Notifier>; sent: Alert[] } {
  const sent: Alert[] = [];
  const n = (channel: NotifyChannel): Notifier => ({ channel, async send(a) { sent.push(a); } });
  return { notifiers: { desktop: n("desktop"), slack: n("slack"), webhook: n("webhook"), email: n("email") }, sent };
}

const baseWatch = (extra: Partial<Watch> = {}): Watch =>
  normalizeWatch({ query: "27 inch 4K monitor", stores: ["walmart"], targetPrice: 250, ...extra });

test("normalizeWatch fills defaults and validates", () => {
  const w = normalizeWatch({ query: "USB-C hub", targetPrice: 39.99 });
  assert.equal(w.id, "usb-c-hub");
  assert.deepEqual(w.targetPrice, { cents: 3999, currency: "USD" });
  assert.deepEqual(w.stores, ["amazon", "walmart", "ebay", "bestbuy", "target"]);
  assert.deepEqual(w.notify, [{ channel: "desktop" }]);
  assert.equal(w.intervalMinutes, 720);
  assert.equal(w.condition, "new");

  assert.throws(() => normalizeWatch({}), /query or a product url/);
  assert.throws(() => normalizeWatch({ query: "x", intervalMinutes: 30 }), /at least 360/);
  assert.throws(() => normalizeWatch({ query: "x", stores: ["nope" as never] }), /unknown store/);
  assert.throws(() => normalizeWatch({ query: "x", stores: ["shopify"] }), /shopifyDomains/);
  assert.throws(() => normalizeWatch({ query: "x", notify: "pager" as never }), /unknown notify channel/);
  assert.throws(() => normalizeWatch({ query: "x", targetPrice: -1 }), /more than 0/);

  const u = normalizeWatch({ url: "https://www.bestbuy.com/site/123.p", notify: ["slack", { channel: "email", to: "a@b.co" }] });
  assert.deepEqual(u.stores, ["bestbuy"]);
  assert.deepEqual(u.notify, [{ channel: "slack" }, { channel: "email", to: "a@b.co" }]);
  assert.equal(storeFromUrl("https://shop.example.com/products/x"), "shopify");
});

test("WatchStore adds, dedupes ids, updates, appends history and removes", async () => {
  const store = new WatchStore(await tempDir());
  assert.deepEqual(await store.list(), []);
  const a = await store.add({ query: "air fryer", stores: ["target"] });
  const b = await store.add({ query: "air fryer", stores: ["walmart"] });
  assert.equal(a.id, "air-fryer");
  assert.equal(b.id, "air-fryer-2");
  await assert.rejects(store.add({ id: "air-fryer", query: "x" }), /already exists/);

  const paused = await store.update("air-fryer", { paused: true });
  assert.equal(paused.paused, true);
  assert.equal(paused.createdAt, a.createdAt);

  const entry: HistoryEntry = { at: "2026-11-18T00:00:00.000Z", ok: true, offerCount: 0, inStockCount: 0, offers: [], alerts: [] };
  await store.append("air-fryer", entry);
  await store.append("air-fryer", { ...entry, at: "2026-11-18T12:00:00.000Z" });
  assert.equal((await store.history("air-fryer")).length, 2);
  assert.equal((await store.history("air-fryer", 1))[0].at, "2026-11-18T12:00:00.000Z");

  const file = JSON.parse(await readFile(join(store.dir, "watches.json"), "utf8"));
  assert.equal(file.version, 1);
  assert.equal(file.watches.length, 2);

  assert.equal(await store.remove("air-fryer"), true);
  assert.equal(await store.remove("air-fryer"), false);
  assert.deepEqual(await store.history("air-fryer"), []);
});

test("evaluate: below target alerts once on crossing, again only on a further drop", () => {
  const w = baseWatch();
  const first = evaluate(w, [offer(26900), offer(24900, { store: "target", storeDomain: "target.com" })], []);
  assert.deepEqual(first.alerts.map((a) => a.kind), ["below_target"]);
  assert.equal(first.entry.best?.total.cents, 24900);
  assert.equal(first.entry.best?.storeDomain, "target.com");
  assert.match(first.alerts[0].message, /\$249\.00 at target\.com, at or below your target of \$250\.00/);

  const same = evaluate(w, [offer(24900)], [first.entry]);
  assert.deepEqual(same.alerts, []);

  const lower = evaluate(w, [offer(23900)], [first.entry, same.entry]);
  assert.deepEqual(lower.alerts.map((a) => a.kind), ["below_target"]);
  assert.equal(lower.alerts[0].previousTotal?.cents, 24900);

  const above = evaluate(w, [offer(27900)], [lower.entry]);
  assert.deepEqual(above.alerts, []);
  const again = evaluate(w, [offer(24000)], [lower.entry, above.entry]);
  assert.deepEqual(again.alerts.map((a) => a.kind), ["below_target"]);
});

test("evaluate: shipping counts, and used, subscription and out-of-stock offers are ignored", () => {
  const w = baseWatch();
  const r = evaluate(w, [
    offer(24000, { shipping: { cents: 2000, currency: "USD" } }),
    offer(10000, { condition: "used" }),
    offer(11000, { subscription: true }),
    offer(12000, { inStock: false }),
  ], []);
  assert.deepEqual(r.alerts, []);
  assert.equal(r.entry.best?.total.cents, 26000);
  assert.equal(r.entry.inStockCount, 1);

  const any = evaluate({ ...w, condition: "any" }, [offer(10000, { condition: "used" })], []);
  assert.deepEqual(any.alerts.map((a) => a.kind), ["below_target"]);
});

test("evaluate: back in stock and plain price drop", () => {
  const w = baseWatch({ targetPrice: undefined, backInStock: true });
  const out = evaluate(w, [offer(30000, { inStock: false })], []);
  assert.deepEqual(out.alerts, []);
  const back = evaluate(w, [offer(30000)], [out.entry]);
  assert.deepEqual(back.alerts.map((a) => a.kind), ["back_in_stock"]);
  const still = evaluate(w, [offer(29000)], [out.entry, back.entry]);
  assert.deepEqual(still.alerts, []);

  const plain = normalizeWatch({ query: "kettle", stores: ["target"] });
  const p1 = evaluate(plain, [offer(5000)], []);
  assert.deepEqual(p1.alerts, []);
  const p2 = evaluate(plain, [offer(4500)], [p1.entry]);
  assert.deepEqual(p2.alerts.map((a) => a.kind), ["price_drop"]);
  assert.match(p2.alerts[0].message, /down from \$50\.00/);
});

test("evaluateFailure sends one alert after repeated failures", () => {
  const w = baseWatch();
  const history: HistoryEntry[] = [];
  const kinds: string[][] = [];
  for (let i = 0; i < FAILING_AFTER + 2; i++) {
    const r = evaluateFailure(w, "timeout", history);
    history.push(r.entry);
    kinds.push(r.alerts.map((a) => a.kind));
  }
  assert.deepEqual(kinds.flat(), ["check_failing"]);
  assert.deepEqual(kinds[FAILING_AFTER - 1], ["check_failing"]);
});

test("checkWatch records history and notifies; a failed check is recorded too", async () => {
  const store = new WatchStore(await tempDir());
  const w = await store.add({ query: "27 inch 4K monitor", stores: ["walmart"], targetPrice: 250, notify: ["desktop", "slack"] });
  const { notifiers, sent } = captureNotifiers();

  const r1 = await checkWatch(w, { store, notifiers, check: async () => [offer(24900)] });
  assert.equal(r1.alerts.length, 1);
  assert.equal(sent.length, 2, "one alert, two channels");

  let seen: Watch | undefined;
  const r2 = await checkWatch(w, { store, notifiers, check: async (watch) => { seen = watch; throw new Error("store page changed"); } });
  assert.equal(seen?.id, w.id);
  assert.equal(r2.entry.ok, false);
  assert.equal(r2.entry.error, "store page changed");

  const hist = await store.history(w.id);
  assert.deepEqual(hist.map((h) => h.ok), [true, false]);
  // The failed check does not reset the price memory: same price again, no new alert.
  const r3 = await checkWatch(w, { store, notifiers, check: async () => [offer(24900)] });
  assert.equal(r3.alerts.length, 0);
});

test("checkWatch reports delivery errors without throwing", async () => {
  const store = new WatchStore(await tempDir());
  const w = await store.add({ query: "x", stores: ["walmart"], targetPrice: 100, notify: ["slack"] });
  const logs: string[] = [];
  const r = await checkWatch(w, { store, config: {}, log: (m) => logs.push(m), check: async () => [offer(5000)] });
  assert.equal(r.deliveryErrors.length, 1);
  assert.match(r.deliveryErrors[0], /OSA_SLACK_WEBHOOK_URL/);
  assert.match(logs[0], /could not notify/);
});

test("runDueWatches respects interval, paused and force", async () => {
  const store = new WatchStore(await tempDir());
  await store.add({ id: "a", query: "a", stores: ["walmart"] });
  await store.add({ id: "b", query: "b", stores: ["walmart"], intervalMinutes: MIN_INTERVAL_MINUTES });
  await store.add({ id: "c", query: "c", stores: ["walmart"], paused: true });
  const { notifiers } = captureNotifiers();
  const checked: string[] = [];
  const check = async (w: Watch) => { checked.push(w.id); return [offer(1000)]; };
  let t = new Date("2026-11-18T00:00:00Z");
  const now = () => t;

  await runDueWatches({ store, notifiers, check, now });
  assert.deepEqual(checked, ["a", "b"]);

  t = new Date("2026-11-18T06:00:00Z"); // b is due (6 h), a is not (12 h)
  await runDueWatches({ store, notifiers, check, now });
  assert.deepEqual(checked, ["a", "b", "b"]);

  await runDueWatches({ store, notifiers, check, now, force: true, ids: ["a"] });
  assert.deepEqual(checked, ["a", "b", "b", "a"]);
});

test("startWatching runs a pass right away and stops cleanly", async () => {
  const store = new WatchStore(await tempDir());
  await store.add({ id: "m", query: "monitor", stores: ["walmart"], targetPrice: 300 });
  const { notifiers, sent } = captureNotifiers();
  let calls = 0;
  const done = new Promise<void>((resolve) => {
    const watcher = startWatching({
      store, notifiers, tickMs: 10,
      check: async () => { calls++; return [offer(29900)]; },
      onResult: async () => { await watcher.stop(); resolve(); },
    });
  });
  await done;
  assert.equal(calls, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "below_target");
});

test("parseEvery", () => {
  assert.equal(parseEvery("12h"), 720);
  assert.equal(parseEvery("1d"), 1440);
  assert.equal(parseEvery("400"), 400);
  assert.equal(parseEvery("90m"), 90);
  assert.throws(() => parseEvery("soon"));
});

test("runWatchCli add, list, history, pause, run --once, remove", async () => {
  const store = new WatchStore(await tempDir());
  let text = "";
  const out = { write: (s: string) => { text += s; } };
  const config = { out };

  assert.equal(await runWatchCli(["add", "27 inch 4K monitor", "--store", "walmart,target", "--target", "$249.99", "--every", "6h"], { store, out, config }), 0);
  assert.match(text, /Added watch "27-inch-4k-monitor"/);
  const [w] = await store.list();
  assert.deepEqual(w.stores, ["walmart", "target"]);
  assert.equal(w.targetPrice?.cents, 24999);
  assert.equal(w.intervalMinutes, 360);

  assert.equal(await runWatchCli(["add", "x", "--every", "1h"], { store, out, config }), 1);
  assert.match(text, /at least 360/);

  assert.equal(await runWatchCli(["run", "--once"], { store, out, config }), 1);
  assert.match(text, /engine is not installed/);

  text = "";
  assert.equal(await runWatchCli(["run", "--once"], { store, out, config, check: async () => [offer(23900)] }), 0);
  assert.match(text, /\[osa alert\] Price at target: \$239\.00/);
  assert.match(text, /Checked 1 watch, 1 alert/);

  text = "";
  await runWatchCli(["list"], { store, out, config });
  assert.match(text, /last: \$239\.00 at walmart\.com/);
  await runWatchCli(["history", w.id], { store, out, config });
  assert.match(text, /alert: below_target/);

  await runWatchCli(["pause", w.id], { store, out, config });
  assert.equal((await store.get(w.id))?.paused, true);
  assert.equal(await runWatchCli(["remove", w.id], { store, out, config }), 0);
  assert.equal(await runWatchCli(["remove", w.id], { store, out, config }), 1);
  assert.equal(await runWatchCli(["bogus"], { store, out, config }), 2);
});

test("createNotifiers desktop writes to the configured output", async () => {
  let text = "";
  const n = createNotifiers({ out: { write: (s: string) => { text += s; } } });
  await n.desktop.send({ kind: "back_in_stock", watchId: "w", label: "PS5", at: "", message: "PS5: in stock at target.com for $499.99.",
    offer: { store: "target", storeDomain: "target.com", title: "PS5", url: "https://www.target.com/p/1", price: { cents: 49999, currency: "USD" }, total: { cents: 49999, currency: "USD" }, inStock: true } }, { channel: "desktop" });
  assert.match(text, /Back in stock: \$499\.99 PS5/);
  assert.match(text, /https:\/\/www\.target\.com\/p\/1/);
  assert.match(text, /never buys without your approval/);
});
