// Bring your own proxies, on every browser provider. Free everywhere: Browsa gets them as its
// own-proxy option (they override the built-in exit), the local browser gets them as Playwright's
// launch proxy, and a CDP browser uses its own proxy (set it at your provider).
//
//   OSA_PROXY=http://user:pass@host:port          one proxy for every store
//   OSA_PROXY_AMAZON=socks5://host:1080            one store (AMAZON, WALMART, EBAY, BESTBUY, TARGET, SHOPIFY)
//   OSA_PROXIES=host1:8000,host2:8000              a small pool, rotated per store and run
//   OSA_PROXIES=@/path/proxies.txt                 the pool from a file, one proxy per line (# comments)
//
// Accepted forms: scheme://user:pass@host:port (http, https, socks5), host:port, and the common
// host:port:user:pass. Precedence per store: its own proxy, then OSA_PROXY, then the pool. Logs and
// the UI only ever show host:port.

import { readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { StoreId } from "../types.js";

export type ProxyScheme = "http" | "https" | "socks5";

export interface ProxySpec {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxySettings {
  /** One proxy for every store. */
  all?: string;
  /** A proxy per store; wins over `all`. */
  perStore?: Partial<Record<StoreId, string>>;
  /** A pool rotated per store and run, used when neither of the above is set for a store. */
  pool?: string[];
}

const STORES: StoreId[] = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"];

/** Parse one proxy. Throws a readable error that never repeats the password. */
export function parseProxy(text: string): ProxySpec {
  const t = text.trim();
  if (!t) throw new Error("the proxy is empty");
  const m = t.match(/^(?:([a-z0-9]+):\/\/)?(?:([^:@\s/]*)(?::([^@\s]*))?@)?([^\s/:@]+):(\d{1,5})\/?$/i);
  if (m) {
    const scheme = normScheme(m[1]);
    const port = Number(m[5]);
    if (!(port > 0 && port < 65536)) throw new Error(`proxy port ${m[5]} is out of range`);
    return clean({ scheme, host: m[4], port, username: dec(m[2]), password: dec(m[3]) });
  }
  // host:port:user:pass, as many proxy sellers list them.
  const parts = t.split(":");
  if (parts.length === 4 && /^\d{1,5}$/.test(parts[1])) {
    return clean({ scheme: "http", host: parts[0], port: Number(parts[1]), username: parts[2], password: parts[3] });
  }
  throw new Error("a proxy must look like http://user:pass@host:port, socks5://host:port, host:port or host:port:user:pass");
}

function normScheme(s: string | undefined): ProxyScheme {
  const x = (s ?? "http").toLowerCase();
  if (x === "http" || x === "https") return x;
  if (x === "socks5" || x === "socks5h" || x === "socks") return "socks5";
  throw new Error(`proxy scheme ${x} is not supported (use http, https or socks5)`);
}

function dec(s: string | undefined): string | undefined {
  if (s === undefined || s === "") return undefined;
  try { return decodeURIComponent(s); } catch { return s; }
}

function clean(p: ProxySpec): ProxySpec {
  if (!p.username) delete p.username;
  if (p.password === undefined) delete p.password;
  return p;
}

/** "host:port", never the user name or password. */
export function proxyLabel(p: ProxySpec | undefined): string | undefined {
  return p ? `${p.host}:${p.port}` : undefined;
}

/** Mask whatever proxy text the user typed: "socks5://host:port" with credentials dropped. */
export function maskProxyText(text: string | undefined): string {
  if (!text) return "";
  try {
    const p = parseProxy(text);
    return `${p.scheme}://${p.host}:${p.port}${p.username ? " (with login)" : ""}`;
  } catch { return "set"; }
}

/** Playwright's launch proxy. */
export function toPlaywrightProxy(p: ProxySpec): { server: string; username?: string; password?: string } {
  return { server: `${p.scheme}://${p.host}:${p.port}`, ...(p.username ? { username: p.username } : {}), ...(p.password !== undefined ? { password: p.password } : {}) };
}

/** Browsa's own-proxy form (ProxyConfig of npm `browsa`). */
export function toBrowsaProxy(p: ProxySpec): Record<string, unknown> {
  return { type: p.scheme, host: p.host, port: p.port, ...(p.username ? { username: p.username } : {}), ...(p.password !== undefined ? { password: p.password } : {}) };
}

/** Read the pool text: a comma or newline list, or "@file" / a path to a file with one per line. */
export function parsePoolText(text: string | undefined, read: (path: string) => string = (p) => readFileSync(p, "utf8")): string[] {
  const t = text?.trim();
  if (!t) return [];
  let body = t;
  if (t.startsWith("@")) body = read(t.slice(1));
  else if (/^[./~]/.test(t) && !/^[^/]+:\d+/.test(t)) body = read(t);
  return body.split(/[\n,]+/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
}

/** Proxy settings from the environment, on top of saved settings (the environment wins). */
export function proxySettingsFrom(env: Record<string, string | undefined> = process.env, saved: ProxySettings = {}): ProxySettings {
  const perStore: Partial<Record<StoreId, string>> = { ...(saved.perStore ?? {}) };
  for (const s of STORES) {
    const v = env[`OSA_PROXY_${s.toUpperCase()}`]?.trim();
    if (v) perStore[s] = v;
  }
  const poolText = env.OSA_PROXIES ?? env.OSA_PROXIES_FILE?.replace(/^(?!@)/, "@");
  const pool = poolText ? parsePoolText(poolText) : saved.pool ?? [];
  const all = env.OSA_PROXY?.trim() || saved.all;
  const out: ProxySettings = {};
  if (all) out.all = all;
  if (Object.keys(perStore).length) out.perStore = perStore;
  if (pool.length) out.pool = pool;
  return out;
}

export function hasProxies(s: ProxySettings | undefined): boolean {
  return !!s && (!!s.all || !!s.pool?.length || !!Object.keys(s.perStore ?? {}).length);
}

/** Quick check: a TCP connection to the proxy within the timeout. */
export function tcpCheck(p: ProxySpec, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host: p.host, port: p.port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export interface ProxyPlanOptions {
  /** Quick check for pool entries. Default: tcpCheck. */
  check?: (p: ProxySpec) => Promise<boolean>;
  /** Where the pool rotation starts in this run. Default: random. */
  start?: number;
  log?: (message: string) => void;
}

/**
 * The proxy of each store in one run. A store's own proxy wins, then the one for all stores, then
 * the pool: each store takes the next pool entry (the start moves every run), and an entry that
 * fails the quick check is skipped. A store keeps its proxy for the whole run.
 */
export class ProxyPlan {
  private readonly pool: ProxySpec[];
  private next: number;
  private readonly chosen = new Map<StoreId, Promise<ProxySpec | undefined>>();
  private readonly bad = new Set<number>();

  constructor(readonly settings: ProxySettings, private readonly o: ProxyPlanOptions = {}) {
    this.pool = (settings.pool ?? []).map((t) => parseProxy(t));
    this.next = this.pool.length ? Math.abs(Math.floor(o.start ?? Math.random() * this.pool.length)) % this.pool.length : 0;
    // Validate the fixed ones now, so a typo fails before any browser opens.
    if (settings.all) parseProxy(settings.all);
    for (const v of Object.values(settings.perStore ?? {})) if (v) parseProxy(v);
  }

  get empty(): boolean { return !hasProxies(this.settings); }

  /** The proxy for this store (undefined: none of the user's). */
  forStore(store: StoreId): Promise<ProxySpec | undefined> {
    let p = this.chosen.get(store);
    if (!p) {
      p = this.pick(store);
      this.chosen.set(store, p);
    }
    return p;
  }

  private async pick(store: StoreId): Promise<ProxySpec | undefined> {
    const own = this.settings.perStore?.[store];
    if (own) return parseProxy(own);
    if (this.settings.all) return parseProxy(this.settings.all);
    if (!this.pool.length) return undefined;
    const check = this.o.check ?? ((p: ProxySpec) => tcpCheck(p));
    for (let tries = 0; tries < this.pool.length; tries++) {
      const i = this.next;
      this.next = (this.next + 1) % this.pool.length;
      if (this.bad.has(i)) continue;
      const p = this.pool[i];
      if (await check(p).catch(() => false)) return p;
      this.bad.add(i);
      this.o.log?.(`proxy ${proxyLabel(p)} failed a quick check; skipped`);
    }
    throw new Error("every proxy in the pool failed a quick check");
  }
}

// ---------------------------------------------------------------------------------------------
// "Test proxy": the exit IP and country the proxy gives, through the proxy itself.

export interface ProxyTestResult {
  ok: boolean;
  proxy: string;          // host:port
  ip?: string;
  country?: string;
  ms?: number;
  error?: string;
}

/** Open a TCP tunnel to host:443 through the proxy (HTTP CONNECT or SOCKS5). */
export async function tunnel(p: ProxySpec, host: string, port: number, timeoutMs = 10_000): Promise<Socket> {
  const sock: Socket = p.scheme === "https"
    ? tlsConnect({ host: p.host, port: p.port, servername: p.host }) as unknown as Socket
    : netConnect({ host: p.host, port: p.port });
  sock.setTimeout(timeoutMs, () => sock.destroy(new Error("the proxy did not answer in time")));
  await new Promise<void>((res, rej) => {
    sock.once(p.scheme === "https" ? "secureConnect" : "connect", () => res());
    sock.once("error", rej);
  });
  const read = () => new Promise<Buffer>((res, rej) => {
    sock.once("data", res);
    sock.once("error", rej);
    sock.once("close", () => rej(new Error("the proxy closed the connection")));
  });
  if (p.scheme === "socks5") {
    const auth = !!p.username;
    sock.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
    const hello = await read();
    if (hello[0] !== 5 || hello[1] === 0xff) throw new Error("the SOCKS5 proxy refused the login methods");
    if (hello[1] === 2) {
      const u = Buffer.from(p.username ?? ""), w = Buffer.from(p.password ?? "");
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([w.length]), w]));
      const a = await read();
      if (a[1] !== 0) throw new Error("the SOCKS5 proxy refused the user name or password");
    }
    const h = Buffer.from(host);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
    const r = await read();
    if (r[1] !== 0) throw new Error(`the SOCKS5 proxy could not connect (code ${r[1]})`);
    return sock;
  }
  const authz = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password ?? ""}`).toString("base64")}\r\n` : "";
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authz}\r\n`);
  const head = (await read()).toString("latin1");
  const status = Number(head.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
  if (status === 407) throw new Error("the proxy refused the user name or password (HTTP 407)");
  if (status !== 200) throw new Error(`the proxy answered CONNECT with HTTP ${status || "?"}`);
  return sock;
}

/** GET https://<host><path> through the proxy and return the body. */
async function getThrough(p: ProxySpec, host: string, path: string, timeoutMs: number): Promise<string> {
  const raw = await tunnel(p, host, 443, timeoutMs);
  const tls = tlsConnect({ socket: raw, servername: host });
  tls.setTimeout(timeoutMs, () => tls.destroy(new Error("the exit did not answer in time")));
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    tls.once("secureConnect", () => tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: open-shopping-agent\r\nAccept: application/json\r\nConnection: close\r\n\r\n`));
    tls.on("data", (c) => chunks.push(c));
    tls.once("error", rej);
    tls.once("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const i = text.indexOf("\r\n\r\n");
      let body = i >= 0 ? text.slice(i + 4) : text;
      if (/transfer-encoding:\s*chunked/i.test(text.slice(0, i))) body = unchunk(body);
      res(body);
    });
  });
}

