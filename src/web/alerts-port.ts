// The alerts port: price-drop and back-in-stock watches, as the web app and MCP see them.
// WatchAlerts is the real one, over src/alerts (WatchStore in .osa/watches.json, checks with the
// engine's CheckFn). FileAlerts is a minimal stand-in kept for tests: it saves and never checks.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Money, StoreId } from "../core/types.js";
import { WatchStore } from "../alerts/store.js";
import { runDueWatches } from "../alerts/checker.js";
import type { AlertConfig, CheckFn, HistoryEntry, NotifyTarget, Watch as AlertWatch, WatchInput as AlertWatchInput } from "../alerts/types.js";

export type WatchKind = "price_drop" | "back_in_stock";

export interface WatchInput {
  kind: WatchKind;
  item: string;              // what to watch: "6 ft HDMI 2.1 cable", or a product URL
  url?: string;              // a product page, when watching one listing
  stores?: StoreId[];        // default: allowed stores
  below?: Money;             // price_drop: notify when the delivered price is at or below this
  notify?: { email?: string; slack?: string; webhook?: string };
}

export interface Watch extends WatchInput {
  id: string;
  createdAt: string;
  status: "saved" | "active" | "triggered" | "paused";
  lastCheckedAt?: string;
  lastPrice?: Money;
  lastStore?: StoreId;
  lastError?: string;
}

export interface AlertsPort {
  /** True while watches are saved but never checked (the FileAlerts stand-in). */
  readonly demo: boolean;
  list(): Promise<Watch[]>;
  create(input: WatchInput): Promise<Watch>;
  remove(id: string): Promise<boolean>;
  /** Check one watch now (sends its alerts). Absent when this port cannot check. */
  check?(id: string): Promise<Watch>;
}

