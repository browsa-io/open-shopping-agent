// The Browsa provider: Phantom browsers on Browsa, exactly as browsers.ts opens them (saved
// profiles, fresh browsers or sessions; exit per store; AI fallback as a Browsa task; Phantom Live).
// It only wraps BrowserPool and adds the provider fields; the logic stays in browsers.ts.

import type { StoreId } from "../types.js";
import { BrowserPool, defaultDomain, type BrowserPoolOptions } from "../browsers.js";
import { BROWSA_CAPABILITIES, PROVIDER_LABELS, type BrowserCapabilities, type BrowserProvider, type OpenOptions, type ProviderBrowser } from "./types.js";

/** The part of BrowserPool the provider calls (tests pass a fake). */
export type PoolLike = Pick<BrowserPool, "openStore" | "closeAll">;

export class BrowsaProvider implements BrowserProvider {
  readonly id = "browsa" as const;
  readonly label = PROVIDER_LABELS.browsa;
  readonly capabilities: BrowserCapabilities = { ...BROWSA_CAPABILITIES };
  private pool?: PoolLike;

  /** A BrowserPool, its options, or a factory (made on first open). */
  constructor(private readonly source?: PoolLike | BrowserPoolOptions | (() => PoolLike)) {}

  get poolOrUndefined(): PoolLike | undefined { return this.pool; }

  private getPool(): PoolLike {
    if (this.pool) return this.pool;
    const s = this.source;
    if (typeof s === "function") this.pool = s();
    else if (s && typeof (s as PoolLike).openStore === "function") this.pool = s as PoolLike;
    else this.pool = new BrowserPool((s as BrowserPoolOptions) ?? { apiKey: process.env.BROWSA_API_KEY ?? "" });
    return this.pool;
  }

  async open(store: StoreId, opts: OpenOptions = {}): Promise<ProviderBrowser> {
    const sb = await this.getPool().openStore(store, opts.domain || defaultDomain(store));
    return Object.assign(sb, { provider: "browsa" as const, capabilities: this.capabilities });
  }

  async closeAll(): Promise<void> {
    await this.pool?.closeAll();
  }
}
