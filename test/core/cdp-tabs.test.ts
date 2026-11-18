// A CDP browser is often the person's own Chrome: a run closes the tabs it opened and no others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { CdpProvider } from "../../src/core/providers/index.js";
import { ShoppingAgent } from "../../src/core/engine.js";
import { FakeAdapter, offer } from "./fake-adapter.js";

class FakeTab extends EventEmitter {
  closed = false;
  constructor(readonly name: string, private all: FakeTab[]) { super(); all.push(this); }
  url() { return `https://example.com/${this.name}`; }
  isClosed() { return this.closed; }
  async close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  /** The store opens a new tab from this one (a link with target=_blank, window.open). */
  popup(name: string) { const t = new FakeTab(name, this.all); this.emit("popup", t); return t; }
  async goto() { return null; }
  async bringToFront() {}
}

function fakeChrome() {
  const tabs: FakeTab[] = [];
  const mine = new FakeTab("my-mail", tabs); // the person's own tab, open before the run
  let n = 0;
  const ctx = { pages: () => tabs.filter((t) => !t.closed), newPage: async () => new FakeTab(`osa-${++n}`, tabs), on() {}, off() {} };
  let disconnected = 0;
  const browser = { contexts: () => [ctx], close: async () => { disconnected++; }, isConnected: () => true } as unknown as Browser;
  return { tabs, mine, browser, disconnected: () => disconnected };
}

test("cdp: closing a store closes its tab and the tabs it opened, never the person's own", async () => {
  const c = fakeChrome();
  const p = new CdpProvider({ url: "ws://127.0.0.1:9222/devtools/browser/x", env: {}, connect: async () => c.browser });
  const b = await p.open("ebay");
  const first = b.page as unknown as FakeTab;
  const item = first.popup("item"); // eBay opens an item in a new tab
  const checkout = item.popup("checkout");
  const ctx = b.context("ebay.com", { signal: new AbortController().signal });
  const fresh = (await ctx.newPage()) as unknown as FakeTab; // a dead tab replaced
  assert.ok(first.closed, "the replaced tab is closed at once");
  const fromFresh = fresh.popup("cart");
  await b.close();
  for (const t of [item, checkout, fresh, fromFresh]) assert.ok(t.closed, `${t.name} closed`);
  assert.equal(c.mine.closed, false, "the person's own tab stays");
  assert.deepEqual(c.tabs.filter((t) => !t.closed).map((t) => t.name), ["my-mail"]);
  assert.equal(c.disconnected(), 1, "disconnects; the browser keeps running");
});

test("cdp: a stopped run closes its tabs in the person's browser", async () => {
  const c = fakeChrome();
  const provider = new CdpProvider({ url: "ws://127.0.0.1:9222/devtools/browser/x", env: {}, connect: async () => c.browser });
  class PopupAdapter extends FakeAdapter {
    override async search(ctx: Parameters<FakeAdapter["search"]>[0], item: Parameters<FakeAdapter["search"]>[1], limit: number) {
      (ctx.page as unknown as FakeTab).popup("result");
      return super.search(ctx, item, limit);
    }
  }
  const dataDir = await mkdtemp(join(tmpdir(), "osa-cdp-"));
  const agent = new ShoppingAgent({ llm: false, dataDir, browser: provider, watchLinks: false, history: false,
    adapters: { walmart: new PopupAdapter("walmart", { catalog: { hub: [offer("walmart", "USB-C hub", 20)] } }) } });
  const run = await agent.run("a usb-c hub on walmart", { onEvent: () => {}, until: "picks", close: false });
  assert.ok(c.tabs.filter((t) => !t.closed).length >= 3, "the store tab and the tab it opened are open during the run");
  await run.close({ settle: false });
  assert.deepEqual(c.tabs.filter((t) => !t.closed).map((t) => t.name), ["my-mail"]);
});