export function validateWatch(input: unknown): WatchInput {
  const i = (input ?? {}) as Record<string, unknown>;
  const kind = i.kind === "back_in_stock" ? "back_in_stock" : i.kind === "price_drop" || i.kind === undefined ? "price_drop" : null;
  if (!kind) throw new Error("kind must be price_drop or back_in_stock");
  const item = typeof i.item === "string" ? i.item.trim().slice(0, 300) : "";
  if (!item) throw new Error("item is required");
  const out: WatchInput = { kind, item };
  if (typeof i.url === "string" && /^https:\/\//.test(i.url)) out.url = i.url.slice(0, 1000);
  if (Array.isArray(i.stores)) out.stores = i.stores.filter((s): s is StoreId => typeof s === "string").slice(0, 6) as StoreId[];
  const below = i.below as Money | undefined;
  if (below && typeof below === "object" && Number.isInteger(below.cents) && below.cents > 0) {
    out.below = { cents: below.cents, currency: typeof below.currency === "string" ? below.currency : "USD" };
  }
  if (kind === "price_drop" && !out.below) throw new Error("price_drop needs below (a price)");
  const n = (i.notify ?? {}) as Record<string, unknown>;
  const notify: NonNullable<WatchInput["notify"]> = {};
  if (typeof n.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(n.email.trim())) notify.email = n.email.trim().slice(0, 200);
  if (typeof n.slack === "string" && /^https:\/\//.test(n.slack)) notify.slack = n.slack.slice(0, 1000);
  if (typeof n.webhook === "string" && /^https:\/\//.test(n.webhook)) notify.webhook = n.webhook.slice(0, 1000);
  if (Object.keys(notify).length) out.notify = notify;
  return out;
}

export class FileAlerts implements AlertsPort {
  readonly demo = true;
  constructor(private file: string) {}

  private async load(): Promise<Watch[]> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private async save(list: Watch[]) {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(list, null, 2));
  }

  async list(): Promise<Watch[]> {
    return (await this.load()).reverse();
  }

  async create(input: WatchInput): Promise<Watch> {
    const w = validateWatch(input);
    const list = await this.load();
    const watch: Watch = { ...w, id: `w_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, createdAt: new Date().toISOString(), status: "saved" };
    list.push(watch);
    await this.save(list);
    return watch;
  }

  async remove(id: string): Promise<boolean> {
    const list = await this.load();
    const next = list.filter((w) => w.id !== id);
    if (next.length === list.length) return false;
    await this.save(next);
    return true;
  }
}

export interface WatchAlertsOptions {
  /** Folder of watches.json and watches/<id>.jsonl. */
  dir: string;
  /** The engine's check, or undefined when no Browsa key is set (then checks are refused). */
  getCheck: () => Promise<CheckFn | undefined>;
  /** Stores and Shopify domains used when a watch names none. */
  defaults?: () => Promise<{ stores?: StoreId[]; shopifyDomains?: string[] }>;
  /** Notifier settings. Default: from the environment (configFromEnv). */
  config?: AlertConfig;
  log?: (m: string) => void;
}

/** The real alerts store (src/alerts) behind the port. */
export class WatchAlerts implements AlertsPort {
  readonly demo = false;
  readonly store: WatchStore;
  constructor(private o: WatchAlertsOptions) {
    this.store = new WatchStore(o.dir);
  }

  async list(): Promise<Watch[]> {
    const out: Watch[] = [];
    for (const w of (await this.store.list()).reverse()) out.push(toPortWatch(w, (await this.store.history(w.id, 1))[0]));
    return out;
  }

  async create(input: WatchInput): Promise<Watch> {
    const w = validateWatch(input);
    const d = (await this.o.defaults?.()) ?? {};
    let stores = w.stores?.length ? w.stores : w.url ? undefined : d.stores;
    const shopifyDomains = stores?.includes("shopify") ? d.shopifyDomains : undefined;
    if (stores?.includes("shopify") && !shopifyDomains?.length) stores = stores.filter((s) => s !== "shopify");
    const notify: NotifyTarget[] = [];
    if (w.notify?.email) notify.push({ channel: "email", to: w.notify.email });
    if (w.notify?.slack) notify.push({ channel: "slack", url: w.notify.slack });
    if (w.notify?.webhook) notify.push({ channel: "webhook", url: w.notify.webhook });
    const add: AlertWatchInput = {
      label: w.item,
      ...(w.url ? { url: w.url } : { query: w.item }),
      ...(stores?.length ? { stores } : {}),
      ...(shopifyDomains?.length ? { shopifyDomains } : {}),
      ...(w.below ? { targetPrice: w.below } : {}),
      ...(w.kind === "back_in_stock" ? { backInStock: true } : {}),
      notify: notify.length ? notify : "desktop",
    };
    return toPortWatch(await this.store.add(add), undefined);
  }

  remove(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  async check(id: string): Promise<Watch> {
    const w = await this.store.get(id);
    if (!w) throw new Error("Watch not found");
    const check = await this.o.getCheck();
    if (!check) throw new Error("Add a Browsa API key in Settings to check watches");
    await runDueWatches({ check, store: this.store, ids: [id], force: true, log: this.o.log, ...(this.o.config ? { config: this.o.config } : {}) });
    return toPortWatch(w, (await this.store.history(id, 1))[0]);
  }
}

function toPortWatch(w: AlertWatch, last: HistoryEntry | undefined): Watch {
  const notify: NonNullable<Watch["notify"]> = {};
  for (const t of w.notify) {
    if (t.channel === "email" && t.to) notify.email = t.to;
    if (t.channel === "slack" && t.url) notify.slack = t.url;
    if (t.channel === "webhook" && t.url) notify.webhook = t.url;
  }
  const triggered = !!last?.alerts.some((a) => a !== "check_failing");
  return {
    id: w.id,
    kind: w.backInStock && !w.targetPrice ? "back_in_stock" : "price_drop",
    item: w.label ?? w.query ?? w.url ?? w.id,
    ...(w.url ? { url: w.url } : {}),
    stores: w.stores,
    ...(w.targetPrice ? { below: w.targetPrice } : {}),
    ...(Object.keys(notify).length ? { notify } : {}),
    createdAt: w.createdAt,
    status: w.paused ? "paused" : triggered ? "triggered" : last ? "active" : "saved",
    ...(last ? { lastCheckedAt: last.at } : {}),
    ...(last?.best ? { lastPrice: last.best.total, lastStore: last.best.store } : {}),
    ...(last && !last.ok && last.error ? { lastError: last.error } : {}),
  };
}
