// eBay opens item pages by clicking the result (never a raw URL in a fresh session); Best Buy adds
// from the results card when its product pages are refused; the CLI's --every-store flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import ebay, { itemIdOfUrl } from "../../src/stores/ebay.js";
import { canAddFromResults, requeryFor } from "../../src/stores/bestbuy.js";
import { parseArgs } from "../../src/cli/args.js";
import { isTransientNetError } from "../../src/stores/util.js";
import type { StoreContext } from "../../src/stores/adapter.js";

test("ebay: item id of an item page URL", () => {
  assert.equal(itemIdOfUrl("https://www.ebay.com/itm/226512345678?_skw=hub&hash=x"), "226512345678");
  assert.equal(itemIdOfUrl("https://www.ebay.com/itm/usb-c-hub/226512345678"), "226512345678");
  assert.equal(itemIdOfUrl("https://www.ebay.com/sch/i.html?_nkw=226512345678"), undefined);
  assert.equal(itemIdOfUrl("https://cart.ebay.com/"), undefined);
});

/** A fake eBay tab: a results page with one card, and a log of how pages were opened. */
function fakeEbay() {
  const id = "226512345678";
  const opened: string[] = [];
  let url = "https://www.ebay.com/sch/i.html?_nkw=usb+c+hub";
  const item = `<html><h1 class="x-item-title__mainTitle"><span>USB C Hub</span></h1><div class="x-price-primary"><span>$19.99</span></div><a id="atcBtn_btn_1">Add to cart</a></html>`;
  const link = {
    count: async () => (/\/sch\//.test(url) ? 1 : 0),
    getAttribute: async () => `https://www.ebay.com/itm/${id}`,
    evaluate: async () => undefined,
    scrollIntoViewIfNeeded: async () => undefined,
    click: async () => { opened.push("click"); url = `https://www.ebay.com/itm/${id}?_skw=usb+c+hub`; },
  };
  const page: any = {
    url: () => url,
    isClosed: () => false,
    title: async () => (/\/itm\//.test(url) ? "USB C Hub | eBay" : "usb c hub | eBay"),
    content: async () => (/\/itm\//.test(url) ? item : `<li data-listingid="${id}"><a href="https://www.ebay.com/itm/${id}">x</a></li>`),
    locator: (sel: string) => {
      if (sel.startsWith(`li[data-listingid="${id}"]`)) return { first: () => link };
      return { first: () => ({ count: async () => 0, isVisible: async () => false }), count: async () => 0, nth: () => ({ count: async () => 0 }) };
    },
    goto: async (u: string) => { opened.push(`goto ${u}`); url = u; return { status: () => 200 }; },
    waitForNavigation: async () => null,
    waitForURL: async (pred: (u: string) => boolean) => { if (!pred(url)) throw new Error("timeout"); },
    waitForLoadState: async () => undefined,
    context: () => ({ pages: () => [page], on: () => {}, off: () => {} }),
    waitForTimeout: async () => undefined,
    goBack: async () => null,
  };
  const ctx = {
    store: "ebay", domain: "ebay.com", page, agentId: "agt_t", log: () => {}, signal: new AbortController().signal,
    aiTask: async () => { throw new Error("no AI"); }, liveLink: async () => "x", newPage: async () => page,
  } as unknown as StoreContext;
  return { ctx, opened, id };
}

test("ebay: details() opens the item by clicking its result card, not by its URL", async () => {
  const { ctx, opened, id } = fakeEbay();
  const o = await ebay.details!(ctx, { store: "ebay", storeDomain: "ebay.com", itemId: "i", title: "USB C Hub", url: `https://www.ebay.com/itm/${id}`, productId: id, price: { cents: 1999, currency: "USD" } });
  assert.deepEqual(opened, ["click"]);
  assert.equal(o.title, "USB C Hub");
  assert.ok(!opened.some((x) => x.includes("/itm/")), "never typed the item URL");
});

test("bestbuy: add from the results only when no option is asked and the product page was refused", () => {
  assert.ok(canAddFromResults(undefined, "Best Buy refused the browser twice (Access Denied). Its bot wall blocks this exit address"));
  assert.ok(canAddFromResults({ condition: "new" }, "Best Buy did not load https://www.bestbuy.com/site/1.p: net::ERR_HTTP2_PROTOCOL_ERROR"));
  assert.ok(!canAddFromResults({ Color: "Black" }, "Best Buy refused the browser twice"));
  assert.ok(!canAddFromResults(undefined, "Best Buy kept the browser in its queue; try again later"));
  assert.equal(requeryFor({ title: "Belkin - 5-Port Hub w/ 4K HDMI Display, 100W PD - Space Gray" }), "Belkin 5 Port Hub w 4K HDMI");
});

test("cli: --every-store", () => {
  assert.equal(parseArgs(["hub", "--every-store"]).everyStore, true);
  assert.equal(parseArgs(["hub"]).everyStore, false);
});

test("util: an interrupted navigation is retried like a network hiccup", () => {
  assert.ok(isTransientNetError(new Error('page.goto: Navigation to "https://www.amazon.com/s?k=hub" is interrupted by another navigation to "https://www.amazon.com/"')));
  assert.ok(!isTransientNetError(new Error("net::ERR_HTTP2_PROTOCOL_ERROR")));
});
