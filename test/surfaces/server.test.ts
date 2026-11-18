import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { RunEvent } from "../../src/core/types.js";
import { FileAlerts } from "../../src/web/alerts-port.js";
import { ConfigStore } from "../../src/web/config.js";
import { MockEngine } from "../../src/web/mock-engine.js";
import { createApp } from "../../src/web/server.js";
import { RunHub } from "../../src/web/session.js";

let dir: string;
let base: string;
let close: () => Promise<void>;

async function startApp(token?: string) {
  const hub = new RunHub(new MockEngine({ speed: 0, signInStore: null, failStore: "target" }));
  const server = createApp({ hub, alerts: new FileAlerts(join(dir, "watches.json")), config: new ConfigStore(dir), token });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "osa-web-"));
  delete process.env.BROWSA_API_KEY;
  delete process.env.OSA_LLM_API_KEY;
  const app = await startApp();
  base = app.url;
  close = app.close;
});
after(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const json = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(base + path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** Read SSE "run" events until test() is true. */
function readEvents(path: string, test: (events: RunEvent[], gates: { step: string; store: string; open: boolean }[]) => boolean): Promise<{ events: RunEvent[]; gates: { step: string; store: string; open: boolean }[] }> {
  return new Promise((resolve, reject) => {
    const events: RunEvent[] = [];
    const gates: { step: string; store: string; open: boolean }[] = [];
    const req = httpRequest(base + path, (res) => {
      assert.match(String(res.headers["content-type"]), /text\/event-stream/);
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (\w+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue;
          if (ev === "run") events.push(JSON.parse(data));
          if (ev === "gate") gates.push(JSON.parse(data));
        }
        if (test(events, gates)) {
          req.destroy();
          resolve({ events, gates });
        }
      });
    });
    req.on("error", (e) => (e.message.includes("aborted") || (e as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(e)));
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error("SSE timeout")); });
    req.end();
  });
}

test("serves the app shell with security headers", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Open Shopping Agent/);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  const js = await fetch(base + "/app.js");
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  const traversal = await fetch(base + "/..%2f..%2fpackage.json");
  assert.ok(traversal.status === 403 || traversal.status === 404 || (await traversal.text()).includes("Open Shopping Agent"));
});

test("meta says demo", async () => {
  const { body } = await json("/api/meta");
  assert.equal(body.demo, true);
});

test("settings mask keys and keep them server side", async () => {
  const put = await json("/api/settings", { method: "PUT", body: JSON.stringify({ browsaApiKey: "bk_live_1234567890abcdef", zip: "82001", budget: "60", allowedStores: ["amazon", "ebay"] }) });
  assert.equal(put.status, 200);
  assert.equal(put.body.hasBrowsaApiKey, true);
  assert.ok(!JSON.stringify(put.body).includes("1234567890"));
  assert.equal(put.body.browsaApiKey, "bk_l••••cdef");
  assert.deepEqual(put.body.allowedStores, ["amazon", "ebay"]);
  assert.equal(put.body.budget.cents, 6000);
  // a masked or empty key on save keeps the stored key
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ browsaApiKey: "bk_l••••cdef", llmApiKey: "" }) });
  const file = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.equal(file.browsaApiKey, "bk_live_1234567890abcdef");
  const bad = await json("/api/settings", { method: "PUT", body: JSON.stringify({ zip: "abc" }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /ZIP/);
  // restore all stores for the run tests
  await json("/api/settings", { method: "PUT", body: JSON.stringify({ allowedStores: ["amazon", "walmart", "ebay", "target"], budget: null }) });
});

test("settings: own proxy is saved, shown as host:port only, validated and cleared", async () => {
  const put = await json("/api/settings", { method: "PUT", body: JSON.stringify({ proxy: "http://me:s3cret@10.1.2.3:8080" }) });
  assert.equal(put.status, 200);
  assert.equal(put.body.hasProxy, true);
  assert.equal(put.body.proxy, "10.1.2.3:8080");
  assert.ok(!JSON.stringify(put.body).includes("s3cret"));
  const file = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  assert.equal(file.proxy, "http://me:s3cret@10.1.2.3:8080");
  const bad = await json("/api/settings", { method: "PUT", body: JSON.stringify({ proxy: "nonsense" }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /OSA_PROXY must look like/);
  const cleared = await json("/api/settings", { method: "PUT", body: JSON.stringify({ proxy: null }) });
  assert.equal(cleared.body.hasProxy, false);
});

test("the stylesheet lets the hidden attribute win (no Demo data badge on real runs)", async () => {
  const css = await (await fetch(base + "/app.css")).text();
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test("refuses cross-origin writes and non-JSON bodies", async () => {
  const cross = await fetch(base + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ prompt: "x" }) });
  assert.equal(cross.status, 403);
  const form = await fetch(base + "/api/runs", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "prompt=x" });
  assert.equal(form.status, 415);
});

