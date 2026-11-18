import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type Socket } from "node:net";
import {
  slackNotifier, webhookNotifier, emailNotifier, configFromEnv, signPayload, verifySignature, sendMail, buildMessage,
  SIGNATURE_HEADER, TIMESTAMP_HEADER, type Alert,
} from "../../src/alerts/index.js";
import { recorder } from "./helpers.js";

const alert: Alert = {
  kind: "below_target", watchId: "monitor", label: "27 inch 4K monitor", at: "2026-11-18T00:00:00.000Z",
  message: "27 inch 4K monitor: $239.00 at walmart.com, at or below your target of $250.00.",
  targetPrice: { cents: 25000, currency: "USD" },
  offer: {
    store: "walmart", storeDomain: "walmart.com", title: "Monitor <4K> & stand", url: "https://www.walmart.com/ip/123",
    price: { cents: 23900, currency: "USD" }, total: { cents: 23900, currency: "USD" }, inStock: true,
  },
};

test("slack: posts text with an escaped product link", async () => {
  const srv = await recorder();
  try {
    await slackNotifier({}).send(alert, { channel: "slack", url: `${srv.url}/hook` });
    assert.equal(srv.received.length, 1);
    const r = srv.received[0];
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/hook");
    assert.equal(r.headers["content-type"], "application/json");
    const body = JSON.parse(r.body);
    assert.match(body.text, /\$239\.00 at walmart\.com/);
    assert.match(body.text, /<https:\/\/www\.walmart\.com\/ip\/123\|Monitor &lt;4K&gt; &amp; stand>/);
  } finally { await srv.close(); }
});

test("slack: global url from config, and an error on a failed status", async () => {
  const srv = await recorder(500);
  try {
    await assert.rejects(slackNotifier({ slackWebhookUrl: srv.url }).send(alert, { channel: "slack" }), /answered 500/);
  } finally { await srv.close(); }
});

test("webhook: JSON body with a valid HMAC-SHA256 signature", async () => {
  const srv = await recorder();
  try {
    await webhookNotifier({ webhookUrl: srv.url, webhookSecret: "s3cret" }).send(alert, { channel: "webhook" });
    const r = srv.received[0];
    const body = JSON.parse(r.body);
    assert.equal(body.type, "osa.alert");
    assert.equal(body.alert.watchId, "monitor");
    const ts = r.headers[TIMESTAMP_HEADER.toLowerCase()] as string;
    const sig = r.headers[SIGNATURE_HEADER.toLowerCase()] as string;
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(sig, signPayload("s3cret", ts, r.body));
    assert.equal(verifySignature("s3cret", ts, r.body, sig), true);
    assert.equal(verifySignature("wrong", ts, r.body, sig), false);
    assert.equal(verifySignature("s3cret", ts, r.body + " ", sig), false);
    assert.equal(verifySignature("s3cret", String(Number(ts) - 3600), r.body, signPayload("s3cret", String(Number(ts) - 3600), r.body)), false, "old timestamp");
  } finally { await srv.close(); }
});

test("webhook: no secret, no signature headers; missing url is an error", async () => {
  const srv = await recorder();
  try {
    await webhookNotifier({}).send(alert, { channel: "webhook", url: srv.url });
    assert.equal(srv.received[0].headers[SIGNATURE_HEADER.toLowerCase()], undefined);
    await assert.rejects(webhookNotifier({}).send(alert, { channel: "webhook" }), /OSA_WEBHOOK_URL/);
  } finally { await srv.close(); }
});

test("email: Resend and SendGrid HTTP APIs", async () => {
  const srv = await recorder();
  try {
    await emailNotifier({ resend: { apiKey: "re_test", from: "alerts@example.com", baseUrl: srv.url } }).send(alert, { channel: "email", to: "me@example.com" });
    await emailNotifier({ emailTo: "me@example.com", sendgrid: { apiKey: "SG.test", from: "alerts@example.com", baseUrl: srv.url } }).send(alert, { channel: "email" });
    const [resend, sendgrid] = srv.received;
    assert.equal(resend.url, "/emails");
    assert.equal(resend.headers.authorization, "Bearer re_test");
    const rb = JSON.parse(resend.body);
    assert.deepEqual(rb.to, ["me@example.com"]);
    assert.match(rb.subject, /^Price at target: \$239\.00 27 inch 4K monitor/);
    assert.match(rb.text, /https:\/\/www\.walmart\.com\/ip\/123/);
    assert.equal(sendgrid.url, "/v3/mail/send");
    assert.equal(JSON.parse(sendgrid.body).personalizations[0].to[0].email, "me@example.com");
    await assert.rejects(emailNotifier({}).send(alert, { channel: "email", to: "me@example.com" }), /OSA_SMTP_HOST/);
    await assert.rejects(emailNotifier({}).send(alert, { channel: "email" }), /OSA_EMAIL_TO/);
  } finally { await srv.close(); }
});

