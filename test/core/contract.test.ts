// Contract additions of v1 hardening: ItemRequest.condition, Offer.subscribeAndSaveAvailable,
// OrderResult.error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conditionFromText, normalizeLLMAnswer, parseRules } from "../../src/core/parse.js";
import { pickForItem } from "../../src/core/rank.js";
import { ShoppingAgent, normalizeRequest } from "../../src/core/engine.js";
import { approvalFor } from "../../src/core/limits.js";
import type { Approval, ItemRequest, OrderResult, RunEvent } from "../../src/core/types.js";
import type { StoreContext } from "../../src/stores/adapter.js";
import { searchUrlFor, wantedCondition } from "../../src/stores/ebay.js";
import { FakeAdapter, fakeBrowsers, offer } from "./fake-adapter.js";

const item = (extra: Partial<ItemRequest> = {}): ItemRequest => ({ id: "item-1", query: "usb c hub", description: "a usb c hub", quantity: 1, ...extra });

test("condition: the rule parser reads used, refurbished and new or used", () => {
  assert.equal(conditionFromText("a used usb c hub"), "used");
  assert.equal(conditionFromText("refurbished iPad"), "used");
  assert.equal(conditionFromText("pre-owned switch, open box ok"), "used");
  assert.equal(conditionFromText("a hub, new or used"), "any");
  assert.equal(conditionFromText("brand new hub"), "new");
  assert.equal(conditionFromText("usb c hub"), undefined);
  const used = parseRules("a used usb c hub under $30").items[0];
  assert.equal(used.condition, "used");
  assert.doesNotMatch(used.query, /\bused\b/, "the filter word leaves the search text");
  const refurb = parseRules("refurbished ipad mini").items[0];
  assert.equal(refurb.condition, "used");
  assert.match(refurb.query, /refurbished/, "refurbished stays: stores list it as a product");
  assert.equal(parseRules("usb c hub").items[0].condition, undefined);
});

test("condition: model answers are validated, with the words as fallback", () => {
  const base = { query: "usb c hub", quantity: 1, options: [], maxPriceUsd: null, mustHave: [], niceToHave: [] };
  const r = normalizeLLMAnswer("x", { items: [
    { ...base, description: "a hub", condition: "any" },
    { ...base, description: "a used hub", condition: "bogus" },
    { ...base, description: "a hub", condition: null },
  ] });
  assert.deepEqual(r.items.map((i) => i.condition), ["any", "used", undefined]);
  const n = normalizeRequest({ prompt: "x", stores: ["ebay"], items: [item({ condition: "weird" as never }), item({ condition: "used" })] });
  assert.deepEqual(n.items.map((i) => i.condition), [undefined, "used"]);
  assert.equal("condition" in n.items[0], false);
});

test("condition: eBay filters its search by it", () => {
  assert.equal(wantedCondition(item()), "new");
  assert.equal(wantedCondition(item({ condition: "used" })), "not_new");
  assert.equal(wantedCondition(item({ condition: "used", description: "a refurbished hub" })), "refurbished");
  assert.equal(wantedCondition(item({ condition: "any" })), "any");
  assert.equal(wantedCondition(item({ options: { condition: "used" } })), "used", "the older option still works");
  assert.equal(new URL(searchUrlFor("hub", { condition: "not_new" })).searchParams.get("LH_ItemCondition"), "3000|2000|2010|2020|2030|2500");
  assert.equal(new URL(searchUrlFor("hub", { condition: "any" })).searchParams.has("LH_ItemCondition"), false);
  assert.equal(new URL(searchUrlFor("hub")).searchParams.get("LH_ItemCondition"), "1000");
});

test("condition: ranking accepts used offers when the item allows them", () => {
  const offers = [offer("ebay", "USB-C Hub", 15, { condition: "used" }), offer("amazon", "USB-C Hub", 17)];
  assert.equal(pickForItem(item(), offers, { goal: "cheapest" })!.offer.store, "amazon");
  assert.equal(pickForItem(item({ condition: "used" }), offers, { goal: "cheapest" })!.offer.store, "ebay");
  assert.equal(pickForItem(item({ condition: "any" }), offers, { goal: "cheapest" })!.offer.store, "ebay");
  assert.equal(pickForItem(item({ condition: "new", query: "used usb c hub" }), offers, { goal: "cheapest" })!.offer.store, "amazon");
});

class ChangingTotal extends FakeAdapter {
  constructor(private mode: "return" | "throw") { super("walmart", { catalog: { hub: [offer("walmart", "USB-C hub", 30)] } }); }
  async placeOrder(_ctx: StoreContext, approval: Approval): Promise<OrderResult> {
    this.calls.placeOrder++;
    const msg = `Walmart total is now $31.00, approved ${approval.approvedTotal.cents / 100}; order not placed`;
    if (this.mode === "throw") throw new Error(msg);
    return { store: "walmart", placed: false, total: { cents: 3100, currency: "USD" }, error: msg };
  }
}

