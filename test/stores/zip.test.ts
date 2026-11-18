// --zip on Best Buy and Walmart: set the store's delivery ZIP the way a guest can, check that it
// took, and say so in the run notes and the cart when it did not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import bestbuy, { cartShipZip } from "../../src/stores/bestbuy.js";
import walmart, { walmartZip } from "../../src/stores/walmart.js";
import { zip5, zipNotTaken } from "../../src/stores/util.js";
import type { StoreContext } from "../../src/stores/adapter.js";
import type { StoreId } from "../../src/core/types.js";

const fx = (store: string, name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${store}/${name}`, import.meta.url)), "utf8");

/**
 * A store page with a location box. `zip` is what the store uses; `accepts` says whether typing a
 * ZIP in its box changes it. `html(zip)` renders the page for that ZIP.
 */
function fakeStore(o: { zip: string; accepts: boolean; opener: string; hasBox?: boolean; html: (zip: string) => string }) {
  let zip = o.zip;
  let open = false;
  let typed = "";
  const filled: string[] = [];
  let url = "about:blank";
  const el = (sel: string) => {
    const visible = () => sel === o.opener || (open && o.hasBox !== false && /ZIP|zip|postal|delivery-input/.test(sel));
    const one = {
      isVisible: async () => visible(),
      click: async () => { if (sel === o.opener) open = true; else if (open && o.accepts && typed) zip = typed; },
      fill: async (v: string) => { typed = v; filled.push(v); },
      press: async () => { if (o.accepts && typed) zip = typed; },
      getAttribute: async (a: string) => (a === "type" ? "text" : null),
    };
    return { count: async () => (visible() ? 1 : 0), nth: () => one, first: () => one };
  };
  const page = {
    goto: async (u: string) => { url = u; open = false; return null; },
    url: () => url,
    content: async () => o.html(zip),
    title: async () => "Store",
    isClosed: () => false,
    waitForTimeout: async () => {},
    waitForSelector: async () => null,
    waitForLoadState: async () => {},
    locator: (sel: string) => el(sel),
    mouse: { wheel: async () => {} },
  } as unknown as Page;
  return { page, filled, zip: () => zip };
}

function ctxOn(page: Page, store: StoreId, zip?: string): StoreContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    store, domain: `${store}.com`, page, zip, agentId: "agt_1", signal: new AbortController().signal, logs,
    log: (m: string) => logs.push(m),
    aiTask: async () => { throw new Error("no AI in this test"); },
    liveLink: async () => "https://example.com/live",
    newPage: async () => page,
  } as unknown as StoreContext & { logs: string[] };
}

const bbCart = (zip: string) => `<html><body><section data-test-sku="6630902"><div data-testid="availability-option">Shipping to ${zip}<button aria-label="Update location">Change</button></div></section></body></html>`;
const BB_OPENER = "button[aria-label=\"Update location\"]";
const wmPage = (zip: string) => `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"initialData":{"pageMetadata":{"location":{"postalCode":"${zip}","city":"X"}}}}}}</script></body></html>`;
const WM_OPENER = "[data-testid=\"gic-wrapper\"]";

test("zip: the ZIP each store shows", () => {
  assert.equal(cartShipZip(fx("bestbuy", "cart.html")), "00000");
  assert.equal(cartShipZip("<div>Shipping to 96939<button>Change</button></div>"), "96939");
  assert.equal(cartShipZip("<div>$96,939.00</div>"), undefined);
  assert.equal(walmartZip(fx("walmart", "product-hub-variants.html")), "95829");
  assert.equal(walmartZip(wmPage("10001")), "10001");
  assert.equal(walmartZip("<html></html>"), undefined);
  assert.equal(zip5("New York, 10001-1234"), "10001");
  assert.equal(zipNotTaken("Walmart", "10001", "95829"), "Walmart did not take ZIP 10001 without an account; its prices, shipping and delivery are for ZIP 95829");
});

test("best buy: a cart for another ZIP gets the run's ZIP through its Change box", async () => {
  const s = fakeStore({ zip: "96939", accepts: true, opener: BB_OPENER, html: bbCart });
  const ctx = ctxOn(s.page, "bestbuy", "10001");
  const cart = await bestbuy.readCart(ctx);
  assert.equal(s.zip(), "10001");
  assert.deepEqual(s.filled, ["10001"], "types the ZIP and nothing else");
  assert.deepEqual(cart.warnings, []);
  assert.ok(ctx.logs.includes("Best Buy: cart ships to ZIP 10001"));
});

test("best buy: when it keeps its own ZIP, the notes and the cart say so (once)", async () => {
  const s = fakeStore({ zip: "96939", accepts: false, opener: BB_OPENER, html: bbCart });
  const ctx = ctxOn(s.page, "bestbuy", "10001");
  const a = await bestbuy.readCart(ctx);
  const b = await bestbuy.readCart(ctx);
  const note = "Best Buy did not take ZIP 10001 without an account; its prices, shipping and delivery are for ZIP 96939";
  assert.deepEqual(a.warnings, [note]);
  assert.deepEqual(b.warnings, [note]);
  assert.equal(ctx.logs.filter((l) => l === note).length, 1);
  assert.equal(s.filled.length, 1, "the Change box is tried once");
});

test("best buy: no --zip, nothing typed", async () => {
  const s = fakeStore({ zip: "96939", accepts: true, opener: BB_OPENER, html: bbCart });
  const cart = await bestbuy.readCart(ctxOn(s.page, "bestbuy"));
  assert.deepEqual(s.filled, []);
  assert.deepEqual(cart.warnings, []);
});

test("walmart: the run's ZIP goes into Walmart's own location box and is checked", async () => {
  const s = fakeStore({ zip: "95829", accepts: true, opener: WM_OPENER, html: wmPage });
  const ctx = ctxOn(s.page, "walmart", "10001");
  const cart = await walmart.readCart(ctx);
  assert.equal(s.zip(), "10001");
  assert.deepEqual(s.filled, ["10001"]);
  assert.deepEqual(cart.warnings, []);
  assert.ok(ctx.logs.includes("Walmart: delivery ZIP set to 10001"));
});

test("walmart: no box for a guest, or the ZIP did not stick: the notes and the cart say so", async () => {
  for (const hasBox of [false, true]) {
    const s = fakeStore({ zip: "95829", accepts: false, hasBox, opener: WM_OPENER, html: wmPage });
    const ctx = ctxOn(s.page, "walmart", "10001");
    const cart = await walmart.readCart(ctx);
    const note = "Walmart did not take ZIP 10001 without an account; its prices, shipping and delivery are for ZIP 95829";
    assert.deepEqual(cart.warnings, [note], `box ${hasBox}`);
    assert.ok(ctx.logs.includes(note));
  }
});
