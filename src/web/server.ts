// The web app server: Node http, no framework. Serves the static UI from web/ and a small JSON API,
// with Server-Sent Events for the RunEvent stream. Binds to 127.0.0.1 by default; on any other
// host it requires an access token (OSA_WEB_TOKEN, or a random one printed at start).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Money, StoreId } from "../core/types.js";
import type { AlertsPort } from "./alerts-port.js";
import { validateWatch } from "./alerts-port.js";
import { ConfigStore, osaHome } from "./config.js";
import { checkFor, createAlerts, createEngine } from "./engine-factory.js";
import { browserMeta, testModelKey, testProxyFromSettings } from "./byok-api.js";
import type { EnginePort } from "./engine-port.js";
import { STORE_IDS, dollarsToMoney } from "./format.js";
import { parseChoices } from "./plan.js";
import { HubError, RunHub, type HubMessage } from "./session.js";

export const VERSION = "0.1.0";

export const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json",
};

export interface AppOptions {
  hub: RunHub;
  alerts: AlertsPort;
  config: ConfigStore;
  webRoot?: string;
  /** When set, every request needs it (cookie osa_token, Authorization: Bearer, or ?token= once). */
  token?: string;
  /** Called after settings change: the engine for new runs (real once a key is saved). */
  reloadEngine?: () => Promise<EnginePort>;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "frame-src 'self' https://*.browsa.io https://browsa.io; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

async function readJson(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new HubError(415, "Send JSON (Content-Type: application/json)");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HubError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HubError(400, "Invalid JSON");
  }
}

function asStore(v: unknown): StoreId {
  if (typeof v === "string" && STORE_IDS.includes(v as StoreId)) return v as StoreId;
  throw new HubError(400, "Unknown store");
}

function asMoney(v: unknown): Money | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "object" && Number.isInteger((v as Money).cents)) return { cents: (v as Money).cents, currency: (v as Money).currency || "USD" };
  if (typeof v === "number" || typeof v === "string") return dollarsToMoney(v);
  return undefined;
}