test("OrderResult.error: a returned error is a known failure; a throw is an unknown order that is never retried", async () => {
  for (const mode of ["return", "throw"] as const) {
    const events: RunEvent[] = [];
    const agent = new ShoppingAgent({
      llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-c-")), adapters: { walmart: new ChangingTotal(mode) },
      openBrowser: fakeBrowsers().open, watchLinks: false, orderVerifyDelayMs: 0,
    });
    const run = await agent.run("a usb-c hub on walmart", { onEvent: (e) => events.push(e), until: "review" });
    const review = run.reviews.get("walmart")!;
    const r = await run.approve("walmart", approvalFor(review));
    assert.equal(r.placed, false);
    assert.match(r.error ?? "", /total is now \$31\.00/);
    const ev = events.find((e) => e.type === "order");
    assert.ok(ev && ev.type === "order" && ev.result.error);
    assert.equal(events.some((e) => e.type === "store_failed" && e.stage === "place_order"), mode === "throw");
    if (mode === "return") {
      // Returned before the click: nothing was submitted, so a new review may be approved again.
      assert.equal(r.state, "failed");
      assert.ok(events.some((e) => e.type === "log" && /Order not placed: Walmart total is now/.test(e.message)));
      await run.reviewCheckout("walmart");
    } else {
      // A throw may come after the click: unknown, with a message to check the store, and no new checkout.
      assert.equal(r.state, "unknown");
      assert.match(r.checkMessage ?? "", /Check your orders on Walmart/);
      await assert.rejects(run.reviewCheckout("walmart"), /may have gone through/);
    }
    await run.close();
  }
});

test("a Shopify shop given outside the prompt (--stores satechi.com, settings) is searched", async () => {
  assert.equal(parseRules("usb c hub", { defaultStores: ["amazon", "shopify"] }).stores.includes("shopify"), false);
  assert.deepEqual(parseRules("usb c hub", { defaultStores: ["amazon", "shopify"], hasShopifyDomains: true }).stores, ["amazon", "shopify"]);
  const fb = fakeBrowsers();
  const agent = new ShoppingAgent({
    llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-s-")), openBrowser: fb.open, watchLinks: false,
    adapters: { shopify: new FakeAdapter("shopify", { catalog: { hub: [offer("shopify", "USB-C hub", 30, { storeDomain: "satechi.com" })] } }) },
  });
  const run = await agent.run("a usb-c hub", { until: "picks", defaultStores: ["shopify"], shopifyDomains: ["satechi.com"] });
  assert.deepEqual(run.request.stores, ["shopify"]);
  assert.deepEqual(fb.log.opened, [{ store: "shopify", domain: "satechi.com" }]);
});

class DyingTab extends FakeAdapter {
  deaths: number;
  constructor(deaths: number, private addedBeforeDeath: boolean) { super("amazon", { catalog: { hub: [offer("amazon", "USB-C hub", 30, { productId: "B0HUB" })] } }); this.deaths = deaths; }
  async addToCart(ctx: StoreContext, o: Parameters<FakeAdapter["addToCart"]>[1], q: number) {
    if (this.deaths > 0) {
      this.deaths--;
      if (this.addedBeforeDeath) this.cart.push({ title: o.title, quantity: q, price: o.price, productId: o.productId });
      throw new Error("page.content: Target page, context or browser has been closed");
    }
    return super.addToCart(ctx, o, q);
  }
}

test("engine: a tab that dies during a step is replaced and the step runs once more, never adding twice", async () => {
  for (const added of [false, true]) {
    const a = new DyingTab(1, added);
    const events: RunEvent[] = [];
    const agent = new ShoppingAgent({ llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-d-")), openBrowser: fakeBrowsers().open, watchLinks: false, adapters: { amazon: a } });
    const run = await agent.run("a usb-c hub on amazon", { onEvent: (e) => events.push(e), until: "cart" });
    assert.equal(run.carts.get("amazon")?.lines.length, 1, added ? "the add went through before the tab died: not added again" : "added in the fresh tab");
    assert.ok(events.some((e) => e.type === "log" && /tab died .*retrying in a fresh tab/.test(e.message)));
    assert.equal(events.some((e) => e.type === "store_failed"), false);
    await run.close();
  }
  const twice = new DyingTab(2, false);
  const agent = new ShoppingAgent({ llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-d-")), openBrowser: fakeBrowsers().open, watchLinks: false, adapters: { amazon: twice } });
  const events: RunEvent[] = [];
  const run = await agent.run("a usb-c hub on amazon", { onEvent: (e) => events.push(e), until: "cart" });
  assert.ok(events.some((e) => e.type === "store_failed" && e.stage === "cart"), "a second death fails the step");
  await run.close();
});

test("engine: browsers of stores without a pick stop right after the picks", async () => {
  const fb = fakeBrowsers();
  const events: RunEvent[] = [];
  const agent = new ShoppingAgent({
    llm: false, dataDir: await mkdtemp(join(tmpdir(), "osa-r-")), openBrowser: fb.open, watchLinks: false,
    adapters: {
      amazon: new FakeAdapter("amazon", { catalog: { hub: [offer("amazon", "USB-C hub", 30)] } }),
      walmart: new FakeAdapter("walmart", { catalog: { hub: [offer("walmart", "USB-C hub", 45)] } }),
    },
  });
  const run = await agent.run("a usb-c hub on amazon or walmart", { onEvent: (e) => events.push(e), until: "picks", close: false });
  assert.deepEqual(run.picks.map((p) => p.offer.store), ["amazon"]);
  assert.deepEqual(fb.log.closed, ["walmart"], "walmart had no pick: its browser is stopped");
  assert.ok(events.some((e) => e.type === "log" && e.store === "walmart" && /No pick here/.test(e.message)));
  await run.fillCart("amazon");
  await run.close();
  assert.deepEqual(fb.log.closed.sort(), ["amazon", "walmart"], "each browser stopped once");
});
