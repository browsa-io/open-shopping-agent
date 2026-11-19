// Shared readers for order pages: status words, carriers, tracking numbers and links, sign-in pages,
// and reading a PageExtract from a live page without changing it.

import type { Page } from "playwright-core";
import type { Money } from "../core/types.js";
import type { PageExtract, TrackingInfo } from "./types.js";

const MAX_TEXT = 20_000;

/** Read the page as it is: URL, title, visible text and links. Never clicks, posts or reloads. */
export async function extractPage(page: Page, timeoutMs = 15_000): Promise<PageExtract> {
  const read = (async () => {
    const url = page.url();
    const got = await page.evaluate((max: number) => {
      const d = (globalThis as any).document;
      const text = String(d?.body?.innerText ?? "").slice(0, max);
      const links = Array.from(d?.querySelectorAll?.("a[href]") ?? []).slice(0, 400).map((a: any) => ({
        text: String(a.innerText ?? a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
        href: String(a.href ?? ""),
      }));
      return { title: String(d?.title ?? ""), text, links };
    }, MAX_TEXT);
    return { url, title: got.title, text: got.text, links: got.links.filter((l) => /^https:\/\//i.test(l.href)) };
  })();
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("reading the page timed out")), timeoutMs); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** The first capture of `re` in the text, trimmed. */
export function capture(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  return m?.[1]?.trim() || undefined;
}

/** "$41.97" after a label like "Order total" (the first one after the label). */
export function moneyAfter(text: string, label: RegExp): Money | undefined {
  // \b keeps "Subtotal" from answering for "total".
  const m = new RegExp(`\\b${label.source}[^$\\n]{0,40}\\$\\s?([\\d,]+\\.\\d{2})`, "i").exec(text);
  if (!m) return undefined;
  const cents = Math.round(Number(m[1].replace(/,/g, "")) * 100);
  return Number.isFinite(cents) && cents > 0 ? { cents, currency: "USD" } : undefined;
}

/** A link whose href matches `href` (and text matches `text` when given). */
export function findLink(p: PageExtract, href: RegExp, text?: RegExp): string | undefined {
  return p.links.find((l) => href.test(l.href) && (!text || text.test(l.text)))?.href;
}

const STATUSES: [RegExp, string][] = [
  [/\b(cancell?ed|order was cancell?ed)\b/i, "Cancelled"],
  [/\b(returned|return (complete|received)|refund(ed| issued))\b/i, "Returned"],
  [/\bdelivered\b/i, "Delivered"],
  [/\bout for delivery\b/i, "Out for delivery"],
  [/\b(in transit|on the way|on its way)\b/i, "In transit"],
  [/\bshipped\b/i, "Shipped"],
  [/\b(preparing (for|to) ship(ment)?|processing|not yet shipped|being prepared)\b/i, "Preparing"],
  [/\b(order (placed|received|confirmed)|ordered)\b/i, "Ordered"],
];

/** The most advanced status word the page shows. */
export function statusFrom(text: string): string | undefined {
  for (const [re, word] of STATUSES) if (re.test(text)) return word;
  return undefined;
}

/** The delivery line: "Arriving Thursday", "Delivered Nov 21", "Arrives by Fri, Nov 22". */
export function deliveryLine(text: string): string | undefined {
  // One line only ([ \t], never a newline); day and month names start with a capital.
  const m = /\b((?:[Aa]rriving|[Aa]rrives(?: by)?|[Dd]elivered(?: on)?|[Ee]xpected(?: by)?|[Ee]stimated delivery:?|[Gg]et it(?: by)?)[ \t]+(?:[A-Z][a-z]{2,8}\.?,?[ \t]*)?(?:[A-Z][a-z]{2,8}\.?[ \t]+\d{1,2}\b|[A-Z][a-z]{2,8}\b|today\b|tomorrow\b)(?:[ \t]*[-–][ \t]*(?:[A-Z][a-z]{2,8}\.?[ \t]+)?\d{1,2}\b)?)/.exec(text);
  return m?.[1]?.replace(/[ \t]+/g, " ").trim();
}

const CARRIERS: [RegExp, string][] = [
  [/\bUPS\b|ups\.com/i, "UPS"],
  [/\bUSPS\b|usps\.com|\bU\.S\. Postal\b/i, "USPS"],
  [/\bFed ?Ex\b|fedex\.com/i, "FedEx"],
  [/\bDHL\b|dhl\.com/i, "DHL"],
  [/\bOnTrac\b|ontrac\.com/i, "OnTrac"],
  [/\bLaser ?Ship\b|lasership\.com/i, "LaserShip"],
  [/\bAmazon Logistics\b|\bAMZL\b|carrier:?\s*amazon\b|shipped with amazon\b/i, "Amazon"],
  [/\bVeho\b/i, "Veho"],
];

export function carrierFrom(text: string, links: PageExtract["links"] = []): string | undefined {
  const label = capture(text, /\b(?:carrier|shipped (?:with|via)|delivered by|shipping carrier)\s*:?\s*([A-Za-z][A-Za-z .]{1,24}?)(?:\s{2,}|\n|,|\.|$)/i);
  const hay = `${label ?? ""}\n${text}\n${links.map((l) => l.href).join("\n")}`;
  for (const [re, name] of CARRIERS) if (re.test(hay)) return name;
  return label;
}

/** A tracking number shown with its label, or one in a carrier's known format. */
export function trackingNumberFrom(text: string): string | undefined {
  const labelled = capture(text, /\btracking (?:id|number|no\.?|#)\s*:?\s*#?\s*([A-Z0-9]{8,34})\b/i);
  if (labelled && /\d/.test(labelled)) return labelled;
  return capture(text, /\b(1Z[0-9A-Z]{16})\b/) ?? capture(text, /\b(9[2-5]\d{18,20})\b/) ?? capture(text, /\b(TBA\d{9,15})\b/);
}

const CARRIER_TRACK = /ups\.com\/track|tools\.usps\.com|fedex\.com\/(?:fedextrack|apps\/fedextrack|[a-z-]+\/tracking)|dhl\.com\/.*track|ontrac\.com\/track|lasership\.com\/track/i;

/** A carrier tracking link, else a store link whose text says "Track". */
export function trackingLink(p: PageExtract, storeTrack?: RegExp): string | undefined {
  return findLink(p, CARRIER_TRACK)
    ?? (storeTrack ? findLink(p, storeTrack) : undefined)
    ?? findLink(p, /^https:\/\//, /\btrack(ing)?\b/i);
}

/** Sign-in pages: the URL looks like one, or the page asks for a password and offers to sign in. */
export function isSignIn(p: PageExtract, url?: RegExp): boolean {
  if (url?.test(p.url)) return true;
  return /\bsign[ -]?in\b/i.test(p.text.slice(0, 2000)) && /\bpassword\b/i.test(p.text.slice(0, 3000)) && !/\border (details|#|number)\b/i.test(p.text);
}

/** Tracking with the common readers; `signInUrl` and `storeTrack` are per store. */
export function genericTracking(p: PageExtract, o: { signInUrl?: RegExp; storeTrack?: RegExp; looksLikeOrder?: RegExp } = {}): TrackingInfo {
  if (isSignIn(p, o.signInUrl)) return { signIn: true };
  const out: TrackingInfo = {};
  const status = statusFrom(p.text);
  if (status) out.status = status;
  const delivery = deliveryLine(p.text);
  if (delivery) out.deliveryText = delivery;
  const carrier = carrierFrom(p.text, p.links);
  if (carrier) out.carrier = carrier;
  const num = trackingNumberFrom(p.text);
  if (num) out.trackingNumber = num;
  const link = trackingLink(p, o.storeTrack);
  if (link) out.trackingUrl = link;
  if (o.looksLikeOrder && !o.looksLikeOrder.test(p.text) && !status) out.unreadable = true;
  return out;
}

/** A short confirmation phrase: the store's words only, cut before any name ("Thank you, Sam!" -> "Thank you"). */
export function phrase(text: string, re: RegExp): string | undefined {
  const m = re.exec(text)?.[0];
  return m ? m.replace(/[,!.]?\s*$/, "").replace(/\s+/g, " ").trim() : undefined;
}
