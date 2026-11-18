import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Offer } from "../../src/core/types.js";

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "osa-alerts-"));
}

export function offer(cents: number, extra: Partial<Offer> = {}): Offer {
  return {
    store: "walmart", storeDomain: "walmart.com", itemId: "item-1",
    title: "Example 27 inch 4K Monitor", url: "https://www.walmart.com/ip/123",
    productId: "123", price: { cents, currency: "USD" }, inStock: true, condition: "new",
    ...extra,
  };
}

export interface Received { method: string; url: string; headers: IncomingMessage["headers"]; body: string }

/** A local HTTP server that records requests and answers `status`. */
export async function recorder(status = 200): Promise<{ url: string; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.statusCode = status;
      res.end(status < 300 ? "ok" : "nope");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