function tokenOk(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const cookie = /(?:^|;\s*)osa_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  const got = auth || (cookie ? decodeURIComponent(cookie) : "");
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(opts: AppOptions): Server {
  const { hub, alerts, config } = opts;
  const root = opts.webRoot ?? WEB_ROOT;

  async function serveStatic(res: ServerResponse, pathname: string) {
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) && file !== root) return send(res, 403, "Forbidden");
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error("not a file");
      const body = await readFile(file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        ...(rel === "demo-live.html" ? { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "default-src 'self'; style-src 'self'; frame-ancestors 'self'" } : {}),
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(body);
    } catch {
      // SPA fallback for unknown paths without an extension
      if (!extname(rel)) return serveStatic(res, "/");
      send(res, 404, "Not found");
    }
  }

  function sse(req: IncomingMessage, res: ServerResponse, runId: string, events: unknown[] | undefined) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const after = Number(req.headers["last-event-id"] ?? -1);
    let index = -1;
    const write = (m: HubMessage) => {
      if (m.kind === "event") {
        index++;
        if (index <= after) return;
        res.write(`id: ${index}\nevent: run\ndata: ${JSON.stringify(m.event)}\n\n`);
      } else {
        res.write(`event: gate\ndata: ${JSON.stringify({ ...m.gate, open: m.open })}\n\n`);
      }
    };
    if (events) {
      for (const e of events) write({ kind: "event", event: e as never });
      return; // history only; the client closes on "done"
    }
    const off = hub.subscribe(runId, write);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { off(); clearInterval(ping); });
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const p = url.pathname;
    const m = req.method ?? "GET";
    let mm: RegExpExecArray | null;

    if (p === "/api/health") return send(res, 200, { ok: true });
    if (p === "/api/meta" && m === "GET") {
      const c = await config.effective();
      return send(res, 200, { version: VERSION, demo: hub.engine.demo, alertsDemo: alerts.demo, canCheckWatches: !!alerts.check && !!checkFor(c), hasBrowsaApiKey: !!c.browsaApiKey, stores: STORE_IDS, ...browserMeta(c) });
    }
    if (p === "/api/settings" && m === "GET") return send(res, 200, await config.publicView());
    if (p === "/api/settings/test-key" && m === "POST") return send(res, 200, await testModelKey(await readJson(req), await config.effective()));
    if (p === "/api/settings/test-proxy" && m === "POST") return send(res, 200, await testProxyFromSettings(await readJson(req), await config.effective()));
    if (p === "/api/settings" && m === "PUT") {
      const body = await readJson(req);
      try {
        await config.update(body);
      } catch (e) {
        throw new HubError(400, (e as Error).message);
      }
      if (opts.reloadEngine) hub.setEngine(await opts.reloadEngine());
      return send(res, 200, await config.publicView());
    }
    if (p === "/api/runs" && m === "GET") return send(res, 200, await hub.list(Number(url.searchParams.get("limit") ?? 50)));
    if (p === "/api/runs" && m === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt || prompt.length > 500) throw new HubError(400, "Write what to buy (up to 500 characters)");
      const c = await config.effective();
      const stores = Array.isArray(body.stores) && body.stores.length ? body.stores.map(asStore) : c.allowedStores;
      const budget = asMoney(body.budget) ?? c.budget;
      const zip = typeof body.zip === "string" && /^\d{5}$/.test(body.zip) ? body.zip : c.zip;
      const run = hub.start(prompt, {
        limits: { allowedStores: stores, budget }, zip, shopifyDomains: c.shopifyDomains, checkout: body.checkout !== false,
        everyStore: body.everyStore === true,
      });
      return send(res, 201, { runId: run.runId });
    }
    if ((mm = /^\/api\/runs\/([\w.-]+)$/.exec(p)) && m === "GET") {
      const r = await hub.record(mm[1]);
      return r ? send(res, 200, r) : send(res, 404, { error: "Run not found" });
    }
    if ((mm = /^\/api\/runs\/([\w.-]+)\/events$/.exec(p)) && m === "GET") {
      const id = mm[1];
      if (hub.get(id)) return sse(req, res, id, undefined);
      const r = await hub.record(id);
      if (!r) return send(res, 404, { error: "Run not found" });
      return sse(req, res, id, r.events);
    }
    if ((mm = /^\/api\/runs\/([\w.-]+)\/confirm$/.exec(p)) && m === "POST") {
      const b = (await readJson(req)) as Record<string, unknown>;
      const step = b.step === "cart" || b.step === "checkout" ? b.step : null;
      if (!step) throw new HubError(400, "step must be cart or checkout");
      const ok = hub.answer(mm[1], step, asStore(b.store), b.yes === true);
      return ok ? send(res, 200, { ok: true }) : send(res, 409, { error: "That step is not waiting for an answer" });
    }
    if ((mm = /^\/api\/runs\/([\w.-]+)\/fill$/.exec(p)) && m === "POST") {
      const b = (await readJson(req)) as Record<string, unknown>;
      let choices;
      try {
        choices = b.plan === undefined ? undefined : parseChoices(b.plan);
      } catch (e) {
        throw new HubError(400, (e as Error).message);
      }
      return send(res, 200, { ok: true, stores: await hub.fillCarts(mm[1], choices) });
    }
    if ((mm = /^\/api\/runs\/([\w.-]+)\/approve$/.exec(p)) && m === "POST") {
      const b = (await readJson(req)) as Record<string, unknown>;
      const total = asMoney(b.approvedTotal);
      if (!total) throw new HubError(400, "approvedTotal is required");
      await hub.approve(mm[1], asStore(b.store), total);
      return send(res, 200, { ok: true });
    }
    if ((mm = /^\/api\/runs\/([\w.-]+)\/cancel$/.exec(p)) && m === "POST") {
      const b = (await readJson(req)) as Record<string, unknown>;
      await hub.cancel(mm[1], b.store === undefined ? undefined : asStore(b.store));
      return send(res, 200, { ok: true });
    }
    if (p === "/api/watches" && m === "GET") return send(res, 200, await alerts.list());
    if (p === "/api/watches" && m === "POST") {
      const b = (await readJson(req)) as Record<string, unknown>;
      let input;
      try {
        input = validateWatch({ ...b, below: asMoney(b.below) });
      } catch (e) {
        throw new HubError(400, (e as Error).message);
      }
      try {
        return send(res, 201, await alerts.create(input));
      } catch (e) {
        throw new HubError(400, (e as Error).message);
      }
    }
    if ((mm = /^\/api\/watches\/([\w-]+)\/check$/.exec(p)) && m === "POST") {
      if (!alerts.check) throw new HubError(409, "Watches cannot be checked here");
      try {
        return send(res, 200, await alerts.check(mm[1]));
      } catch (e) {
        const msg = (e as Error).message;
        throw new HubError(msg === "Watch not found" ? 404 : 409, msg);
      }
    }
    if ((mm = /^\/api\/watches\/([\w-]+)$/.exec(p)) && m === "DELETE") {
      return (await alerts.remove(mm[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Watch not found" });
    }
    return send(res, 404, { error: "Not found" });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (opts.token) {
        const q = url.searchParams.get("token");
        if (q && q === opts.token) {
          url.searchParams.delete("token");
          res.writeHead(302, {
            "Set-Cookie": `osa_token=${encodeURIComponent(q)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
            Location: url.pathname + (url.search || ""),
          });
          return res.end();
        }
        if (url.pathname !== "/api/health" && !tokenOk(req, opts.token)) {
          return send(res, 401, url.pathname.startsWith("/api/") ? { error: "Open the link with ?token= printed at start" } : "Open the link with ?token= printed when the server started.");
        }
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: "Cross-origin request refused" });
        }
        return await api(req, res, url);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      return await serveStatic(res, url.pathname);
    } catch (e) {
      const status = e instanceof HubError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Server error" : (e as Error).message });
      else res.end();
    }
  });
}

export interface StartWebOptions {
  port?: number;
  host?: string;
  demo?: boolean;
  open?: boolean;
}

const isLoopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "::1";

export async function startWebServer(o: StartWebOptions = {}): Promise<{ server: Server; url: string }> {
  const config = new ConfigStore();
  const choice = { demo: o.demo, demoLiveBase: "/demo-live.html" };
  const engine = await createEngine(await config.effective(), choice);
  const hub = new RunHub(engine);
  const host = o.host ?? process.env.HOST ?? "127.0.0.1";
  const port = o.port ?? Number(process.env.PORT ?? 4319);
  let token = process.env.OSA_WEB_TOKEN;
  if (!token && !isLoopback(host)) token = randomBytes(18).toString("base64url");
  const server = createApp({
    hub, alerts: createAlerts(osaHome(), config), config, token,
    reloadEngine: async () => createEngine(await config.effective(), choice),
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const shown = isLoopback(host) || host === "0.0.0.0" || host === "::" ? `http://localhost:${port}` : `http://${host}:${port}`;
  const url = token ? `${shown}/?token=${token}` : shown;
  return { server, url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWebServer().then(({ url }) => console.log(`Open Shopping Agent web app: ${url}`));
}
