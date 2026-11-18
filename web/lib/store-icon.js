// A store's own site icon, 16-20 px, loaded through this server (/api/icon), which fetched it once
// from the store's site. When there is no icon (offline, a bot wall) a colored circle with the
// store's initial shows instead. Decorative: the store's name is always next to it or in a label.

import { h } from "./dom.js";
import { storeName } from "./wording.js";

/** Fallback colors for the built-in stores; a Shopify shop gets one from its domain. */
const HUES = { amazon: 32, walmart: 212, ebay: 0, bestbuy: 224, target: 354, shopify: 140 };
const failed = new Set();

function hueOf(store, domain) {
  if (!(store === "shopify" && domain) && HUES[store] !== undefined) return HUES[store];
  let n = 0;
  for (const c of String(domain || store)) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
}

export function iconUrl(store, domain) {
  return store === "shopify" && domain
    ? `/api/icon?store=shopify&domain=${encodeURIComponent(domain)}`
    : `/api/icon?store=${encodeURIComponent(store)}`;
}

/** size: "sm" 16 px, "md" 18 px (default), "lg" 20 px. */
export function storeIcon(store, domain, size = "md") {
  const name = storeName(store, domain);
  const letter = (name.replace(/^www\./, "")[0] || "?").toUpperCase();
  const src = iconUrl(store, domain);
  const el = h("span", { class: `sico ${size}`, "aria-hidden": "true" });
  el.style.setProperty("--sico-h", String(hueOf(store, domain)));
  const fallback = () => { el.classList.add("fb"); el.replaceChildren(letter); };
  if (failed.has(src)) { fallback(); return el; }
  el.append(h("img", {
    src, alt: "", decoding: "async", draggable: "false", width: 20, height: 20,
    onerror: () => { failed.add(src); fallback(); },
  }));
  return el;
}

/** Icon and name together, for a store label. */
export function storeLabel(store, domain, size = "md", cls = "") {
  return h("span", { class: `slabel ${cls}`.trim() }, storeIcon(store, domain, size), h("span", { class: "slabel-name" }, storeName(store, domain)));
}
