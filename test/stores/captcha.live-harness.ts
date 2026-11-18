// Live check of Browsa's in-session solver from OSA: one fresh Phantom browser on Browsa opens
// Google's public reCAPTCHA demo, OSA asks Browsa.solveCaptcha through solveWithBrowsa, then
// submits the demo form and reads the page's verdict. The browser is destroyed at the end.
//
//   OSA_LIVE=1 BROWSA_API_KEY=agt_... npx tsx test/stores/captcha.live-harness.ts
//
// Not run by `npm test`. Touches no store.

import { Client } from "browsa";
import { chromium } from "playwright-core";
import type { StoreContext } from "../../src/stores/adapter.js";
import { solveWithBrowsa } from "../../src/stores/captcha.js";

const DEMO = "https://www.google.com/recaptcha/api2/demo";

async function main(): Promise<void> {
  if (process.env.OSA_LIVE !== "1" || !process.env.BROWSA_API_KEY) {
    console.log("skipped: set OSA_LIVE=1 and BROWSA_API_KEY");
    return;
  }
  const apiKey = process.env.BROWSA_API_KEY;
  const client = new Client({ apiKey, timeoutMs: 120_000 });
  let agent: Record<string, any> | undefined;
  // The workspace has a fixed number of browser slots; wait for one (up to 15 minutes).
  for (let i = 0; !agent; i++) {
    try {
      agent = await client.createAgent({ ttl: "10m" }) as Record<string, any>;
    } catch (e) {
      if ((e as { status?: number }).status !== 429 || i >= 30) throw e;
      console.log("all browser slots busy; waiting 30 s");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  const agentId: string = agent.agent_id ?? agent.id;
  console.log(`browser ${agentId}`);
  const t0 = Date.now();
  try {
    const browser = await chromium.connectOverCDP(agent.cdp_http, { headers: { "X-API-Key": apiKey }, timeout: 60_000 });
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(DEMO, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("iframe[title*='reCAPTCHA']").first().waitFor({ timeout: 30_000 });
    const logs: string[] = [];
    const ctx = {
      store: "shopify", domain: "google.com", page, agentId, signal: new AbortController().signal,
      log: (m: string) => { logs.push(m); console.log(`  note: ${m}`); },
      aiTask: async () => { throw new Error("no AI task in this check"); },
      liveLink: async () => (await client.createLiveLink(agentId, { scope: "control", ttlSeconds: 600 })).live_url,
      newPage: async () => page,
    } as unknown as StoreContext;
    const token = () => page.evaluate(() => (document.querySelector("#g-recaptcha-response") as HTMLTextAreaElement | null)?.value ?? "");
    const isBlocked = async () => !(await token());
    const outcome = await solveWithBrowsa(ctx, { store: "The reCAPTCHA demo", isBlocked, check: "a reCAPTCHA" });
    console.log(`outcome ${JSON.stringify(outcome)} (token ${(await token()).length} chars)`);
    if (outcome.status === "solved") {
      await Promise.all([page.waitForLoadState("domcontentloaded"), page.locator("#recaptcha-demo-submit").click()]);
      await page.waitForTimeout(2000);
      const verdict = (await page.locator("body").innerText()).match(/Verification Success[^\n]*/)?.[0];
      console.log(`demo page says: ${verdict ?? "no success message"}`);
    }
    await browser.close().catch(() => {});
  } finally {
    await client.destroyAgent(agentId).catch((e) => console.log(`destroy failed: ${(e as Error).message}`));
    console.log(`browser destroyed after ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
