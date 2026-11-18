// Store registry: StoreId -> adapter, loaded lazily so a missing adapter file only fails that
// store (with a clear message), never the build or the run.
//
// An adapter module exports its adapter as `default` or as a named export (`amazon`,
// `amazonAdapter`, or any export that looks like a StoreAdapter with the right id).

import type { StoreId } from "../core/types.js";
import type { StoreAdapter } from "./adapter.js";

export const STORE_IDS: StoreId[] = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"];

export const STORE_NAMES: Record<StoreId, string> = {
  amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target", shopify: "Shopify",
};

export class AdapterNotInstalledError extends Error {
  constructor(public store: StoreId, cause?: unknown) {
    super(`The ${STORE_NAMES[store] ?? store} adapter is not installed (src/stores/${store}.ts)${cause ? `: ${(cause as Error).message ?? cause}` : ""}`);
    this.name = "AdapterNotInstalledError";
  }
}

// The adapter modules may not exist yet; see spec().
const LOADERS: Record<StoreId, () => Promise<Record<string, unknown>>> = {
  amazon: () => import(/* @vite-ignore */ spec("amazon")),
  walmart: () => import(/* @vite-ignore */ spec("walmart")),
  ebay: () => import(/* @vite-ignore */ spec("ebay")),
  bestbuy: () => import(/* @vite-ignore */ spec("bestbuy")),
  target: () => import(/* @vite-ignore */ spec("target")),
  shopify: () => import(/* @vite-ignore */ spec("shopify")),
};

// A computed specifier keeps `tsc` from failing on adapter files that are not written yet.
function spec(id: StoreId): string {
  return `./${id}.js`;
}

const cache = new Map<StoreId, Promise<StoreAdapter>>();
const overrides = new Map<StoreId, StoreAdapter>();

/** Use this adapter for the store instead of src/stores/<id>.ts (tests, custom stores). */
export function registerAdapter(adapter: StoreAdapter): void {
  overrides.set(adapter.id, adapter);
  cache.delete(adapter.id);
}

export function unregisterAdapter(id: StoreId): void {
  overrides.delete(id);
  missing.delete(id);
  cache.delete(id);
}

const missing = new Set<StoreId>();
/** Tests: treat the store as having no adapter file (cleared by unregisterAdapter). */
export function markAdapterMissing(id: StoreId): void {
  missing.add(id);
  overrides.delete(id);
  cache.delete(id);
}

/** Load the store's adapter. Throws AdapterNotInstalledError when its file is missing or invalid. */
export function loadAdapter(id: StoreId): Promise<StoreAdapter> {
  if (missing.has(id)) return Promise.reject(new AdapterNotInstalledError(id));
  const o = overrides.get(id);
  if (o) return Promise.resolve(o);
  if (!LOADERS[id]) return Promise.reject(new AdapterNotInstalledError(id, new Error("unknown store")));
  let p = cache.get(id);
  if (!p) {
    p = LOADERS[id]().then(
      (mod) => {
        const a = findAdapter(mod, id);
        if (!a) throw new AdapterNotInstalledError(id, new Error("the module exports no adapter"));
        return a;
      },
      (e) => {
        const code = (e as { code?: string }).code;
        if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || /Cannot find module/i.test(String(e))) {
          throw new AdapterNotInstalledError(id);
        }
        throw new AdapterNotInstalledError(id, e);
      },
    );
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** Adapters that load, by store; missing ones listed with the error. */
export async function loadAdapters(ids: StoreId[] = STORE_IDS): Promise<{ adapters: Partial<Record<StoreId, StoreAdapter>>; missing: { store: StoreId; error: string }[] }> {
  const adapters: Partial<Record<StoreId, StoreAdapter>> = {};
  const missing: { store: StoreId; error: string }[] = [];
  await Promise.all(ids.map(async (id) => {
    try { adapters[id] = await loadAdapter(id); } catch (e) { missing.push({ store: id, error: (e as Error).message }); }
  }));
  return { adapters, missing };
}

export function isAdapter(x: unknown): x is StoreAdapter {
  const a = x as StoreAdapter;
  return !!a && typeof a === "object" && typeof a.id === "string" && typeof a.search === "function" &&
    typeof a.addToCart === "function" && typeof a.readCart === "function" && typeof a.reviewCheckout === "function" &&
    typeof a.placeOrder === "function";
}

function findAdapter(mod: Record<string, unknown>, id: StoreId): StoreAdapter | undefined {
  const named = [mod.default, mod[id], mod[`${id}Adapter`], mod.adapter];
  for (const c of named) if (isAdapter(c) && c.id === id) return c;
  for (const v of Object.values(mod)) if (isAdapter(v) && v.id === id) return v;
  return undefined;
}
