// Browser providers: Browsa (Phantom), your local Chrome, or any CDP browser. See types.ts.

export * from "./types.js";
export * from "./select.js";
export * from "./proxy.js";
export * from "./byok-llm.js";
export { BrowsaProvider, type PoolLike } from "./browsa.js";
export { LocalProvider, findChrome, localChromeAvailable, chromeCandidates, localCapabilities, NO_CHROME, type LocalProviderOptions } from "./local.js";
export { CdpProvider, parseCdpHeaders, cdpDisplay, type CdpProviderOptions } from "./cdp.js";
export { runLocalAgent, snapshot, act, type LoopAction, type LoopOptions, type LoopResult } from "./agent-loop.js";
export { buildProviderBrowser } from "./context.js";

import type { ProviderId } from "./types.js";

/** The short capability table of Settings and the README: what works where. */
export const PROVIDER_TABLE: { feature: string; browsa: string; local: string; cdp: string }[] = [
  { feature: "Search, compare, carts, approval gate", browsa: "yes", local: "yes", cdp: "yes" },
  { feature: "Bot checks and captchas", browsa: "passed by Phantom, solved in-session", local: "you solve them in the window", cdp: "your provider's" },
  { feature: "US home-internet exit per store", browsa: "yes", local: "your own proxy", cdp: "your provider's proxy" },
  { feature: "Take over", browsa: "Phantom Live, from any device", local: "the window on this computer", cdp: "your provider's viewer" },
  { feature: "AI fallback", browsa: "hosted model or your key", local: "with your model key", cdp: "with your model key" },
  { feature: "Saved profiles", browsa: "in the cloud", local: "a folder on this computer", cdp: "your provider's" },
  { feature: "Credits", browsa: "Browsa credits", local: "none", cdp: "none from Browsa" },
];

export const PROVIDER_CHOICES: { value: ProviderId | "auto"; label: string }[] = [
  { value: "auto", label: "Automatic (Browsa with a key, else your Chrome)" },
  { value: "browsa", label: "Phantom on Browsa" },
  { value: "local", label: "Your Chrome on this computer" },
  { value: "cdp", label: "Any CDP browser (a URL)" },
];
