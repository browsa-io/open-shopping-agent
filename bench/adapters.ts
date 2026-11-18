// Load store adapters lazily, so the bench runs with whatever stores are installed.
// Order: src/stores/index.ts (getAdapter, loadAdapter, adapters map or default), then the store
// file src/stores/<id>.ts directly. A store that cannot be found is reported as "not installed".

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StoreAdapter } from "../src/stores/adapter.js";
import type { StoreId } from "../src/core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const STORES_DIR = join(here, "..", "src", "stores");

export type AdapterLoader = (store: StoreId) => Promise<StoreAdapter | undefined>;

function isAdapter(x: unknown, store: StoreId): x is StoreAdapter {
  const a = x as StoreAdapter;
  return !!a && typeof a === "object" && a.id === store && typeof a.search === "function";
}

/** Pull an adapter out of whatever shape a module exports. */
async function fromValue(v: unknown, store: StoreId): Promise<StoreAdapter | undefined> {
  if (!v) return undefined;
  if (isAdapter(v, store)) return v;
  if (typeof v === "function") {
    try {
      const r = await (v as (id: StoreId) => unknown)(store);
      if (isAdapter(r, store)) return r;
      const d = (r as { default?: unknown })?.default;
      if (isAdapter(d, store)) return d;
    } catch { /* not a loader */ }
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function importIfPresent(base: string): Promise<Record<string, unknown> | undefined> {
  for (const ext of [".ts", ".js"]) {
    const file = base + ext;
    if (await exists(file)) return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  }
  return undefined;
}

export function defaultLoader(storesDir = STORES_DIR): AdapterLoader {
  let indexMod: Promise<Record<string, unknown> | undefined> | undefined;
  return async (store) => {
    indexMod ??= importIfPresent(join(storesDir, "index")).catch(() => undefined);
    const idx = await indexMod;
    if (idx) {
      for (const name of ["loadAdapter", "getAdapter"]) {
        const a = await fromValue(idx[name], store);
        if (a) return a;
      }
      for (const name of ["adapters", "ADAPTERS", "registry", "default"]) {
        const m = idx[name] as Record<string, unknown> | undefined;
        if (m && typeof m === "object") {
          const a = await fromValue(m[store], store);
          if (a) return a;
          if (m instanceof Map) { const b = await fromValue(m.get(store), store); if (b) return b; }
        }
      }
    }
    const mod = await importIfPresent(join(storesDir, store));
    if (!mod) return undefined;
    for (const v of [mod.default, mod[store], mod[`${store}Adapter`], mod.adapter, ...Object.values(mod)]) {
      if (isAdapter(v, store)) return v;
    }
    return undefined;
  };
}
