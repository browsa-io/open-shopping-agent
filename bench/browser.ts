// One Phantom browser per store for the bench, from the engine's browser code (BrowserPool in
// burner mode): a fresh browser, Playwright over CDP, the StoreContext the adapters expect, and the
// browser destroyed afterwards.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "browsa";
import { BrowserPool } from "../src/core/browsers.js";
import type { StoreContext } from "../src/stores/adapter.js";
import type { StoreId } from "../src/core/types.js";

export interface OpenedStore {
  ctx: StoreContext;
  close(): Promise<void>;
}

export type ContextFactory = (store: StoreId, domain: string, opts: { zip?: string; log: (m: string) => void; signal: AbortSignal }) => Promise<OpenedStore>;

export interface BrowsaFactoryOptions {
  apiKey: string;
  baseUrl?: string;
  /** Allow the adapters' AI fallback (a Browsa agent task). Default true. */
  ai?: boolean;
  /** Credit cap of each AI fallback task. */
  aiMaxCredits?: number;
  llm?: string;
}

export function browsaClient(apiKey: string, baseUrl?: string): Client {
  return new Client({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

/** Credits left on the key's workspace, or undefined when the API does not say. */
export async function creditBalance(client: Client): Promise<number | undefined> {
  try {
    const r = await client.credits();
    const n = Number(r.balance ?? r.credits);
    return Number.isFinite(n) ? n : undefined;
  } catch { return undefined; }
}

export function browsaFactory(o: BrowsaFactoryOptions): ContextFactory {
  const pool = new BrowserPool({
    apiKey: o.apiKey, baseUrl: o.baseUrl, mode: "burner", aiLlm: o.llm ?? "browsa", aiMaxCredits: o.aiMaxCredits ?? 8,
    dataDir: join(tmpdir(), "osa-bench"),
  });
  return async (store, domain, { zip, log, signal }) => {
    const sb = await pool.openStore(store, domain);
    const base = sb.context(domain, { zip, signal, log: (m) => log(`${store}: ${m}`) });
    const ctx = {
      store, domain, zip, agentId: base.agentId, signal, log: base.log,
      get page() { return base.page; },
      newPage: () => base.newPage(),
      // The bench never hands the browser to a person.
      liveLink: async () => { throw new Error("live hand-off is off in the bench"); },
      aiTask: async <T>(task: string, opts?: { schema?: object; maxSteps?: number; startUrl?: string }): Promise<T> => {
        if (o.ai === false) throw new Error("AI fallback is off in this bench run");
        return base.aiTask<T>(task, { maxSteps: 15, ...opts });
      },
    } as StoreContext;
    return { ctx, close: () => sb.close() };
  };
}