test("configFromEnv reads the documented variables", () => {
  const c = configFromEnv({
    OSA_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/x", OSA_WEBHOOK_URL: "https://example.com/h", OSA_WEBHOOK_SECRET: "s",
    OSA_EMAIL_TO: "me@example.com", OSA_SMTP_HOST: "smtp.example.com", OSA_SMTP_PORT: "465", OSA_SMTP_USER: "u", OSA_SMTP_PASS: "p",
    OSA_SMTP_FROM: "Alerts <alerts@example.com>", RESEND_API_KEY: "re_x",
  });
  assert.equal(c.slackWebhookUrl, "https://hooks.slack.com/services/x");
  assert.equal(c.webhookSecret, "s");
  assert.deepEqual(c.smtp, { host: "smtp.example.com", port: 465, secure: true, from: "Alerts <alerts@example.com>", user: "u", pass: "p" });
  assert.equal(c.resend?.from, "Alerts <alerts@example.com>");
  assert.equal(configFromEnv({ OSA_SMTP_HOST: "h" }).smtp?.secure, false);
});

/** A tiny fake SMTP server. `starttls` advertises STARTTLS (but cannot do it). */
async function fakeSmtp(opts: { starttls?: boolean; auth?: boolean } = {}) {
  const transcript: string[] = [];
  let data = "";
  const server = createNetServer((sock: Socket) => {
    sock.setEncoding("utf8");
    let inData = false;
    let buf = "";
    sock.write("220 fake.test ESMTP\r\n");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; sock.write("250 2.0.0 queued\r\n"); } else data += line + "\r\n";
          continue;
        }
        transcript.push(line);
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") {
          const ext = [...(opts.starttls ? ["STARTTLS"] : []), ...(opts.auth ? ["AUTH PLAIN LOGIN"] : []), "8BITMIME"];
          sock.write(["250-fake.test hello", ...ext.map((e, k) => `250${k === ext.length - 1 ? " " : "-"}${e}`)].join("\r\n") + "\r\n");
        } else if (verb === "MAIL" || verb === "RCPT") sock.write("250 OK\r\n");
        else if (verb === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
        else if (verb === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("502 not here\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    transcript, get data() { return data; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("smtp: sends to a local relay with allowInsecure", async () => {
  const srv = await fakeSmtp();
  try {
    await sendMail({ host: "127.0.0.1", port: srv.port, from: "Alerts <alerts@example.com>", allowInsecure: true, heloName: "osa.test" },
      { to: "me@example.com", subject: "Prix baissé: $239", text: "line one\n.starts with a dot\nend" });
    assert.deepEqual(srv.transcript, ["EHLO osa.test", "MAIL FROM:<alerts@example.com>", "RCPT TO:<me@example.com>", "DATA", "QUIT"]);
    assert.match(srv.data, /^From: Alerts <alerts@example.com>\r\n/);
    assert.match(srv.data, /Subject: =\?UTF-8\?B\?/);
    const body = srv.data.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    assert.equal(Buffer.from(body, "base64").toString("utf8"), "line one\r\n.starts with a dot\r\nend");
  } finally { await srv.close(); }
});

test("smtp: refuses plain text without allowInsecure, and never sends a password without TLS", async () => {
  const srv = await fakeSmtp({ auth: true });
  try {
    await assert.rejects(sendMail({ host: "127.0.0.1", port: srv.port, from: "a@example.com" }, { to: "b@example.com", subject: "s", text: "t" }),
      /refusing to send without encryption/);
    await assert.rejects(sendMail({ host: "127.0.0.1", port: srv.port, from: "a@example.com", user: "u", pass: "p", allowInsecure: true },
      { to: "b@example.com", subject: "s", text: "t" }), /password without TLS/);
    assert.ok(!srv.transcript.some((l) => l.startsWith("AUTH")), "no AUTH line was sent");
  } finally { await srv.close(); }
});

test("smtp: a server that advertises STARTTLS gets the STARTTLS command first", async () => {
  const srv = await fakeSmtp({ starttls: true });
  try {
    await assert.rejects(sendMail({ host: "127.0.0.1", port: srv.port, from: "a@example.com", timeoutMs: 2000 }, { to: "b@example.com", subject: "s", text: "t" }),
      /STARTTLS failed: 502/);
    assert.deepEqual(srv.transcript.slice(-1), ["STARTTLS"]);
  } finally { await srv.close(); }
});

test("smtp: buildMessage rejects bad addresses and strips header injection", () => {
  assert.throws(() => buildMessage("not an address", { to: "b@example.com", subject: "s", text: "t" }), /not an email address/);
  const m = buildMessage("a@example.com", { to: "b@example.com", subject: "hi\r\nBcc: evil@example.com", text: "t" });
  assert.ok(!/\r\nBcc:/.test(m));
});
