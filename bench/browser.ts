// One Phantom browser per store for the bench, from the engine's browser code (BrowserPool in
// burner mode): a fresh browser, Playwright over CDP, the StoreContext the adapters expect, and the
// browser destroyed afterwards.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "browsa";
import { BrowserPool } from "../src/core/browsers.js";
import { CreditMeter, type SpendEvent } from "../src/core/credits.js";
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
  /** Counts the run's own credits and keeps it under the cap (benchMeter). */
  meter?: CreditMeter;
}

export function browsaClient(apiKey: string, baseUrl?: string): Client {
  return new Client({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

/**
 * The bench run's own credit meter, the same one a shopping run uses: it sums the ledger rows of
 * the browsers and AI tasks this bench created (else each browser's own totals, else an estimate
 * from browser time), so other runs on the account never count. It also refuses a browser or task
 * that would pass `max`.
 */
export function benchMeter(client: Client, max: number): CreditMeter {
  return new CreditMeter({
    ledger: async (limit) => (await client.listLedger({ limit })) as Record<string, any>,
    agent: (id) => client.getAgent(id),
  }, max);
}

export function browsaFactory(o: BrowsaFactoryOptions): ContextFactory {
  const pool = new BrowserPool({
    apiKey: o.apiKey, baseUrl: o.baseUrl, mode: "burner", aiLlm: o.llm ?? "browsa", aiMaxCredits: o.aiMaxCredits ?? 8,
    dataDir: join(tmpdir(), "osa-bench"),
    ...(o.meter ? { spend: (n: number, what: string) => o.meter!.spend(n, what), track: (e: SpendEvent) => o.meter!.track(e) } : {}),
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
