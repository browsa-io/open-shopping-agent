// STARTTLS and AUTH against a local TLS server with a throwaway self-signed certificate.
// Skipped when the openssl command is not installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { TLSSocket, createServer as createTlsServer } from "node:tls";
import { sendMail } from "../../src/alerts/index.js";
import { tempDir } from "./helpers.js";

async function makeCert(): Promise<{ key: string; cert: string } | null> {
  const dir = await tempDir();
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } catch { return null; }
}

/** Handles one SMTP session on `sock`; calls upgrade() on STARTTLS. */
function session(sock: Socket | TLSSocket, log: string[], tls: boolean, upgrade?: (s: Socket) => void) {
  sock.setEncoding("utf8");
  let buf = "", inData = false;
  const onData = (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) { if (line === ".") { inData = false; sock.write("250 queued\r\n"); } continue; }
      log.push(`${tls ? "tls" : "plain"}: ${line}`);
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO") sock.write(tls ? "250-fake\r\n250 AUTH PLAIN LOGIN\r\n" : "250-fake\r\n250 STARTTLS\r\n");
      else if (verb === "STARTTLS" && upgrade) { sock.write("220 go\r\n"); sock.removeListener("data", onData); upgrade(sock as Socket); return; }
      else if (verb === "AUTH") sock.write(line === `AUTH PLAIN ${Buffer.from("\0user\0pass").toString("base64")}` ? "235 ok\r\n" : "535 bad\r\n");
      else if (verb === "MAIL" || verb === "RCPT") sock.write("250 ok\r\n");
      else if (verb === "DATA") { inData = true; sock.write("354 go\r\n"); }
      else if (verb === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("502 no\r\n");
    }
  };
  sock.on("data", onData);
}

test("smtp: STARTTLS upgrade, then AUTH PLAIN and the message", async (t) => {
  const pem = await makeCert();
  if (!pem) { t.skip("openssl not available"); return; }
  const log: string[] = [];
  const server = createServer((sock) => {
    sock.write("220 fake ESMTP\r\n");
    session(sock, log, false, (plain) => {
      const secure = new TLSSocket(plain, { isServer: true, key: pem.key, cert: pem.cert });
      session(secure, log, true);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await sendMail({ host: "127.0.0.1", port, from: "alerts@example.com", user: "user", pass: "pass", heloName: "osa.test", tls: { ca: pem.cert, servername: "localhost" } },
      { to: "me@example.com", subject: "s", text: "t" });
    assert.deepEqual(log, [
      "plain: EHLO osa.test", "plain: STARTTLS",
      "tls: EHLO osa.test", `tls: AUTH PLAIN ${Buffer.from("\0user\0pass").toString("base64")}`,
      "tls: MAIL FROM:<alerts@example.com>", "tls: RCPT TO:<me@example.com>", "tls: DATA", "tls: QUIT",
    ]);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test("smtp: implicit TLS (port 465 style) with a certificate that is not trusted fails", async (t) => {
  const pem = await makeCert();
  if (!pem) { t.skip("openssl not available"); return; }
  const log: string[] = [];
  const server = createTlsServer({ key: pem.key, cert: pem.cert }, (sock) => { sock.write("220 fake\r\n"); session(sock, log, true); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(sendMail({ host: "127.0.0.1", port, secure: true, from: "a@example.com" }, { to: "b@example.com", subject: "s", text: "t" }));
    assert.equal(log.length, 0);
    await sendMail({ host: "127.0.0.1", port, secure: true, from: "a@example.com", heloName: "osa.test", tls: { ca: pem.cert, servername: "localhost" } },
      { to: "b@example.com", subject: "s", text: "t" });
    assert.equal(log[0], "tls: EHLO osa.test");
    assert.ok(log.includes("tls: DATA"));
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
