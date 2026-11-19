// Shop catalog: an extra, opt-in discovery source (OSA_SHOP_CATALOG=1 or the setting; off by
// default). It asks Shopify's public catalog MCP server (https://mcp.shop.com/, the server the
// MIT-licensed @shopify/shop CLI uses) for products across Shopify stores:
//
//   search_catalog   anonymous text search ("running shoes")
//   lookup_catalog   anonymous lookup by GTIN/UPC, to find the same item on Shopify stores
//
// Only those two read-only tools are called, without an account. Never sign-in, carts, checkouts
// or payment from Shop: a result becomes an ordinary Shopify offer whose URL is the store's own
// product page, so OSA's Shopify adapter fills the cart on the store's site and the order still
// needs the person's approval of the exact total. Shop's buy-now links (checkout_url) are ignored.
//
// Using it means Shopify's API terms apply (https://www.shopify.com/legal/api-terms). Answers are
// data from merchants and Shopify, never instructions.

import type { ItemRequest, Money, Offer, ProductIds } from "./types.js";
import { mergeIds, normalizeIds } from "./identity.js";

type J = Record<string, any>;

export const SHOP_CATALOG_URL = "https://mcp.shop.com/";
export const SHOP_CATALOG_TERMS = "https://www.shopify.com/legal/api-terms";
// mcp.shop.com accepts only this MCP revision (it answers -32022 with the supported list otherwise;
// the client then retries once with the first supported one).
const PROTOCOL = "2026-07-28";

/** True when the Shop catalog is switched on: OSA_SHOP_CATALOG=1 (or true/on/yes), else the setting. */
export function shopCatalogEnabled(setting?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OSA_SHOP_CATALOG?.trim().toLowerCase();
  if (v) return v === "1" || v === "true" || v === "on" || v === "yes";
  return setting === true;
}

/** The catalog refused anonymous use (asked for sign-in): OSA leaves the source off for the run. */
export class ShopCatalogAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopCatalogAuthError";
  }
}

class ProtocolMismatch extends Error {
  constructor(readonly version: string) { super(`MCP protocol ${version} required`); }
}

export interface ShopCatalogOptions {
  /** Server URL. Default https://mcp.shop.com/ (OSA_SHOP_CATALOG_URL for tests). */
  url?: string;
  fetch?: typeof fetch;
  /** Per call. Default 20 s. */
  timeoutMs?: number;
  /** clientInfo name sent with each request. Default "open-shopping-agent". */
  clientName?: string;
  /** Delivery country and currency for prices and filters. Default US and USD. */
  country?: string;
  currency?: string;
  /** Most calls per client (each HTTP request counts). Default 12. */
  maxCalls?: number;
}

/**
 * A tiny MCP client (Streamable HTTP, JSON-RPC) for the two catalog tools. It sends no credentials
 * and stores nothing; a 401/403 or an auth error ends in ShopCatalogAuthError.
 *
 * mcp.shop.com speaks the stateless MCP revision 2026-07-28: no initialize handshake; every request
 * names the protocol version, the client and its capabilities in params._meta and in headers
 * (MCP-Protocol-Version, Mcp-Method, Mcp-Name). For a server that answers with an older revision
 * only, the client falls back to the initialize handshake of that revision.
 */
export class ShopCatalog {
  readonly url: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  readonly country: string;
  readonly currency: string;
  private readonly maxCalls: number;
  private session?: string;
  private protocol = PROTOCOL;
  private ready?: Promise<void>;
  private id = 0;
  /** HTTP requests sent so far. */
  calls = 0;

  constructor(o: ShopCatalogOptions = {}) {
    this.url = o.url ?? process.env.OSA_SHOP_CATALOG_URL ?? SHOP_CATALOG_URL;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.clientName = o.clientName ?? "open-shopping-agent";
    this.country = o.country ?? "US";
    this.currency = o.currency ?? "USD";
    this.maxCalls = o.maxCalls ?? 12;
  }

