// A minimal SMTP client for alert emails: implicit TLS (port 465) or STARTTLS (587, 25),
// AUTH PLAIN or LOGIN, one plain-text message. Built on node:net and node:tls, no dependencies.
// It refuses to send a password over a connection that is not encrypted.

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { SmtpConfig } from "./types.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

interface Reply { code: number; lines: string[] }

/** Reads SMTP replies (multi-line "250-..." until "250 ...") from a socket. */
class ReplyReader {
  private buf = "";
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private queue: Reply[] = [];
  private failed: Error | null = null;
  private lines: string[] = [];

  constructor(private sock: Socket | TLSSocket) { this.attach(sock); }

  attach(sock: Socket | TLSSocket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", (e) => this.fail(e));
    sock.on("close", () => this.fail(new Error("smtp: connection closed")));
  }

  detach(sock: Socket | TLSSocket) { sock.removeAllListeners("data"); sock.removeAllListeners("error"); sock.removeAllListeners("close"); }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      const m = line.match(/^(\d{3})([ -])(.*)$/);
      if (!m) continue;
      this.lines.push(m[3]);
      if (m[2] === " ") {
        const reply = { code: Number(m[1]), lines: this.lines };
        this.lines = [];
        if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(reply); } else this.queue.push(reply);
      }
    }
  }

  private fail(e: Error) {
    if (this.failed) return;
    this.failed = e;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(e); }
  }

  next(timeoutMs: number): Promise<Reply> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting = null; reject(new Error("smtp: timed out waiting for the server")); }, timeoutMs);
      this.waiting = {
        resolve: (r) => { clearTimeout(t); resolve(r); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
    });
  }
}

/** RFC 2047 encoded-word for a non-ASCII header value. */
function encodeHeader(v: string): string {
  const clean = v.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function addressOnly(a: string): string {
  const m = a.match(/<([^>]+)>/);
  const addr = (m ? m[1] : a).trim();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(addr)) throw new Error(`smtp: not an email address: ${a}`);
  return addr;
}

/** The full message (headers + base64 body), CRLF line ends. */
export function buildMessage(from: string, msg: MailMessage, date = new Date()): string {
  const domain = addressOnly(from).split("@")[1];
  const body = Buffer.from(msg.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${from.replace(/[\r\n]/g, "")}`,
    `To: ${msg.to.replace(/[\r\n]/g, "")}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "X-Mailer: open-shopping-agent",
    "",
    body,
  ].join("\r\n");
}

export async function sendMail(cfg: SmtpConfig, msg: MailMessage): Promise<void> {
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const secure = cfg.secure ?? cfg.port === 465;
  const from = addressOnly(cfg.from);
  const to = addressOnly(msg.to);
  const helo = cfg.heloName || hostname() || "localhost";
  const tlsOpts = { servername: cfg.host, ...(cfg.tls ?? {}) };

  let sock: Socket | TLSSocket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
    const s = secure
      ? tlsConnect({ host: cfg.host, port: cfg.port, ...tlsOpts }, () => resolve(s))
      : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once("error", reject);
    s.setTimeout(timeoutMs, () => s.destroy(new Error("smtp: connection timed out")));
  });
  let encrypted = secure;
  let reader = new ReplyReader(sock);

  const expect = async (codes: number[], what: string): Promise<Reply> => {
    const r = await reader.next(timeoutMs);
    if (!codes.includes(r.code)) throw new Error(`smtp: ${what} failed: ${r.code} ${r.lines.join(" ").slice(0, 200)}`);
    return r;
  };
  const cmd = async (line: string, codes: number[], what: string): Promise<Reply> => {
    sock.write(line + "\r\n");
    return expect(codes, what);
  };

  try {
    await expect([220], "greeting");
    let ehlo = await cmd(`EHLO ${helo}`, [250], "EHLO");
    const has = (r: Reply, ext: string) => r.lines.some((l) => l.toUpperCase().startsWith(ext));

    if (!encrypted && has(ehlo, "STARTTLS")) {
      await cmd("STARTTLS", [220], "STARTTLS");
      reader.detach(sock);
      const plain = sock;
      sock = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ socket: plain as Socket, ...tlsOpts }, () => resolve(t));
        t.once("error", reject);
      });
      encrypted = true;
      reader = new ReplyReader(sock);
      ehlo = await cmd(`EHLO ${helo}`, [250], "EHLO after STARTTLS");
    }
    if (!encrypted && !cfg.allowInsecure) {
      throw new Error("smtp: the server does not offer STARTTLS; refusing to send without encryption (set allowInsecure only for a local relay)");
    }

    if (cfg.user && cfg.pass) {
      if (!encrypted) throw new Error("smtp: refusing to send a password without TLS");
      const auth = ehlo.lines.find((l) => l.toUpperCase().startsWith("AUTH")) ?? "AUTH PLAIN";
      if (/\bPLAIN\b/i.test(auth)) {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.pass}`, "utf8").toString("base64");
        await cmd(`AUTH PLAIN ${token}`, [235], "AUTH PLAIN");
      } else if (/\bLOGIN\b/i.test(auth)) {
        await cmd("AUTH LOGIN", [334], "AUTH LOGIN");
        await cmd(Buffer.from(cfg.user, "utf8").toString("base64"), [334], "AUTH LOGIN user");
        await cmd(Buffer.from(cfg.pass, "utf8").toString("base64"), [235], "AUTH LOGIN password");
      } else {
        throw new Error(`smtp: no supported AUTH method in "${auth}"`);
      }
    }

    await cmd(`MAIL FROM:<${from}>`, [250], "MAIL FROM");
    await cmd(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await cmd("DATA", [354], "DATA");
    const data = buildMessage(cfg.from, msg).split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
    await cmd(`${data}\r\n.`, [250], "message");
    sock.write("QUIT\r\n");
    await reader.next(2_000).catch(() => undefined);
  } finally {
    reader.detach(sock);
    sock.on("error", () => undefined);
    sock.destroy();
  }
}
