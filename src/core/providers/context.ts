// The StoreBrowser and StoreContext of a non-Browsa browser (local Chrome, any CDP browser). Same
// contract as Browsa's, with the missing capabilities degrading instead of failing:
//
//   aiTask    the local agent loop with the user's model key; without one a CapabilityMissing,
//             which adapters already treat as a failed fallback.
//   liveLink  a text saying where to take over (the local window, or the CDP provider's viewer).
//             util.needsUser shows it in the message, not as a link.

import type { Browser, BrowserContext, Page } from "playwright-core";
import type { StoreId } from "../types.js";
import type { AiTaskOptions, StoreContext } from "../../stores/adapter.js";
import { eitherSignal, type ExitInfo } from "../browsers.js";
import type { LLMConfig, JSONRequest } from "../llm.js";
import { runLocalAgent } from "./agent-loop.js";
import { CapabilityMissing, takeOverText, type BrowserCapabilities, type ProviderBrowser, type ProviderId } from "./types.js";

export interface BuildOptions {
  store: StoreId;
  provider: ProviderId;
  capabilities: BrowserCapabilities;
  agentId: string;
  page: Page;
  /** The browser context new tabs open in. */
  context: BrowserContext;
  /** Set for a CDP browser: reconnect when the connection drops. */
  browser?: Browser;
  exit?: ExitInfo;
  llm?: LLMConfig;
  aiMaxSteps?: number;
  /** The model call of the local loop (tests). */
  complete?: (cfg: LLMConfig, req: JSONRequest) => Promise<unknown>;
  close: (page: Page) => Promise<void>;
  log?: (message: string) => void;
}

export function buildProviderBrowser(o: BuildOptions): ProviderBrowser {
  let page = o.page;
  let closed = false;
  let running = false;
  const caps = o.capabilities;
  // Every tab this store opened: its first tab, fresh tabs, and the tabs those opened (a checkout
  // or a store link in a new tab). close() closes them all. Other tabs in the browser are the
  // person's own (a CDP browser is often their everyday Chrome) and are never touched.
  const ours = new Set<Page>();
  const adopt = (p: Page) => {
    if (!p || ours.has(p)) return;
    ours.add(p);
    try {
      p.on?.("popup", (q: Page) => adopt(q));
      p.on?.("close", () => ours.delete(p));
    } catch { /* a page without events (tests) */ }
  };
  adopt(page);

  const sb: ProviderBrowser = {
    store: o.store,
    agentId: o.agentId,
    mode: "burner",
    provider: o.provider,
    capabilities: caps,
    ...(o.exit ? { exit: o.exit } : {}),
    get page() { return page; },
    context(domain, extra): StoreContext {
      const log = extra.log ?? ((m: string) => o.log?.(m));
      const ctx = {
        store: o.store, domain, zip: extra.zip, agentId: o.agentId, signal: extra.signal, log,
        capabilities: caps,
        get page() { return page; },
        aiTask: async <T = unknown>(task: string, opts: AiTaskOptions = {}): Promise<T> => {
          if (!caps.aiFallback || !o.llm) {
            throw new CapabilityMissing("aiFallback", o.provider,
              "no AI fallback on this browser: bring your own model key (OSA_LLM and OSA_LLM_API_KEY) or run with Browsa");
          }
          if (running) throw new Error("an AI task is already running on this browser");
          if (extra.signal.aborted) throw new Error("run stopped");
          running = true;
          try {
            if (opts.startUrl && safeUrl(page) !== opts.startUrl) {
              await page.goto(opts.startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
            }
            log(`AI fallback with your model (${o.llm.provider}:${o.llm.model}): ${task.slice(0, 120)}`);
            const r = await runLocalAgent(page, task, {
              llm: o.llm, schema: opts.schema, maxSteps: Math.min(opts.maxSteps ?? o.aiMaxSteps ?? 8, o.aiMaxSteps ?? 8),
              log, signal: opts.signal ? eitherSignal(extra.signal, opts.signal) : extra.signal, complete: o.complete,
            });
            return r.result as T;
          } finally {
            running = false;
          }
        },
        liveLink: async () => {
          if (caps.liveLink === "window") await page.bringToFront().catch(() => {});
          return takeOverText(o.provider, caps);
        },
        newPage: async () => {
          if (closed) throw new Error("the store's browser is closed");
          if (running) throw new Error("an AI task owns the browser");
          const old = page;
          page = await o.context.newPage();
          adopt(page);
          await old.close().catch(() => {});
          log("opened a fresh tab in the same browser");
          return page;
        },
      };
      return ctx as StoreContext;
    },
    async close() {
      if (closed) return;
      closed = true;
      const extra = [...ours].filter((p) => p !== page && !isClosed(p));
      if (extra.length) o.log?.(`closing ${extra.length + 1} tabs this run opened`);
      await Promise.allSettled(extra.map((p) => p.close()));
      ours.clear();
      await o.close(page);
    },
  };
  return sb;
}

function isClosed(p: Page): boolean {
  try { return typeof p.isClosed === "function" && p.isClosed(); } catch { return true; }
}

function safeUrl(page: Page): string {
  try { return page.url(); } catch { return ""; }
}

