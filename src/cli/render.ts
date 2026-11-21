// Terminal rendering for the osa CLI: plain ANSI, no dependencies.

import type { Cart, CheckoutReview, Money, StoreId } from "../core/types.js";
import type { CompareItem } from "../web/format.js";
import { currencyMark, money, ratingText, shippingText, storeName, deliveredCents } from "../web/format.js";
import { clipWords } from "../core/rank.js";

export interface Paint {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
}

const wrap = (on: boolean, a: number, b: number) => (s: string) => (on ? `\x1b[${a}m${s}\x1b[${b}m` : s);

export function paint(enabled: boolean): Paint {
  return {
    bold: wrap(enabled, 1, 22), dim: wrap(enabled, 2, 22), green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39), red: wrap(enabled, 31, 39),
  };
}

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const HAS_ANSI = /\x1b\[/;
export const visibleLength = (s: string) => [...s.replace(ANSI, "")].length;

export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

export interface Column {
  header: string;
  align?: "left" | "right";
  max?: number;            // truncate plain cells longer than this
}

/** A borderless, aligned table. Cells may contain ANSI colour; widths ignore it. */
export function renderTable(columns: Column[], rows: string[][], indent = "  "): string {
  const cells = rows.map((r) => r.map((c, i) => {
    const max = columns[i]?.max;
    return max && !HAS_ANSI.test(c) && visibleLength(c) > max ? truncate(c, max) : c;
  }));
  const widths = columns.map((c, i) => Math.max(visibleLength(c.header), ...cells.map((r) => visibleLength(r[i] ?? ""))));
  const line = (r: string[]) => indent + r.map((c, i) => {
    const pad = " ".repeat(Math.max(0, widths[i] - visibleLength(c)));
    return columns[i].align === "right" ? pad + c : c + pad;
  }).join("  ").replace(/\s+$/, "");
  return [line(columns.map((c) => c.header)), indent + widths.map((w) => "─".repeat(w)).join("  "), ...cells.map(line)].join("\n");
}

/** A long delivery text is cut at a word, never mid-word. */
const clipDelivery = (t: string) => clipWords(t, 44);

/** The comparison per item: best pick first (marked), then the other offers by delivered price. */
export function renderCompare(items: CompareItem[], p: Paint, opts: { maxRows?: number; width?: number } = {}): string {
  const maxRows = opts.maxRows ?? 6;
  const width = opts.width ?? 100;
  const titleMax = Math.max(18, Math.min(50, width - 62));
  const out: string[] = [];
  for (const item of items) {
    out.push(p.bold(item.label));
    if (item.pick) {
      const o = item.pick.offer;
      out.push(`  ${p.green("Best pick")} ${storeName(o.store, o.storeDomain)}, ${money({ cents: deliveredCents(o), currency: o.price.currency })} ${o.shipping ? "delivered" : "plus shipping"}. ${p.dim(item.pick.reason)}`);
    }
    if (!item.rows.length) {
      out.push(p.dim("  No offers found"), "");
      continue;
    }
    const shown = item.rows.slice(0, maxRows);
    // The price per unit ("$0.42 / count") gets a column only when some offer shown has one.
    const units = shown.some((r) => r.offer.perUnit?.text);
    const rows = shown.map((r) => [
      r.best ? p.green("★") : r.alternative ? p.dim("·") : " ",
      storeName(r.offer.store, r.offer.storeDomain),
      truncate(r.offer.title, units ? Math.max(18, titleMax - 14) : titleMax) + (r.offer.inStock ? "" : " (out of stock)") + (r.offer.currencyMismatch ? p.yellow(currencyMark(r.offer)) : ""),
      money(r.offer.price),
      ...(units ? [r.offer.perUnit?.text ?? "–"] : []),
      shippingText(r.offer),
      clipDelivery((r.offer.deliveryText ?? "–").replace(/^Arrives\s+/i, "")),
      ratingText(r.offer),
    ]);
    out.push(renderTable([
      { header: "" }, { header: "Store" }, { header: "Product" }, { header: "Price", align: "right" },
      ...(units ? [{ header: "Per unit", align: "right" as const }] : []),
      { header: "Ship", align: "right" }, { header: "Delivery" }, { header: "Rating" },
    ], rows));
    if (item.rows.length > maxRows) out.push(p.dim(`  + ${item.rows.length - maxRows} more`));
    out.push("");
  }
  return out.join("\n");
}

export function renderLines(lines: Cart["lines"], p: Paint): string {
  return renderTable([{ header: "Qty", align: "right" }, { header: "Item", max: 60 }, { header: "Price", align: "right" }],
    lines.map((l) => [String(l.quantity), l.title + (l.options ? p.dim(` (${Object.values(l.options).join(", ")})`) : ""), money(l.price)]));
}

export function renderReview(r: CheckoutReview, p: Paint): string {
  const sums = [
    ["Subtotal", money(r.subtotal)],
    ["Shipping", r.shipping ? (r.shipping.cents === 0 ? "Free" : money(r.shipping)) : "not shown"],
    ["Tax", r.tax ? money(r.tax) : "not shown"],
    [p.bold("Total"), p.bold(money(r.total))],
  ];
  const w = Math.max(...sums.map((s) => visibleLength(s[1])));
  return [
    renderLines(r.lines, p),
    ...sums.map(([k, v]) => `  ${k}${" ".repeat(Math.max(1, 12 - visibleLength(k)))}${" ".repeat(w - visibleLength(v))}${v}`),
    r.shipTo || r.paymentHint ? p.dim(`  ${[r.shipTo && `Ships to ${r.shipTo}`, r.paymentHint].filter(Boolean).join(" · ")}`) : "",
  ].filter(Boolean).join("\n");
}

export type StoreState = { label: string; tone: "busy" | "ok" | "warn" | "bad" | "idle" };

/** Live per-store progress. On a TTY it redraws in place; otherwise it prints changes as lines. */
export class Progress {
  private states = new Map<StoreId, StoreState>();
  private drawn = 0;
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private out: NodeJS.WriteStream, private p: Paint, private tty = !!out.isTTY) {
    if (this.tty) this.timer = setInterval(() => this.draw(), 120);
  }

  set(store: StoreId, state: StoreState) {
    const prev = this.states.get(store);
    if (prev && prev.label === state.label && prev.tone === state.tone) return;
    this.states.set(store, state);
    if (this.stopped) return;
    if (this.tty) this.draw();
    else if (prev?.label !== state.label) this.out.write(`${storeName(store)}: ${state.label}\n`);
  }

  private draw() {
    if (this.stopped) return;
    const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[this.frame++ % 10];
    const lines = [...this.states].map(([s, st]) => {
      const mark = st.tone === "busy" ? this.p.dim(spin) : st.tone === "ok" ? this.p.green("✓") : st.tone === "bad" ? this.p.red("✗") : st.tone === "warn" ? this.p.yellow("!") : this.p.dim("·");
      const label = st.tone === "bad" ? this.p.red(st.label) : st.tone === "warn" ? this.p.yellow(st.label) : st.label;
      return `  ${mark} ${storeName(s).padEnd(9)} ${label}`;
    });
    let s = this.drawn ? `\x1b[${this.drawn}F` : "";
    for (const l of lines) s += `\x1b[2K${l}\n`;
    this.out.write(s);
    this.drawn = lines.length;
  }

  stop() {
    if (this.stopped) return;
    if (this.tty) this.draw();
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}

export function totalLine(total: Money, budget: Money | undefined, over: boolean, p: Paint, shippingUnknown = false): string {
  const b = budget ? (over ? p.red(` over the ${money(budget)} budget`) : p.green(` within ${money(budget)}`)) : "";
  return `${p.bold("Total for best picks")} ${p.bold(money(total))}${b} ${p.dim(shippingUnknown ? "(plus shipping where not shown, tax at checkout)" : "(tax at checkout)")}`;
}
