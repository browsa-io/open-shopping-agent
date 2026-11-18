// Browser providers: where a store's browser runs. Open Shopping Agent works with any of them; the
// capabilities say what each one can do, and the engine, the adapters and the front ends degrade
// gracefully when one is missing.
//
//   browsa  Phantom on Browsa (cloud): bot checks passed, captchas solved in-session, US home-internet
//           exit per store, Phantom Live take-over from any device, AI fallback, saved profiles.
//   local   the Chrome or Edge installed on this computer (Playwright), headed by default so
//           you can take over in the window. Profiles in .osa/browsers/<store>.
//   cdp     any browser that speaks the Chrome DevTools Protocol (OSA_CDP_URL): your own remote Chrome
//           or another cloud provider.

import type { Page } from "playwright-core";
import type { StoreId } from "../types.js";
import type { StoreBrowser } from "../browsers.js";

export type ProviderId = "browsa" | "local" | "cdp";
export const PROVIDER_IDS: readonly ProviderId[] = ["browsa", "local", "cdp"];

export interface BrowserCapabilities {
  /** How the person takes over: a remote Phantom Live link, the local window, or not at all. */
  liveLink: "remote" | "window" | "none";
  /** An AI agent can finish a step when the direct page code fails. */
  aiFallback: boolean;
  /** Captchas and bot checks are solved in the browser session. */
  captchaSolving: boolean;
  /** A US home-internet (residential) exit per store is available. */
  residentialExit: boolean;
  /** Saved store profiles in the cloud, usable from any device. */
  savedProfiles: boolean;
  /** "phantom": Browsa's browser; "standard": a stock browser. */
  fingerprint: "phantom" | "standard";
}

export const BROWSA_CAPABILITIES: BrowserCapabilities = {
  liveLink: "remote", aiFallback: true, captchaSolving: true, residentialExit: true, savedProfiles: true, fingerprint: "phantom",
};

/** One store's browser from a provider. Structurally a StoreBrowser plus what the provider knows. */
export interface ProviderBrowser extends StoreBrowser {
  provider: ProviderId;
  capabilities: BrowserCapabilities;
}

export interface OpenOptions {
  /** Shopify shop domain; other stores use their own. */
  domain?: string;
  /** Called before anything that costs Browsa credits (browsa provider only). */
  spend?: (maxCredits: number, what: string) => Promise<number>;
  log?: (message: string) => void;
  /** The user's proxy for this store (local provider); null: none. Unset: the provider's proxyFor. */
  proxy?: import("./proxy.js").ProxySpec | null;
}

export interface BrowserProvider {
  readonly id: ProviderId;
  /** Shown on the run header: "Phantom on Browsa", "your Chrome", "your CDP browser". */
  readonly label: string;
  readonly capabilities: BrowserCapabilities;
  open(store: StoreId, opts?: OpenOptions): Promise<ProviderBrowser>;
  /** Close everything this provider opened. */
  closeAll?(): Promise<void>;
}

/** A capability the current browser provider does not have (AI fallback, live link, captcha solving). */
export class CapabilityMissing extends Error {
  readonly capability: keyof BrowserCapabilities;
  readonly provider: ProviderId;
  constructor(capability: keyof BrowserCapabilities, provider: ProviderId, message: string) {
    super(message);
    this.name = "CapabilityMissing";
    this.capability = capability;
    this.provider = provider;
  }
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  browsa: "Phantom on Browsa",
  local: "your Chrome",
  cdp: "your CDP browser",
};

/** Stores that often block non-US or datacenter browsers. */
export const BLOCKY_STORES: readonly StoreId[] = ["amazon", "target", "bestbuy"];

/** Warned once per run on a non-Browsa provider when one of BLOCKY_STORES is in the run. */
export const NON_BROWSA_EXIT_WARNING =
  "Amazon, Target and Best Buy often block non-US or datacenter browsers; Browsa adds a US home-internet exit.";

/** The needs_user message for a bot check on a non-Browsa provider. */
export function botCheckMessage(provider: ProviderId, capabilities: BrowserCapabilities): string {
  if (provider === "local") {
    return capabilities.liveLink === "window"
      ? "This store showed a bot check. Solve it in the browser window, or run with Browsa to pass it automatically."
      : "This store showed a bot check. Run without OSA_HEADLESS=1 to solve it in the browser window, or run with Browsa to pass it automatically.";
  }
  return "This store showed a bot check. Solve it in your remote browser through your provider's viewer, or run with Browsa to pass it automatically.";
}

/** The one-line note under a store that blocked a non-Browsa browser. */
export function blockedNote(storeName: string): string {
  return `${storeName} blocked this browser. Browsa's Phantom passes it: browsa.io`;
}

/** The take-over text liveLink() returns where there is no Phantom Live link. */
export function takeOverText(provider: ProviderId, capabilities: BrowserCapabilities): string {
  if (provider === "local") {
    return capabilities.liveLink === "window"
      ? "Take over in the browser window on this computer."
      : "This browser runs headless (OSA_HEADLESS=1), so there is no window to take over. Run it headed to finish this step yourself.";
  }
  return "This browser is remote (OSA_CDP_URL). Open it through your provider's own viewer to take over.";
}

/**
 * True when an error means the store blocked the browser: a bot check that did not clear, a
 * captcha, "access denied", HTTP 403/429, or a connection reset the store sends to unwanted clients.
 */
export function isBotBlock(e: unknown): boolean {
  if (!e) return false;
  const cls = (e as { constructor?: { name?: string } })?.constructor?.name;
  if ((e as Error)?.name === "BotCheckError" || cls === "BotCheckError" || cls === "CaptchaHandoffError") return true;
  const m = String((e as Error)?.message ?? e);
  return /bot check|captcha|are you a (human|robot)|i am human|robot check|press (and|&) hold|access denied|pardon our interruption|request blocked|blocked (this|your) (browser|request)|\bHTTP 40[3]\b|\b429\b|too many requests|ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/i.test(m);
}

/** A ProviderBrowser's page type, re-exported for provider files. */
export type { Page };