test("run over the API: SSE stream, gates, approval", async () => {
  const empty = await json("/api/runs", { method: "POST", body: JSON.stringify({ prompt: "  " }) });
  assert.equal(empty.status, 400);
  const created = await json("/api/runs", { method: "POST", body: JSON.stringify({ prompt: "usb-c hub and 6 ft hdmi under $60", zip: "82001" }) });
  assert.equal(created.status, 201);
  const id = created.body.runId as string;

  const first = await readEvents(`/api/runs/${id}/events`, (_e, g) => g.some((x) => x.step === "cart" && x.open));
  assert.equal(first.events[0].type, "parsed");
  assert.ok(first.events.some((e) => e.type === "store_failed" && e.store === "target"));
  const picks = first.events.find((e): e is Extract<RunEvent, { type: "picks" }> => e.type === "picks")!;
  assert.ok(picks.picks.length >= 1);

  const rec = await json(`/api/runs/${id}`);
  assert.equal(rec.status, 200);
  assert.ok(rec.body.gates.length >= 1);
  const stores: string[] = [...new Set<string>(rec.body.gates.map((g: { store: string }) => g.store))];

  const badStep = await json(`/api/runs/${id}/confirm`, { method: "POST", body: JSON.stringify({ step: "pay", store: stores[0], yes: true }) });
  assert.equal(badStep.status, 400);
  for (const s of stores) {
    const r = await json(`/api/runs/${id}/confirm`, { method: "POST", body: JSON.stringify({ step: "cart", store: s, yes: true }) });
    assert.equal(r.status, 200);
  }
  const again = await json(`/api/runs/${id}/confirm`, { method: "POST", body: JSON.stringify({ step: "cart", store: stores[0], yes: true }) });
  assert.equal(again.status, 409);

  await readEvents(`/api/runs/${id}/events`, (_e, g) => stores.every((s) => g.some((x) => x.step === "checkout" && x.store === s && x.open)));
  await json(`/api/runs/${id}/confirm`, { method: "POST", body: JSON.stringify({ step: "checkout", store: stores[0], yes: true }) });
  for (const s of stores.slice(1)) await json(`/api/runs/${id}/confirm`, { method: "POST", body: JSON.stringify({ step: "checkout", store: s, yes: false }) });

  const { events } = await readEvents(`/api/runs/${id}/events`, (e) => e.some((x) => x.type === "awaiting_approval"));
  const waiting = events.find((e): e is Extract<RunEvent, { type: "awaiting_approval" }> => e.type === "awaiting_approval")!;
  const wrong = await json(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ store: waiting.store, approvedTotal: { cents: waiting.review.total.cents + 100, currency: "USD" } }) });
  assert.equal(wrong.status, 409);
  const ok = await json(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ store: waiting.store, approvedTotal: waiting.review.total }) });
  assert.equal(ok.status, 200);
  const done = await readEvents(`/api/runs/${id}/events`, (e) => e.some((x) => x.type === "done"));
  const order = done.events.find((e): e is Extract<RunEvent, { type: "order" }> => e.type === "order")!;
  assert.equal(order.result.placed, true);

  const list = await json("/api/runs");
  assert.ok(list.body.some((r: { runId: string }) => r.runId === id));
  assert.equal((await json("/api/runs/nope")).status, 404);
});

test("SSE resumes after Last-Event-ID", async () => {
  const { body } = await json("/api/runs", { method: "POST", body: JSON.stringify({ prompt: "usb-c hub", checkout: false }) });
  const all = await readEvents(`/api/runs/${body.runId}/events`, (e) => e.some((x) => x.type === "done"));
  const rest = await new Promise<string>((resolve) => {
    const req = httpRequest(`${base}/api/runs/${body.runId}/events`, { headers: { "Last-Event-ID": String(all.events.length - 2) } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        buf += c;
        if (buf.includes('"type":"done"')) { req.destroy(); resolve(buf); }
      });
    });
    req.on("error", () => undefined);
    req.end();
  });
  assert.equal((rest.match(/^event: run$/gm) ?? []).length, 1);
});

test("watches: create, list, delete", async () => {
  const bad = await json("/api/watches", { method: "POST", body: JSON.stringify({ kind: "price_drop", item: "hdmi" }) });
  assert.equal(bad.status, 400);
  const made = await json("/api/watches", { method: "POST", body: JSON.stringify({ kind: "price_drop", item: "6 ft hdmi cable", below: "7.99" }) });
  assert.equal(made.status, 201);
  assert.equal(made.body.below.cents, 799);
  const stock = await json("/api/watches", { method: "POST", body: JSON.stringify({ kind: "back_in_stock", item: "usb-c hub" }) });
  assert.equal(stock.status, 201);
  const list = await json("/api/watches");
  assert.equal(list.body.length, 2);
  assert.equal((await json(`/api/watches/${made.body.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await json(`/api/watches/${made.body.id}`, { method: "DELETE" })).status, 404);
});

test("token mode: 401 without it, cookie after ?token=", async () => {
  const app = await startApp("s3cret-token");
  try {
    assert.equal((await fetch(app.url + "/api/meta")).status, 401);
    assert.equal((await fetch(app.url + "/api/health")).status, 200);
    const hop = await fetch(app.url + "/?token=s3cret-token", { redirect: "manual" });
    assert.equal(hop.status, 302);
    const cookie = hop.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    const res = await fetch(app.url + "/api/meta", { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(res.status, 200);
    assert.equal((await fetch(app.url + "/api/meta", { headers: { Authorization: "Bearer s3cret-token" } })).status, 200);
  } finally {
    await app.close();
  }
});
