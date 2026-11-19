import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gtinCheckOk, idsFromJsonLd, idsFromMicrodata, idsFromSpecs, labelSameItem, mergeIds, normalizeBrand, normalizeGtin, normalizeIds, normalizeMpn, sameItem,
} from "../../src/core/identity.js";
import { offer } from "./fake-adapter.js";

test("identity: GTINs normalise to GTIN-14 and need a valid check digit", () => {
  assert.equal(normalizeGtin("042100005264"), "00042100005264", "UPC-A");
  assert.equal(normalizeGtin("0042100005264"), "00042100005264", "the same as EAN-13");
  assert.equal(normalizeGtin("4006381333931"), "04006381333931", "EAN-13");
  assert.equal(normalizeGtin("96385074"), "00000096385074", "GTIN-8");
  assert.equal(normalizeGtin(42100005264), undefined, "a number loses the leading zero: 11 digits is no GTIN");
  assert.equal(normalizeGtin("042100005265"), undefined, "wrong check digit");
  assert.equal(normalizeGtin("2000227280"), undefined, "a shop's SKU in the barcode field");
  assert.equal(normalizeGtin("000000000000"), undefined);
  assert.equal(normalizeGtin("Does not apply"), undefined);
  assert.equal(normalizeGtin("0421-0000-5264"), "00042100005264", "dashes and spaces are dropped");
  assert.ok(gtinCheckOk("036000291452"));
});

test("identity: MPN and brand normalise; placeholders count as none", () => {
  assert.equal(normalizeMpn("NB-H7100"), "NBH7100");
  assert.equal(normalizeMpn(" 910-007521 "), "910007521");
  assert.equal(normalizeMpn("Does Not Apply"), undefined);
  assert.equal(normalizeMpn("N/A"), undefined);
  assert.equal(normalizeMpn("XL"), undefined, "too short");
  assert.equal(normalizeMpn("BLACK"), undefined, "a word, not a part number");
  assert.equal(normalizeBrand("Logitech, Inc."), "logitech");
  assert.equal(normalizeBrand({ "@type": "Brand", name: "Anker®" }), "anker");
  assert.equal(normalizeBrand("Visit the Northbay Store"), "northbay");
  assert.equal(normalizeBrand("Brand: Northbay"), "northbay");
  assert.equal(normalizeBrand("Unbranded"), undefined);
  assert.equal(normalizeBrand("Generic"), undefined);
  assert.deepEqual(normalizeIds({ gtin: "bad", gtins: ["042100005264", "0042100005264", "042100005332"], mpn: "NB-H7100", brand: "Northbay" }),
    { gtin: "00042100005264", otherGtins: ["00042100005332"], mpn: "NBH7100", brand: "northbay" });
  assert.equal(normalizeIds({ gtin: "x", brand: "n/a" }), undefined);
});

test("identity: JSON-LD, microdata and spec rows", () => {
  assert.deepEqual(idsFromJsonLd([{ "@type": "BreadcrumbList" }, { "@type": ["Product"], gtin12: "042100005264", brand: "Northbay", mpn: "NB-H7100" }]),
    { gtin: "00042100005264", mpn: "NBH7100", brand: "northbay" });
  assert.equal(idsFromJsonLd([{ "@type": "Product", offers: [{ gtin13: "0042100005264" }, { gtin13: "0042100005264" }] }])?.gtin, "00042100005264", "every offer names one GTIN");
  assert.equal(idsFromJsonLd([{ "@type": "Product", offers: [{ gtin13: "0042100005264" }, { gtin13: "0042100005332" }] }]), undefined, "two colours: no guess");
  assert.equal(idsFromJsonLd([{ "@type": "Product", name: "x" }]), undefined);
  const micro = `<div itemscope itemtype="https://schema.org/Product"><meta itemprop="gtin13" content="0042100005264"><span itemprop="mpn" content="NB-H7100">NB-H7100</span><meta itemprop="brand" content="Northbay"></div>`;
  assert.deepEqual(idsFromMicrodata(micro), { gtin: "00042100005264", mpn: "NBH7100", brand: "northbay" });
  assert.deepEqual(idsFromSpecs([["UPC", "042100005264 042100005332"], ["Item model number", "NB-H7100"], ["Brand Name", "Northbay"], ["Color", "Gray"]]),
    { gtin: "00042100005264", otherGtins: ["00042100005332"], mpn: "NBH7100", brand: "northbay" });
  assert.deepEqual(idsFromSpecs([["Model", "M-1000"], ["Manufacturer Part Number", "PX-1000"]]), { mpn: "PX1000" }, "a part number wins over a model name");
  assert.deepEqual(idsFromSpecs([["Model", "M-1000"]]), { mpn: "M1000" });
  assert.deepEqual(mergeIds({ gtin: "1", brand: "a" }, { gtin: "2", mpn: "m", brand: "b" }), { gtin: "1", otherGtins: ["2"], mpn: "m", brand: "a" });
});

test("identity: exact only on proof; different GTINs are different items", () => {
  const hub = { ids: { gtin: "00042100005264", brand: "northbay", mpn: "NBH7100" } };
  assert.deepEqual(sameItem(hub, { ids: { gtin: "00042100005264" } }), { match: "exact", by: "gtin" });
  assert.deepEqual(sameItem(hub, { ids: { gtin: "00099999999999", otherGtins: ["00042100005264"] } }), { match: "exact", by: "gtin" }, "any shared GTIN");
  assert.deepEqual(sameItem(hub, { ids: { gtin: "00042100005332", brand: "northbay", mpn: "NBH7100" } }), { match: "similar" }, "same model, other colour");
  assert.deepEqual(sameItem(hub, { ids: { brand: "northbay", mpn: "NBH7100" } }), { match: "exact", by: "brand_mpn" });
  assert.deepEqual(sameItem(hub, { ids: { brand: "otherbrand", mpn: "NBH7100" } }), { match: "similar" });
  assert.deepEqual(sameItem(hub, { ids: { mpn: "NBH7100" } }), { match: "similar" }, "an MPN without a brand proves nothing");
  assert.deepEqual(sameItem(hub, {}), { match: "similar" });
  assert.deepEqual(sameItem({}, {}), { match: "similar" });
});

test("identity: labelSameItem labels every offer, drops none, leaves the reference alone", () => {
  const ref = offer("amazon", "Northbay hub", 25, { ids: { gtin: "00042100005264" } });
  const list = [
    ref,
    offer("walmart", "Northbay 7-in-1 hub", 24, { ids: { gtin: "00042100005264" } }),
    offer("ebay", "USB-C hub 7 in 1", 9),
    offer("target", "Northbay hub silver", 26, { ids: { gtin: "00042100005332" }, match: "exact", matchBy: "gtin" }),
  ];
  const out = labelSameItem(ref, list);
  assert.equal(out.length, 4);
  assert.equal(out[0], ref);
  assert.equal(out[0].match, undefined);
  assert.deepEqual(out.slice(1).map((o) => [o.store, o.match, o.matchBy]), [["walmart", "exact", "gtin"], ["ebay", "similar", undefined], ["target", "similar", undefined]]);
  assert.equal(list[1].match, undefined, "copies, the input is not changed");
});
