// Price history of one watch (0.3.0 preview, shown only with OSA_PRICE_HISTORY=1): a small line
// chart of the best in-stock price each check found, from the history kept on this computer.
// One series, so no legend; the lowest and the latest price are labelled, every point has a
// tooltip, and the same numbers are in a table below the chart.

import { h } from "../lib/dom.js";
import { formatCents, storeName } from "../lib/wording.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const dayTime = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Nice" axis ticks around [min, max] in cents: 2 to 4 round values. */
export function niceTicks(min, max) {
  if (max <= min) { const pad = Math.max(100, Math.round(min * 0.05)); min -= pad; max += pad; }
  const span = max - min;
  const raw = span / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw;
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = lo; v <= max + step * 0.999; v += step) ticks.push(Math.round(v));
  return ticks;
}

/**
 * Geometry of the chart, with no DOM: where each point sits, the y ticks, the line path and which
 * points get a label. Pure, so it is tested in Node.
 */
export function chartModel(points, o = {}) {
  const W = o.width ?? 560, H = o.height ?? 180;
  const m = { top: 18, right: 64, bottom: 24, left: 52 };
  if (!points.length) return { width: W, height: H, points: [], ticks: [], path: "", labels: [], xLabels: [] };
  const t = points.map((p) => new Date(p.at).getTime());
  const t0 = Math.min(...t), t1 = Math.max(...t);
  const ticks = niceTicks(Math.min(...points.map((p) => p.cents)), Math.max(...points.map((p) => p.cents)));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const x = (ms) => (t1 === t0 ? m.left + (W - m.left - m.right) / 2 : m.left + ((ms - t0) / (t1 - t0)) * (W - m.left - m.right));
  const y = (c) => H - m.bottom - ((c - y0) / (y1 - y0 || 1)) * (H - m.top - m.bottom);
  const pts = points.map((p, i) => ({ ...p, x: Math.round(x(t[i]) * 10) / 10, y: Math.round(y(p.cents) * 10) / 10 }));
  const lowIdx = pts.reduce((b, p, i) => (p.cents < pts[b].cents ? i : b), 0);
  const lastIdx = pts.length - 1;
  // Selective labels: the latest price (at the right end) and the lowest when it is another point.
  const labels = [{ i: lastIdx, text: formatCents(pts[lastIdx].cents), kind: "last" }];
  if (lowIdx !== lastIdx && pts[lowIdx].cents < pts[lastIdx].cents) labels.push({ i: lowIdx, text: `Low ${formatCents(pts[lowIdx].cents)}`, kind: "low" });
  return {
    width: W, height: H, margin: m, points: pts,
    ticks: ticks.map((c) => ({ cents: c, y: Math.round(y(c) * 10) / 10, text: formatCents(c).replace(/\.00$/, "") })),
    path: pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" "),
    labels,
    xLabels: t1 === t0 ? [{ x: pts[0].x, text: day(points[0].at) }] : [{ x: m.left, text: day(points[0].at), anchor: "start" }, { x: W - m.right, text: day(points[lastIdx].at), anchor: "end" }],
  };
}

/** One line of words for the history: "$24.99 now, low $19.99 on Nov 12, high $29.99; 8 priced checks since Nov 3". */
export function historyWords(hist) {
  if (!hist.points.length) return hist.checks ? `No price found yet in ${hist.checks} check${hist.checks === 1 ? "" : "s"}.` : "Not checked yet. The history starts with the first check.";
  const { last, low, high, first } = hist;
  const parts = [`${formatCents(last.cents)} at the last check`];
  if (hist.points.length > 1) parts.push(`lowest ${formatCents(low.cents)} on ${day(low.at)}`, `highest ${formatCents(high.cents)}`);
  return `${parts.join(", ")}. ${hist.priced} priced check${hist.priced === 1 ? "" : "s"} since ${day(first.at)}.`;
}