function unchunk(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf("\r\n", i);
    if (nl < 0) break;
    const n = parseInt(s.slice(i, nl), 16);
    if (!n) break;
    out += s.slice(nl + 2, nl + 2 + n);
    i = nl + 2 + n + 2;
  }
  return out;
}

/** Test one proxy: its exit IP and country (ipinfo.io through the proxy). */
export async function testProxy(text: string, o: { timeoutMs?: number; get?: (p: ProxySpec) => Promise<string> } = {}): Promise<ProxyTestResult> {
  let p: ProxySpec;
  try { p = parseProxy(text); } catch (e) { return { ok: false, proxy: "", error: (e as Error).message }; }
  const t0 = Date.now();
  try {
    const body = await (o.get ? o.get(p) : getThrough(p, "ipinfo.io", "/json", o.timeoutMs ?? 12_000));
    const j = JSON.parse(body) as { ip?: string; country?: string };
    return { ok: !!j.ip, proxy: proxyLabel(p)!, ip: j.ip, country: j.country, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, proxy: proxyLabel(p)!, error: scrub(String((e as Error)?.message ?? e), p) };
  }
}

/** Remove the proxy's password and user name from an error text. */
export function scrub(text: string, p: ProxySpec): string {
  let t = text;
  for (const s of [p.password, p.username]) if (s) t = t.split(s).join("***");
  return t;
}
