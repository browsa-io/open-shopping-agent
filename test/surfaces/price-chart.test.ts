// The price history chart's geometry and words (web/components/price-chart.js), without a browser.

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error a browser module without types; only its pure functions are used here
import { chartModel, historyWords, niceTicks } from "../../web/components/price-chart.js";

const pt = (at: string, cents: number) => ({ at, cents, store: "walmart", storeDomain: "walmart.com" });
const points = [pt("2026-11-02T09:00:00Z", 26999), pt("2026-11-03T09:00:00Z", 24999), pt("2026-11-07T09:00:00Z", 19999), pt("2026-11-08T09:00:00Z", 21999)];

test("niceTicks: a few round values that cover the range, also for one price", () => {
  const t = niceTicks(19999, 26999);
  assert.ok(t.length >= 2 && t.length <= 5, String(t));
  assert.ok(t[0] <= 19999 && t[t.length - 1] >= 26999);
  assert.ok(t.every((v: number) => v % 2500 === 0), String(t));
  const one = niceTicks(1299, 1299);
  assert.ok(one[0] < 1299 && one[one.length - 1] > 1299);
});

test("chartModel: points left to right in time, lower prices lower on the plot, inside the frame", () => {
  const m = chartModel(points, { width: 560, height: 180 });
  assert.equal(m.points.length, 4);
  for (let i = 1; i < m.points.length; i++) assert.ok(m.points[i].x > m.points[i - 1].x);
  assert.ok(m.points[2].y > m.points[0].y, "$199.99 sits below $269.99");
  for (const p of m.points) assert.ok(p.x >= m.margin.left && p.x <= 560 - m.margin.right && p.y >= m.margin.top && p.y <= 180 - m.margin.bottom);
  assert.match(m.path, /^M[\d.]+,[\d.]+( L[\d.]+,[\d.]+){3}$/);
  // one y scale, ticks inside the frame
  for (const t of m.ticks) assert.ok(t.y >= m.margin.top - 0.5 && t.y <= 180 - m.margin.bottom + 0.5);
  // selective labels: the latest price and the low, not a number on every point
  assert.deepEqual(m.labels.map((l: { kind: string; text: string }) => [l.kind, l.text]), [["last", "$219.99"], ["low", "Low $199.99"]]);
});

test("chartModel: one point, and no points", () => {
  const one = chartModel([points[0]]);
  assert.equal(one.points.length, 1);
  assert.deepEqual(one.labels.map((l: { kind: string }) => l.kind), ["last"]);
  assert.equal(one.xLabels.length, 1);
  assert.deepEqual(chartModel([]).points, []);
});

test("historyWords: the same facts in one line", () => {
  const hist = { points, priced: 4, checks: 6, low: points[2], high: points[0], first: points[0], last: points[3] };
  assert.equal(historyWords(hist), "$219.99 at the last check, lowest $199.99 on Nov 7, highest $269.99. 4 priced checks since Nov 2.");
  assert.equal(historyWords({ points: [], priced: 0, checks: 0 }), "Not checked yet. The history starts with the first check.");
  assert.equal(historyWords({ points: [], priced: 0, checks: 3 }), "No price found yet in 3 checks.");
});
