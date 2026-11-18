// Watches on disk: .osa/watches.json (the list) and .osa/watches/<id>.jsonl (one line per check).
// Plain JSON files so people can read, edit and back them up, and so a GitHub Actions run can
// commit them between scheduled runs.

import { mkdir, readFile, rename, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Money, StoreId } from "../core/types.js";
import type { HistoryEntry, NotifyChannel, NotifyTarget, Watch, WatchInput } from "./types.js";

/** Polite polling: one check per watch every 6 hours at most, 12 hours by default. */
export const MIN_INTERVAL_MINUTES = 360;
export const DEFAULT_INTERVAL_MINUTES = 720;

const STORES: StoreId[] = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"];
const CHANNELS: NotifyChannel[] = ["email", "slack", "webhook", "desktop"];

/** The .osa folder: OSA_DIR, or .osa in the current directory. */
export function defaultDir(): string {
  return process.env.OSA_DIR || join(process.cwd(), ".osa");
}

export class WatchStore {
  constructor(readonly dir: string = defaultDir()) {}

  get file(): string { return join(this.dir, "watches.json"); }
  historyFile(id: string): string { return join(this.dir, "watches", `${safeId(id)}.jsonl`); }

  async list(): Promise<Watch[]> {
    let text: string;
    try { text = await readFile(this.file, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const data = JSON.parse(text) as { watches?: Watch[] } | Watch[];
    const watches = Array.isArray(data) ? data : data.watches ?? [];
    return watches.map((w) => normalizeWatch(w, w.createdAt));
  }

  async get(id: string): Promise<Watch | undefined> {
    return (await this.list()).find((w) => w.id === id);
  }

  async save(watches: Watch[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, watches }, null, 2) + "\n");
    await rename(tmp, this.file);
  }

  async add(input: WatchInput): Promise<Watch> {
    const watches = await this.list();
    const watch = normalizeWatch(input, new Date().toISOString());
    if (!input.id) {
      let id = watch.id;
      for (let n = 2; watches.some((w) => w.id === id); n++) id = `${watch.id}-${n}`;
      watch.id = id;
    } else if (watches.some((w) => w.id === watch.id)) {
      throw new Error(`a watch with id "${watch.id}" already exists`);
    }
    watches.push(watch);
    await this.save(watches);
    return watch;
  }

  async update(id: string, patch: Partial<WatchInput>): Promise<Watch> {
    const watches = await this.list();
    const i = watches.findIndex((w) => w.id === id);
    if (i < 0) throw new Error(`no watch with id "${id}"`);
    const merged = normalizeWatch({ ...watches[i], ...patch, id }, watches[i].createdAt);
    watches[i] = merged;
    await this.save(watches);
    return merged;
  }

  async remove(id: string): Promise<boolean> {
    const watches = await this.list();
    const next = watches.filter((w) => w.id !== id);
    if (next.length === watches.length) return false;
    await this.save(next);
    await rm(this.historyFile(id), { force: true });
    return true;
  }

  async append(id: string, entry: HistoryEntry): Promise<void> {
    await mkdir(join(this.dir, "watches"), { recursive: true });
    await appendFile(this.historyFile(id), JSON.stringify(entry) + "\n");
  }

  /** All entries, oldest first. Lines that do not parse are skipped. */
  async history(id: string, limit?: number): Promise<HistoryEntry[]> {
    let text: string;
    try { text = await readFile(this.historyFile(id), "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: HistoryEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as HistoryEntry); } catch { /* a torn last line */ }
    }
    return limit ? out.slice(-limit) : out;
  }
}

/** Validate and fill defaults. Throws a plain error message on bad input. */
export function normalizeWatch(input: WatchInput | Watch, createdAt = new Date().toISOString()): Watch {
  const query = input.query?.trim() || undefined;
  const url = input.url?.trim() || undefined;
  if (!query && !url) throw new Error("a watch needs a query or a product url");
  if (url && !/^https?:\/\//i.test(url)) throw new Error(`not a web address: ${url}`);

  const storesIn = (input as WatchInput).stores ?? ((input as WatchInput).store ? [(input as WatchInput).store!] : undefined);
  const stores = storesIn && storesIn.length ? [...new Set(storesIn)] : url ? [storeFromUrl(url)] : STORES.filter((s) => s !== "shopify");
  for (const s of stores) if (!STORES.includes(s)) throw new Error(`unknown store "${s}" (known: ${STORES.join(", ")})`);
  if (stores.includes("shopify") && !input.shopifyDomains?.length && !url) {
    throw new Error("the shopify store needs shopifyDomains, e.g. [\"allbirds.com\"]");
  }

  const interval = input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MINUTES) {
    throw new Error(`intervalMinutes must be at least ${MIN_INTERVAL_MINUTES} (6 hours), so stores are not polled too often`);
  }

  const targetPrice = toMoney(input.targetPrice);
  const notify = normalizeNotify(input.notify);
  const id = input.id ? safeId(input.id) : slug(query ?? url ?? "watch");

  return {
    id,
    ...(input.label ? { label: input.label } : {}),
    ...(query ? { query } : {}),
    ...(url ? { url } : {}),
    stores,
    ...(input.shopifyDomains?.length ? { shopifyDomains: input.shopifyDomains } : {}),
    ...(targetPrice ? { targetPrice } : {}),
    ...(input.backInStock ? { backInStock: true } : {}),
    condition: input.condition ?? "new",
    notify,
    intervalMinutes: Math.round(interval),
    ...(input.paused ? { paused: true } : {}),
    createdAt: (input as Watch).createdAt ?? createdAt,
  };
}

function normalizeNotify(n: WatchInput["notify"]): NotifyTarget[] {
  const list = n === undefined ? ["desktop" as const] : Array.isArray(n) ? n : [n];
  const out: NotifyTarget[] = list.map((x) => (typeof x === "string" ? { channel: x } : { ...x }));
  for (const t of out) {
    if (!CHANNELS.includes(t.channel)) throw new Error(`unknown notify channel "${t.channel}" (known: ${CHANNELS.join(", ")})`);
  }
  return out.length ? out : [{ channel: "desktop" }];
}

function toMoney(v: Money | number | undefined): Money | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") {
    if (!(v > 0)) throw new Error("targetPrice must be more than 0");
    return { cents: Math.round(v * 100), currency: "USD" };
  }
  if (!Number.isInteger(v.cents) || v.cents <= 0) throw new Error("targetPrice.cents must be a whole number more than 0");
  return { cents: v.cents, currency: v.currency || "USD" };
}

/** Best guess of the store from a product url; anything unknown is treated as a Shopify store. */
export function storeFromUrl(url: string): StoreId {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (/(^|\.)amazon\.com$/.test(host)) return "amazon";
  if (/(^|\.)walmart\.com$/.test(host)) return "walmart";
  if (/(^|\.)ebay\.com$/.test(host)) return "ebay";
  if (/(^|\.)bestbuy\.com$/.test(host)) return "bestbuy";
  if (/(^|\.)target\.com$/.test(host)) return "target";
  return "shopify";
}

function slug(s: string): string {
  const base = s.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return base || "watch";
}

function safeId(id: string): string {
  const s = id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!s) throw new Error(`bad watch id "${id}"`);
  return s;
}
