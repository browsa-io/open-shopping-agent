// Which browser provider a run uses. First match wins:
//   1. --browser in the CLI (or the `browser` option in code)
//   2. OSA_BROWSER=browsa|local|cdp
//   3. Settings in the web app
//   4. browsa when a Browsa key is set, else cdp when OSA_CDP_URL is set, else local
// so the tool works with zero signup on your own Chrome.

import { PROVIDER_IDS, type ProviderId } from "./types.js";

export interface ChooseInput {
  flag?: string;
  env?: Record<string, string | undefined>;
  setting?: string;
  hasBrowsaKey: boolean;
}

const ALIASES: Record<string, ProviderId> = {
  browsa: "browsa", phantom: "browsa", cloud: "browsa",
  local: "local", chrome: "local", edge: "local",
  cdp: "cdp", remote: "cdp",
};

/** Normalize a provider name; throws for an unknown one, undefined for empty or "auto". */
export function parseProviderId(v: string | undefined | null, from = "browser"): ProviderId | undefined {
  const t = v?.trim().toLowerCase();
  if (!t || t === "auto" || t === "default") return undefined;
  const id = ALIASES[t];
  if (!id) throw new Error(`${from} must be one of ${PROVIDER_IDS.join(", ")} (got "${v}")`);
  return id;
}

export function chooseProvider(i: ChooseInput): { id: ProviderId; why: "flag" | "env" | "settings" | "default" } {
  const env = i.env ?? process.env;
  const flag = parseProviderId(i.flag, "--browser");
  if (flag) return { id: flag, why: "flag" };
  const e = parseProviderId(env.OSA_BROWSER, "OSA_BROWSER");
  if (e) return { id: e, why: "env" };
  const s = parseProviderId(i.setting, "the browser setting");
  if (s) return { id: s, why: "settings" };
  if (i.hasBrowsaKey) return { id: "browsa", why: "default" };
  if (env.OSA_CDP_URL?.trim()) return { id: "cdp", why: "default" };
  return { id: "local", why: "default" };
}
