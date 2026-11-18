// Notifiers: Slack incoming webhook, a generic signed webhook, email (SMTP, Resend or SendGrid)
// and desktop (stdout). No dependencies beyond Node's fetch, crypto and tls.

import { createHmac } from "node:crypto";
import { formatMoney } from "../stores/util.js";
import { sendMail } from "./smtp.js";
import type { Alert, AlertConfig, Notifier, NotifyChannel, NotifyTarget, SmtpConfig } from "./types.js";

export const SIGNATURE_HEADER = "X-OSA-Signature";
export const TIMESTAMP_HEADER = "X-OSA-Timestamp";

/** "sha256=<hex>" over `${timestamp}.${body}` with the shared secret. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Check a received webhook; also rejects timestamps older than `toleranceSec` (default 5 minutes). */
export function verifySignature(secret: string, timestamp: string, body: string, signature: string, toleranceSec = 300, now = Date.now()): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const want = signPayload(secret, timestamp, body);
  if (want.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** The plain-text body used by email and desktop. */
export function alertText(a: Alert): string {
  const lines = [a.message];
  if (a.offer) {
    lines.push("", a.offer.title, `${formatMoney(a.offer.price)}${a.offer.shipping ? ` + ${formatMoney(a.offer.shipping)} shipping` : ""} at ${a.offer.storeDomain}`, a.offer.url);
  }
  lines.push("", `Watch: ${a.watchId}. Open Shopping Agent never buys without your approval.`);
  return lines.join("\n");
}

export function alertSubject(a: Alert): string {
  const what = a.kind === "below_target" ? "Price at target" : a.kind === "price_drop" ? "Price drop"
    : a.kind === "back_in_stock" ? "Back in stock" : "Watch failing";
  const price = a.offer ? ` ${formatMoney(a.offer.total)}` : "";
  return `${what}:${price} ${a.label}`.slice(0, 150);
}

async function postJson(url: string, body: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "open-shopping-agent", ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${new URL(url).host} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  await res.arrayBuffer().catch(() => undefined);
}

function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackNotifier(config: AlertConfig = {}): Notifier {
  return {
    channel: "slack",
    async send(alert, target) {
      const url = target.url || config.slackWebhookUrl;
      if (!url) throw new Error("slack: set OSA_SLACK_WEBHOOK_URL or the watch's notify url");
      const link = alert.offer ? `\n<${alert.offer.url}|${slackEscape(alert.offer.title.slice(0, 120))}>` : "";
      await postJson(url, JSON.stringify({ text: slackEscape(alert.message) + link }));
    },
  };
}

export function webhookNotifier(config: AlertConfig = {}): Notifier {
  return {
    channel: "webhook",
    async send(alert, target) {
      const url = target.url || config.webhookUrl;
      if (!url) throw new Error("webhook: set OSA_WEBHOOK_URL or the watch's notify url");
      const body = JSON.stringify({ type: "osa.alert", alert });
      const headers: Record<string, string> = {};
      if (config.webhookSecret) {
        const ts = String(Math.floor(Date.now() / 1000));
        headers[TIMESTAMP_HEADER] = ts;
        headers[SIGNATURE_HEADER] = signPayload(config.webhookSecret, ts, body);
      }
      await postJson(url, body, headers);
    },
  };
}

export function emailNotifier(config: AlertConfig = {}): Notifier {
  return {
    channel: "email",
    async send(alert, target) {
      const to = target.to || config.emailTo;
      if (!to) throw new Error("email: set OSA_EMAIL_TO or the watch's notify address");
      const subject = alertSubject(alert);
      const text = alertText(alert);
      if (config.smtp) {
        await sendMail(config.smtp, { to, subject, text });
      } else if (config.resend) {
        const base = config.resend.baseUrl || "https://api.resend.com";
        await postJson(`${base}/emails`, JSON.stringify({ from: config.resend.from, to: [to], subject, text }),
          { Authorization: `Bearer ${config.resend.apiKey}` });
      } else if (config.sendgrid) {
        const base = config.sendgrid.baseUrl || "https://api.sendgrid.com";
        await postJson(`${base}/v3/mail/send`, JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: config.sendgrid.from },
          subject,
          content: [{ type: "text/plain", value: text }],
        }), { Authorization: `Bearer ${config.sendgrid.apiKey}` });
      } else {
        throw new Error("email: set OSA_SMTP_HOST (SMTP), RESEND_API_KEY or SENDGRID_API_KEY");
      }
    },
  };
}

export function desktopNotifier(config: AlertConfig = {}): Notifier {
  return {
    channel: "desktop",
    async send(alert) {
      const out = config.out ?? process.stdout;
      out.write(`\n[osa alert] ${alertSubject(alert)}\n${alertText(alert)}\n`);
    },
  };
}

export function createNotifiers(config: AlertConfig = {}): Record<NotifyChannel, Notifier> {
  return {
    slack: slackNotifier(config),
    webhook: webhookNotifier(config),
    email: emailNotifier(config),
    desktop: desktopNotifier(config),
  };
}

/**
 * Read notifier settings from the environment:
 * OSA_SLACK_WEBHOOK_URL, OSA_WEBHOOK_URL, OSA_WEBHOOK_SECRET, OSA_EMAIL_TO,
 * OSA_SMTP_HOST, OSA_SMTP_PORT (587), OSA_SMTP_USER, OSA_SMTP_PASS, OSA_SMTP_FROM, OSA_SMTP_SECURE,
 * RESEND_API_KEY + OSA_EMAIL_FROM, SENDGRID_API_KEY + OSA_EMAIL_FROM.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const config: AlertConfig = {};
  if (env.OSA_SLACK_WEBHOOK_URL) config.slackWebhookUrl = env.OSA_SLACK_WEBHOOK_URL;
  if (env.OSA_WEBHOOK_URL) config.webhookUrl = env.OSA_WEBHOOK_URL;
  if (env.OSA_WEBHOOK_SECRET) config.webhookSecret = env.OSA_WEBHOOK_SECRET;
  if (env.OSA_EMAIL_TO) config.emailTo = env.OSA_EMAIL_TO;
  const from = env.OSA_SMTP_FROM || env.OSA_EMAIL_FROM;
  if (env.OSA_SMTP_HOST) {
    const port = Number(env.OSA_SMTP_PORT || 587);
    const smtp: SmtpConfig = {
      host: env.OSA_SMTP_HOST,
      port,
      secure: env.OSA_SMTP_SECURE ? env.OSA_SMTP_SECURE === "true" || env.OSA_SMTP_SECURE === "1" : port === 465,
      from: from || env.OSA_SMTP_USER || "",
    };
    if (env.OSA_SMTP_USER) smtp.user = env.OSA_SMTP_USER;
    if (env.OSA_SMTP_PASS) smtp.pass = env.OSA_SMTP_PASS;
    config.smtp = smtp;
  }
  if (env.RESEND_API_KEY && from) config.resend = { apiKey: env.RESEND_API_KEY, from };
  if (env.SENDGRID_API_KEY && from) config.sendgrid = { apiKey: env.SENDGRID_API_KEY, from };
  return config;
}

/** Send one alert to every target of the watch. Returns the errors; never throws. */
export async function deliver(alert: Alert, targets: NotifyTarget[], notifiers: Record<NotifyChannel, Notifier>): Promise<string[]> {
  const errors: string[] = [];
  for (const t of targets) {
    try { await notifiers[t.channel].send(alert, t); } catch (e) { errors.push(`${t.channel}: ${(e as Error).message}`); }
  }
  return errors;
}
