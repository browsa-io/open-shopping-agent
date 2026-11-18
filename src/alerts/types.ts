// Types of price-drop and back-in-stock watches. A watch is stored in .osa/watches.json and its
// check history in .osa/watches/<id>.jsonl. The alerts module never opens a browser itself: it
// gets a `CheckFn` from the engine, so it does not depend on the engine's internals.

import type { Money, Offer, StoreId } from "../core/types.js";

export type NotifyChannel = "email" | "slack" | "webhook" | "desktop";

/** Where one watch sends its alerts. URLs and addresses here override the global config. */
export interface NotifyTarget {
  channel: NotifyChannel;
  to?: string;    // email address (email)
  url?: string;   // Slack incoming webhook URL (slack) or endpoint (webhook)
}

export interface Watch {
  id: string;                          // a-z, 0-9 and "-", unique in watches.json
  label?: string;                      // shown in alerts; defaults to the query or url
  query?: string;                      // search text, "27 inch 4K monitor"
  url?: string;                        // or one product page
  stores: StoreId[];                   // where to look
  shopifyDomains?: string[];           // for the "shopify" store
  targetPrice?: Money;                 // alert when the best in-stock price is at or below it
  backInStock?: boolean;               // alert when the item comes back in stock
  condition?: "new" | "any";           // default "new": used and refurbished offers are ignored
  notify: NotifyTarget[];
  intervalMinutes: number;             // at least MIN_INTERVAL_MINUTES
  paused?: boolean;
  createdAt: string;
}

/** What `addWatch` accepts: the store fills id, createdAt and defaults. */
export interface WatchInput {
  id?: string;
  label?: string;
  query?: string;
  url?: string;
  store?: StoreId;
  stores?: StoreId[];
  shopifyDomains?: string[];
  targetPrice?: Money | number;        // a number is dollars: 199.99
  backInStock?: boolean;
  condition?: "new" | "any";
  notify?: NotifyChannel | NotifyTarget | Array<NotifyChannel | NotifyTarget>;
  intervalMinutes?: number;
  paused?: boolean;
}

/**
 * Runs the watch's search (or reads its product page) on its stores and returns what it found.
 * The engine provides it: for a query it calls each adapter's `search`, for a url its `details`.
 */
export type CheckFn = (watch: Watch, signal?: AbortSignal) => Promise<Offer[]>;

/** The short form of an offer kept in history and sent in alerts. */
export interface OfferSnapshot {
  store: StoreId;
  storeDomain: string;
  title: string;
  url: string;
  productId?: string;
  price: Money;
  shipping?: Money;
  total: Money;                        // price plus shipping when known
  inStock: boolean;
  condition?: Offer["condition"];
  seller?: string;
}

/** One line of .osa/watches/<id>.jsonl. */
export interface HistoryEntry {
  at: string;                          // ISO time of the check
  ok: boolean;
  error?: string;
  offerCount: number;
  inStockCount: number;
  best?: OfferSnapshot;                // lowest total among in-stock offers that match the condition
  offers: OfferSnapshot[];             // up to 10, cheapest first
  alerts: AlertKind[];                 // what this check sent
}

export type AlertKind = "below_target" | "price_drop" | "back_in_stock" | "check_failing";

export interface Alert {
  kind: AlertKind;
  watchId: string;
  label: string;
  message: string;                     // one plain sentence
  offer?: OfferSnapshot;
  previousTotal?: Money;
  targetPrice?: Money;
  at: string;
}

export interface Notifier {
  channel: NotifyChannel;
  send(alert: Alert, target: NotifyTarget): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;                        // 465 = TLS from the start, 587 or 25 = STARTTLS
  secure?: boolean;                    // default: port === 465
  user?: string;
  pass?: string;
  from: string;
  /** Allow sending without TLS. Only for a local relay or tests; never with a password. */
  allowInsecure?: boolean;
  /** Extra TLS options (a test CA, for example). */
  tls?: { rejectUnauthorized?: boolean; ca?: string | Buffer; servername?: string };
  timeoutMs?: number;
  heloName?: string;
}

/** Global notifier settings, usually read from the environment (see configFromEnv). */
export interface AlertConfig {
  slackWebhookUrl?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  emailTo?: string;
  smtp?: SmtpConfig;
  resend?: { apiKey: string; from: string; baseUrl?: string };
  sendgrid?: { apiKey: string; from: string; baseUrl?: string };
  /** Where desktop alerts are written; default process.stdout. */
  out?: { write(s: string): unknown };
}