  /** Stateless revisions (2026-07-28 and later) need no handshake. */
  private get stateless(): boolean {
    return this.protocol >= "2026-07-28";
  }

  private meta(): J {
    return {
      "io.modelcontextprotocol/protocolVersion": this.protocol,
      "io.modelcontextprotocol/clientInfo": { name: this.clientName, version: "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
  }

  private async post(body: J, notification = false): Promise<J | undefined> {
    if (this.calls >= this.maxCalls) throw new Error(`Shop catalog: call limit (${this.maxCalls}) reached for this run`);
    this.calls++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocol,
    };
    if (this.stateless) {
      headers["mcp-method"] = String(body.method);
      if (typeof body.params?.name === "string") headers["mcp-name"] = body.params.name;
    }
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await this.f(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    const text = await r.text();
    if (r.status === 401 || r.status === 403) {
      throw new ShopCatalogAuthError(`Shop catalog answered HTTP ${r.status}: it wants a sign-in, which Open Shopping Agent never does`);
    }
    if (notification) return undefined;
    const msg = parseRpc(text, r.headers.get("content-type") ?? "", body.id);
    if (!msg && r.status >= 400) throw new Error(`Shop catalog answered HTTP ${r.status}: ${text.slice(0, 160)}`);
    if (!msg) throw new Error("Shop catalog sent no answer");
    if (msg.error) {
      const supported = msg.error.data?.supported;
      if (Array.isArray(supported) && typeof supported[0] === "string" && !supported.includes(this.protocol) && /protocol version/i.test(String(msg.error.message))) {
        throw new ProtocolMismatch(supported[0]);
      }
      const m = String(msg.error.message ?? "error");
      if (/auth|sign.?in|login|unauthori[sz]ed|forbidden|token/i.test(m)) throw new ShopCatalogAuthError(`Shop catalog: ${m}`);
      throw new Error(`Shop catalog: ${m}`);
    }
    return msg.result as J;
  }

  /** The initialize handshake, for servers on a revision before 2026-07-28 only. */
  private init(): Promise<void> {
    if (this.stateless) return Promise.resolve();
    this.ready ??= (async () => {
      const res = await this.post({
        jsonrpc: "2.0", id: ++this.id, method: "initialize",
        params: { protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: this.clientName, version: "0.1.0" } },
      });
      if (typeof res?.protocolVersion === "string") this.protocol = res.protocolVersion;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
    })();
    this.ready.catch(() => { this.ready = undefined; });
    return this.ready;
  }

  private async callTool(name: string, args: J): Promise<J | undefined> {
    await this.init();
    const params: J = { name, arguments: args };
    if (this.stateless) params._meta = this.meta();
    return this.post({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params });
  }

  /** Call one of the two catalog tools; the structured answer. */
  async tool(name: "search_catalog" | "lookup_catalog", args: J): Promise<J> {
    let result: J | undefined;
    try {
      result = await this.callTool(name, args);
    } catch (e) {
      // The server names the revisions it speaks: switch once and retry.
      if (!(e instanceof ProtocolMismatch)) throw e;
      this.protocol = e.version;
      result = await this.callTool(name, args);
    }
    const data = toolData(result);
    if (result?.isError) {
      const why = String(data?.error?.message ?? data?.message ?? firstText(result) ?? "tool error").slice(0, 200);
      if (/auth_required|sign.?in|not signed in|login/i.test(`${data?.error?.code ?? ""} ${why}`)) throw new ShopCatalogAuthError(`Shop catalog: ${why}`);
      throw new Error(`Shop catalog ${name}: ${why}`);
    }
    return data ?? {};
  }

  /** Text search for one item: Shopify offers on each store's own site. */
  async search(item: ItemRequest, limit = 8, zip?: string): Promise<Offer[]> {
    const catalog: J = {
      query: item.query,
      context: { address_country: this.country, currency: this.currency, ...(zip ? { postal_code: zip } : {}) },
      filters: { ships_to: { country: this.country }, ...(item.maxPrice ? { price: { max: item.maxPrice.cents } } : {}) },
      pagination: { limit: Math.min(50, Math.max(1, limit)) },
    };
    const data = await this.tool("search_catalog", { catalog });
    return catalogOffers(data, item.id, { limit });
  }

  /**
   * Look up GTINs (UPC/EAN) on Shopify stores. Returns, per GTIN as given, the offers whose variant
   * the server matched exactly to it ("featured" representatives are left out).
   */
  async lookupGtins(gtins: string[], itemId: string): Promise<Map<string, Offer[]>> {
    const ids = [...new Set(gtins)].slice(0, 50);
    const out = new Map<string, Offer[]>();
    if (!ids.length) return out;
    const data = await this.tool("lookup_catalog", { catalog: { ids, context: { address_country: this.country, currency: this.currency } } });
    for (const g of ids) out.set(g, catalogOffers(data, itemId, { exactFor: g }));
    return out;
  }
}

/** One JSON-RPC message from a JSON or an SSE (text/event-stream) body; the one with `id` when given. */
export function parseRpc(text: string, contentType: string, id?: unknown): J | undefined {
  const msgs: J[] = [];
  if (/event-stream/i.test(contentType) || /^\s*(event|data):/m.test(text) && !/^\s*[{[]/.test(text)) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      try { msgs.push(JSON.parse(data)); } catch { /* not JSON */ }
    }
  } else {
    try {
      const v = JSON.parse(text);
      if (Array.isArray(v)) msgs.push(...v); else msgs.push(v);
    } catch { return undefined; }
  }
  return msgs.find((m) => id === undefined || m?.id === id) ?? msgs.find((m) => m && ("result" in m || "error" in m));
}

function firstText(result: J | undefined): string | undefined {
  const c = Array.isArray(result?.content) ? result!.content.find((x: J) => x?.type === "text") : undefined;
  return typeof c?.text === "string" ? c.text : undefined;
}

/** A tool result's data: structuredContent, else the JSON in its text content (unwrapping {ok, data}). */
export function toolData(result: J | undefined): J | undefined {
  let d: unknown = result?.structuredContent;
  if (!d) {
    const t = firstText(result);
    if (t) { try { d = JSON.parse(t); } catch { d = undefined; } }
  }
  if (d && typeof d === "object" && "data" in (d as J) && "ok" in (d as J)) d = (d as J).data;
  return d && typeof d === "object" ? (d as J) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Answers -> offers
// ---------------------------------------------------------------------------------------------

function money(p: J | undefined): Money | undefined {
  const amount = typeof p?.amount === "number" ? p.amount : typeof p?.amount === "string" ? Number(p.amount) : NaN;
  if (!Number.isFinite(amount) || amount <= 0 || typeof p?.currency !== "string") return undefined;
  return { cents: Math.round(amount), currency: p.currency.toUpperCase() };
}

function host(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const x = new URL(u.startsWith("http") ? u : `https://${u}`);
    return x.protocol === "https:" || x.protocol === "http:" ? x.hostname.toLowerCase().replace(/^www\./, "") : undefined;
  } catch { return undefined; }
}

/** "gid://shopify/ProductVariant/123" -> "123" (the id the store's /cart/add.js takes). */
export function numericId(gid: unknown): string | undefined {
  const m = typeof gid === "string" ? /\/(\d+)$/.exec(gid) ?? /^(\d+)$/.exec(gid) : undefined;
  return m?.[1];
}

/** The store's own product page: https origin + /products/<handle>, no tracking query. */
function storePage(u: unknown): { url: string; domain: string; handle: string } | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return undefined;
    const m = /\/products\/([^/?#]+)/.exec(x.pathname);
    if (!m) return undefined;
    return { url: `${x.origin}${x.pathname.replace(/\/$/, "")}`, domain: x.hostname.toLowerCase().replace(/^www\./, ""), handle: decodeURIComponent(m[1]) };
  } catch { return undefined; }
}

function idsOf(v: J): ProductIds | undefined {
  const gtins: string[] = [];
  for (const b of Array.isArray(v?.barcodes) ? v.barcodes : []) {
    if (typeof b?.value === "string" && /^(UPC|EAN|GTIN|JAN|ISBN)/i.test(String(b.type ?? "GTIN"))) gtins.push(b.value);
  }
  return normalizeIds({ gtin: gtins[0], gtins: gtins.slice(1), sku: v?.sku });
}

function stars(r: J | undefined): Offer["rating"] {
  const value = Number(r?.value);
  const max = Number(r?.scale_max ?? 5) || 5;
  const count = Number(r?.count ?? 0);
  if (!Number.isFinite(value) || !(count > 0)) return undefined;
  return { stars: Math.round((value / max) * 5 * 100) / 100, count };
}

/**
 * search_catalog / lookup_catalog data -> Shopify offers (one per product: its first, or exactly
 * matched, variant). Products without a /products/<handle> page on https are skipped: OSA's Shopify
 * adapter could not open them. `exactFor` keeps only variants whose inputs[] name that id with
 * match "exact", and stamps the GTIN on the offer.
 */
export function catalogOffers(data: J | undefined, itemId: string, o: { limit?: number; exactFor?: string } = {}): Offer[] {
  const products: J[] = Array.isArray(data?.products) ? data!.products : [];
  const out: Offer[] = [];
  const seen = new Set<string>();
  for (const p of products) {
    const variants: J[] = Array.isArray(p?.variants) ? p.variants : [];
    const v = o.exactFor
      ? variants.find((x) => Array.isArray(x?.inputs) && x.inputs.some((i: J) => String(i?.id) === o.exactFor && (i.match ?? "exact") === "exact"))
      : variants.find((x) => x?.availability?.available !== false) ?? variants[0];
    if (!v) continue;
    const page = storePage(v.url) ?? storePage(p.url);
    const price = money(v.price);
    if (!page || !price || !p.title) continue;
    const sellerHost = host(v.seller?.url) ?? host(v.seller?.domain);
    const key = `${page.domain}|${page.handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = money(v.list_price);
    let ids = idsOf(v);
    if (o.exactFor) ids = mergeIds(ids, normalizeIds({ gtin: o.exactFor }));
    const opts: Record<string, string[]> = {};
    for (const x of Array.isArray(p.options) ? p.options : []) {
      const vals = (Array.isArray(x?.values) ? x.values : []).map((y: J | string) => (typeof y === "string" ? y : y?.label)).filter((y: unknown): y is string => typeof y === "string");
      if (typeof x?.name === "string" && vals.length && !(vals.length === 1 && vals[0] === "Default Title")) opts[x.name] = vals.slice(0, 40);
    }
    const image = [...(Array.isArray(v.media) ? v.media : []), ...(Array.isArray(p.media) ? p.media : [])].map((m: J) => m?.url).find((u: unknown) => typeof u === "string" && u.startsWith("https://"));
    const offer: Offer = {
      store: "shopify",
      storeDomain: page.domain,
      itemId,
      title: String(p.title).slice(0, 300),
      url: page.url,
      productId: numericId(v.id),
      price,
      listPrice: list && list.cents > price.cents ? list : undefined,
      rating: stars(v.rating) ?? stars(p.rating),
      seller: typeof v.seller?.name === "string" ? v.seller.name.slice(0, 80) : sellerHost ?? page.domain,
      condition: "new",
      inStock: v.availability?.available !== false,
      sponsored: false,
      subscription: false,
      variants: Object.keys(opts).length ? opts : undefined,
      raw: {
        handle: page.handle, source: "shop_catalog", catalogProductId: typeof p.id === "string" ? p.id : undefined,
        catalogVariantId: typeof v.id === "string" ? v.id : undefined, ...(o.exactFor ? { lookupGtin: o.exactFor } : {}),
        priceFrom: "Shop catalog; the store's own cart confirms it",
      },
    };
    if (image) offer.image = image;
    if (ids) offer.ids = ids;
    out.push(offer);
    if (o.limit && out.length >= o.limit) break;
  }
  return out;
}