/** The chart, its summary line and the table of the same numbers. */
export function priceChart(hist, title) {
  const wrap = h("div", { class: "pchart" });
  wrap.append(h("p", { class: "small muted pchart-sum" }, historyWords(hist)));
  if (!hist.points.length) return wrap;
  // Drawn at the width it is shown at, so the text keeps its size on a phone.
  const mdl = chartModel(hist.points, { width: Math.min(560, Math.max(300, (globalThis.innerWidth || 640) - 66)) });
  const { points: pts, margin: m, width: W, height: H } = mdl;
  const svg = [
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Price history of ${title}: ${historyWords(hist)}`)}">`,
    ...mdl.ticks.map((t) => `<line class="pc-grid" x1="${m.left}" x2="${W - m.right}" y1="${t.y}" y2="${t.y}"/><text class="pc-axis" x="${m.left - 8}" y="${t.y + 4}" text-anchor="end">${esc(t.text)}</text>`),
    ...mdl.xLabels.map((l) => `<text class="pc-axis" x="${l.x}" y="${H - 6}" text-anchor="${l.anchor || "middle"}">${esc(l.text)}</text>`),
    pts.length > 1 ? `<path class="pc-line" d="${mdl.path}"/>` : "",
    `<line class="pc-cross" x1="0" x2="0" y1="${m.top}" y2="${H - m.bottom}" visibility="hidden"/>`,
    ...pts.map((p, i) => `<circle class="pc-dot" data-i="${i}" cx="${p.x}" cy="${p.y}" r="${pts.length > 40 ? 2.5 : 4}"/>`),
    ...mdl.labels.map((l) => {
      const p = pts[l.i];
      return l.kind === "last"
        ? `<text class="pc-label" x="${p.x + 8}" y="${p.y + 4}">${esc(l.text)}</text>`
        : `<text class="pc-label" x="${p.x}" y="${Math.min(H - m.bottom - 4, p.y + 16)}" text-anchor="middle">${esc(l.text)}</text>`;
    }),
    "</svg>",
  ].join("");
  const plot = h("div", { class: "pchart-plot" });
  plot.innerHTML = svg;
  const tip = h("div", { class: "pchart-tip", role: "status", hidden: true });
  plot.append(tip);
  const el = plot.querySelector("svg");
  const cross = el.querySelector(".pc-cross");
  const dots = [...el.querySelectorAll(".pc-dot")];
  const show = (i) => {
    const p = pts[i];
    dots.forEach((d, k) => d.classList.toggle("on", k === i));
    cross.setAttribute("x1", p.x); cross.setAttribute("x2", p.x); cross.setAttribute("visibility", "visible");
    tip.replaceChildren(h("strong", {}, formatCents(p.cents)), h("span", {}, ` ${storeName(p.store, p.storeDomain)}`), h("span", { class: "faint" }, ` · ${dayTime(p.at)}`));
    tip.hidden = false;
    tip.style.left = `${Math.min(88, Math.max(12, (p.x / W) * 100))}%`;
  };
  const hide = () => { dots.forEach((d) => d.classList.remove("on")); cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
  // The whole plot is the hit target: the nearest point in time answers, not only the dot itself.
  el.addEventListener("pointermove", (ev) => {
    const r = el.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    show(pts.reduce((b, p, i) => (Math.abs(p.x - px) < Math.abs(pts[b].x - px) ? i : b), 0));
  });
  el.addEventListener("pointerleave", hide);
  wrap.append(plot);
  // The same numbers as a table (newest first), for screen readers and for copying.
  wrap.append(h("details", { class: "pchart-table" }, h("summary", { class: "small" }, "Show as a table"),
    h("table", { class: "small" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Checked"), h("th", { scope: "col" }, "Best price"), h("th", { scope: "col" }, "Store"))),
      h("tbody", {}, [...hist.points].reverse().map((p) => h("tr", {}, h("td", {}, dayTime(p.at)), h("td", {}, formatCents(p.cents)), h("td", {}, storeName(p.store, p.storeDomain))))))));
  return wrap;
}
