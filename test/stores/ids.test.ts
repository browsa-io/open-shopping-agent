// Same-item identifiers read from each store's product page, on saved fixtures. The hand-made
// fixtures in test/fixtures/ids/ copy the real page structure with a made-up product ("Northbay",
// GTINs in the GS1 restricted 04 range); the others are the stores' saved fixtures.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { amazonIds } from "../../src/stores/amazon.js";
import { walmartIds } from "../../src/stores/walmart.js";
import { bestbuyIds } from "../../src/stores/bestbuy.js";
import { ebayIds } from "../../src/stores/ebay.js";
import { parseTargetPdp, targetIdsByTcin } from "../../src/stores/target.js";
import { parseProductJs, shopifyIds } from "../../src/stores/shopify.js";
import { sameItem } from "../../src/core/identity.js";
import type { ProductIds } from "../../src/core/types.js";

const fx = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "fixtures", ...p), "utf8");
const HUB = "00042100005264";        // UPC-A 042100005264 as GTIN-14
const HUB_SILVER = "00042100005332";

test("ids: Amazon product details tables, bullets and byline", () => {
  const ids = amazonIds(fx("ids", "amazon-product.html"));
  assert.equal(ids?.gtin, HUB, "UPC from the detail bullets; its EAN-13 spelling is the same GTIN");
  assert.equal(ids?.otherGtins, undefined);
  assert.equal(ids?.mpn, "NBH7100", "Item model number");
  assert.equal(ids?.brand, "northbay");
});

test("ids: Amazon page without a details section gives no identifiers", () => {
  assert.equal(amazonIds(fx("amazon", "product-hub-variants.html"))?.gtin, undefined);
});

test("ids: Walmart JSON-LD gtin13, model and brand, specifications for the gaps", () => {
  const ids = walmartIds(fx("ids", "walmart-product.html"));
  assert.deepEqual(ids, { gtin: HUB, mpn: "NBH7100", brand: "northbay", sku: "5550001" });
  assert.equal(walmartIds(fx("walmart", "product-hub-variants.html"))?.gtin, undefined, "the saved real page has no identifiers in its trimmed data");
});

test("ids: Best Buy JSON-LD (gtin13 when shown; model as the part number)", () => {
  assert.deepEqual(bestbuyIds(fx("ids", "bestbuy-product.html")), { gtin: HUB, mpn: "NBH7100", brand: "northbay", sku: "6550001" });
  const saved = bestbuyIds(fx("bestbuy", "product.html"));
  assert.equal(saved?.brand, "logitech");
  assert.equal(saved?.mpn, "910007521", "model 910-007521");
  assert.equal(saved?.gtin, undefined);
});

test("ids: eBay JSON-LD and item specifics; 'Does not apply' and 'Unbranded' count as none", () => {
  const ids = ebayIds(fx("ids", "ebay-item.html"));
  assert.equal(ids?.gtin, HUB, "UPC from the item specifics");
  assert.equal(ids?.mpn, "NBH7100");
  assert.equal(ids?.brand, "northbay");
  assert.equal(ebayIds(fx("ids", "ebay-item-unbranded.html")), undefined);
  const saved = ebayIds(fx("ebay", "item-variation.html"));
  assert.equal(saved?.mpn, "1255BXXFT");
  assert.equal(saved?.brand, "customsign");
});

test("ids: Target barcode per TCIN, brand from the parent", () => {
  const json = JSON.parse(fx("ids", "target-pdp.json"));
  const by = targetIdsByTcin(json);
  assert.equal(by.get("90000002")?.gtin, HUB);
  assert.equal(by.get("90000003")?.gtin, HUB_SILVER);
  assert.equal(by.get("90000003")?.brand, "northbay");
  assert.equal(parseTargetPdp(json).ids.get("90000001")?.gtin, HUB);
  assert.equal(parseTargetPdp(JSON.parse(fx("target", "pdp-tshirt.json"))).ids.get("94732708")?.gtin, undefined, "no barcode in the saved page: nothing made up");
});

test("ids: Shopify variant barcode (only a valid GTIN), vendor as brand, JSON-LD for the MPN", () => {
  const coffee = parseProductJs(JSON.parse(fx("shopify", "deathwishcoffee_com-product.json")), "USD");
  const ids = shopifyIds(coffee, coffee.variants[0]);
  assert.equal(ids?.gtin, "00856413007583");
  assert.equal(ids?.brand, "deathwishcoffee", "'Death Wish Coffee Company' without the company suffix");
  const kith = parseProductJs(JSON.parse(fx("shopify", "kith_com-product.json")), "USD");
  assert.equal(shopifyIds(kith, kith.variants[0])?.gtin, undefined, "kith puts its SKU in the barcode field: not a GTIN");

  const page = fx("ids", "shopify-product-page.html");
  const prod = { ...coffee, vendor: "Northbay" };
  const withSku = shopifyIds(prod, { ...coffee.variants[0], barcode: undefined, sku: "NB-H7100-SLV" }, page);
  assert.equal(withSku?.gtin, HUB_SILVER, "the offer with this variant's SKU");
  assert.equal(withSku?.mpn, "NBH7100");
  const noSku = shopifyIds(prod, { ...coffee.variants[0], barcode: undefined, sku: undefined }, page);
  assert.equal(noSku?.gtin, undefined, "a page listing two colours' GTINs names neither");
});

test("ids: across stores, the same hub matches exactly; another colour is only similar", () => {
  const amazon = { ids: amazonIds(fx("ids", "amazon-product.html")) };
  const walmart = { ids: walmartIds(fx("ids", "walmart-product.html")) };
  const bestbuy = { ids: bestbuyIds(fx("ids", "bestbuy-product.html")) };
  const ebayNoGtin = { ids: { ...ebayIds(fx("ids", "ebay-item.html")), gtin: undefined } as ProductIds };
  const targetSilver = { ids: targetIdsByTcin(JSON.parse(fx("ids", "target-pdp.json"))).get("90000003") };
  const unbranded = { ids: ebayIds(fx("ids", "ebay-item-unbranded.html")) };
  assert.deepEqual(sameItem(amazon, walmart), { match: "exact", by: "gtin" });
  assert.deepEqual(sameItem(amazon, bestbuy), { match: "exact", by: "gtin" });
  assert.deepEqual(sameItem(amazon, ebayNoGtin), { match: "exact", by: "brand_mpn" });
  assert.deepEqual(sameItem(amazon, targetSilver), { match: "similar" }, "different GTIN, same brand: another colour");
  assert.deepEqual(sameItem(amazon, unbranded), { match: "similar" });
});
