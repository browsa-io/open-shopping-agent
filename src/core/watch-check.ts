// The alerts CheckFn on the store registry: a watch with a query runs adapter.search on each of its
// stores, a watch with a product url runs adapter.details on that page. Each store gets a fresh
// Phantom browser (a burner: nothing kept, about 1 credit), opened one after another and always
// stopped. A missing adapter fails only that store; the check fails when no store answered.

import type { ItemRequest, Offer, StoreId } from "./types.js";
import type { StoreAdapter } from "../stores/adapter.js";
import { loadAdapter, STORE_NAMES } from "../stores/index.js";
import { BrowserPool, defaultDomain, type BrowsaClient, type StoreBrowser } from "./browsers.js";
import { LimitError } from "./limits.js";
import { errText, withTimeout } from "./engine.js";
import type { CheckFn, Watch } from "../alerts/types.js";
import { storeFromUrl } from "../alerts/store.js";
import { markCurrency } from "./rank.js";
import { currencyNote } from "../stores/util.js";

export interface WatchCheckOptions {
  /** Browsa API key. Default: BROWSA_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  client?: BrowsaClient;
  dataDir?: string;
  /** Use these adapters instead of the registry (tests). */
  adapters?: Partial<Record<StoreId, StoreAdapter>>;
  /** Open a store's browser (tests). Default: a burner on Browsa. */
  openBrowser?: (store: StoreId, domain: string) => Promise<StoreBrowser>;
  /** Offers asked per store. Default 8. */
  searchLimit?: number;
  /** Most credits one check may spend across its stores. Default 15. */
  maxCredits?: number;
  /** Most time one adapter call may take. Default 2 minutes. */
  stepTimeoutMs?: number;
  zip?: string;
  log?: (message: string) => void;
}

export function createWatchCheck(o: WatchCheckOptions = {}): CheckFn {
  return async (watch: Watch, signal?: AbortSignal): Promise<Offer[]> => {
    const max = o.maxCredits ?? 15;
    let spent = 0;
    const spend = async (n: number, what: string): Promise<number> => {
      if (spent + n > max) throw new LimitError("credits", `${what} would pass the ${max} credit cap of a watch check`);
      spent += n;
      return n;
    };
    const log = (m: string) => o.log?.(`watch ${watch.id}: ${m}`);
    const pool = o.openBrowser ? undefined : new BrowserPool({
      apiKey: o.apiKey ?? process.env.BROWSA_API_KEY ?? "", baseUrl: o.baseUrl ?? process.env.BROWSA_BASE_URL, client: o.client,
      dataDir: o.dataDir ?? ".osa", mode: "burner", aiMaxCredits: 5, spend, log: (s, m) => log(`${STORE_NAMES[s]}: ${m}`),
    });
    const offers: Offer[] = [];
    const errors: string[] = [];
    try {
      for (const t of targets(watch)) {
        if (signal?.aborted) break;
        try {
          offers.push(...(await checkOne(t.store, t.domain)));
        } catch (e) {
          errors.push(`${STORE_NAMES[t.store]}: ${errText(e)}`);
          log(`${STORE_NAMES[t.store]} failed: ${errText(e)}`);
        }
      }
    } finally {
      await pool?.closeAll();
    }
    if (!offers.length && errors.length) throw new Error(errors.join("; "));
    return offers;

    /**
     * Mark offers the store priced in another currency (they never count for a watch). When every
     * offer is in another currency the check fails with the plain reason, not "none in stock".
     */
    function usdOnly(store: StoreId, domain: string, list: Offer[]): Offer[] {
      const { offers: marked, shown } = markCurrency(list, watch.targetPrice?.currency ?? "USD");
      if (!shown.length) return marked;
      const note = currencyNote(store === "shopify" ? domain : STORE_NAMES[store], shown.join(", "));
      if (marked.every((x) => x.currencyMismatch)) throw new Error(note);
      log(note);
      return marked;
    }

    async function checkOne(store: StoreId, domain: string): Promise<Offer[]> {
      // Load the adapter first, so a missing one costs no browser.
      const adapter = o.adapters?.[store] ?? await loadAdapter(store);
      if (watch.url && !adapter.details) throw new Error(`the ${STORE_NAMES[store]} adapter cannot read product pages`);
      const browser = o.openBrowser ? await o.openBrowser(store, domain) : await pool!.openStore(store, domain);
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const ctx = browser.context(domain, { zip: o.zip, signal: abort.signal, log: (m) => log(`${STORE_NAMES[store]}: ${m}`) });
        const step = o.stepTimeoutMs ?? 120_000;
        if (watch.url) {
          const stub: Offer = { store, storeDomain: domain, itemId: "watch", title: watch.label ?? "", url: watch.url, price: { cents: 0, currency: "USD" }, inStock: false };
          const d = await withTimeout(adapter.details!(ctx, stub), step, "reading the product page");
          if (!d || !d.price || !Number.isFinite(d.price.cents) || d.price.cents <= 0) throw new Error("the product page showed no price");
          return usdOnly(store, domain, [{ ...stub, ...d, store, storeDomain: d.storeDomain || domain, itemId: "watch" }]);
        }
        const item: ItemRequest = { id: "watch", query: watch.query!, description: watch.label ?? watch.query!, quantity: 1 };
        const found = await withTimeout(adapter.search(ctx, item, o.searchLimit ?? 8), step, `searching ${STORE_NAMES[store]}`);
        return usdOnly(store, domain, (Array.isArray(found) ? found : [])
          .filter((x) => x && typeof x.title === "string" && x.price && Number.isFinite(x.price.cents) && typeof x.inStock === "boolean")
          .map((x) => ({ ...x, store, storeDomain: x.storeDomain || domain, itemId: "watch" })));
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await browser.close().catch(() => {});
      }
    }
  };
}

/** The (store, domain) pairs a watch looks at. */
export function targets(watch: Watch): { store: StoreId; domain: string }[] {
  if (watch.url) {
    const store = watch.stores[0] ?? storeFromUrl(watch.url);
    const host = new URL(watch.url).hostname.replace(/^www\./, "");
    return [{ store, domain: store === "shopify" ? host : defaultDomain(store) }];
  }
  return watch.stores.flatMap((s): { store: StoreId; domain: string }[] => (s === "shopify" ? (watch.shopifyDomains ?? []).map((d) => ({ store: s, domain: d })) : [{ store: s, domain: defaultDomain(s) }]));
}
