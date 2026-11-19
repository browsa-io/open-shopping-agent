// Open Shopping Agent web app. No framework, no build step. The router and the home and settings
// pages live here; the run page, compare, checkout, history, watches, summary and shortcuts are in
// web/components/, shared logic in web/lib/.

import { api, confirmDialog, h, toast } from "./lib/dom.js";
import { ALL_STORES, STORE_NAMES } from "./lib/wording.js";
import { storeIcon } from "./lib/store-icon.js";
import { runView } from "./components/run.js";
import { summaryView } from "./components/summary.js";
import { historyView } from "./components/history.js";
import { ordersView } from "./components/orders.js";
import { watchesView } from "./components/watches.js";
import { installShortcuts } from "./components/keys.js";

const EXAMPLES = [
  "usb-c hub with hdmi and a 6 ft hdmi cable under $60",
  "65W usb-c charger",
  "wireless mouse and keyboard under $80",
  "2 x hdmi cable 10 ft",
];

const main = document.getElementById("main");
let meta = { demo: false };
const app = { get meta() { return meta; } };
let closeCurrent = null;

function setNav(name) {
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

// ---------- router ----------

async function route() {
  closeCurrent?.();
  closeCurrent = null;
  document.getElementById("keys-help")?.close();
  const hash = location.hash.replace(/^#/, "") || "/";
  const [, page, arg, sub] = hash.split("/");
  main.replaceChildren();
  main.className = "";
  try {
    if (page === "run" && arg && sub === "summary") { setNav(""); await summaryView(main, decodeURIComponent(arg)); }
    else if (page === "run" && arg) { setNav(""); closeCurrent = await runView(main, decodeURIComponent(arg), app); }
    else if (page === "history") { setNav("history"); await historyView(main); }
    else if (page === "orders") { setNav("orders"); await ordersView(main, app); }
    else if (page === "watches") { setNav("watches"); await watchesView(main, app); }
    else if (page === "settings") { setNav("settings"); await settingsView(); }
    else { setNav("new"); await homeView(); }
  } catch (e) {
    main.replaceChildren(h("div", { class: "card empty" },
      h("p", {}, /not found/i.test(e.message) ? "This search is not on this computer any more." : e.message),
      h("p", {}, h("a", { class: "btn", href: "#/" }, "New search"))));
  }
  // Focus the page for screen readers without drawing a focus ring around it.
  main.focus({ preventScroll: true, focusVisible: false });
  window.scrollTo(0, 0);
}

// ---------- home ----------

async function homeView() {
  const [settings, recent] = await Promise.all([api("/api/settings").catch(() => null), api("/api/runs?limit=3").catch(() => [])]);
  document.title = "Open Shopping Agent";
  const ta = h("textarea", {
    id: "prompt", name: "prompt", rows: 2, maxlength: 500, required: true, "data-slash": "1",
    placeholder: "What do you want to buy?", "aria-describedby": "prompt-hint",
  });
  const stores = settings?.allowedStores || ["amazon", "walmart", "ebay", "bestbuy", "target"];
  const zip = h("input", { type: "text", id: "zip", inputmode: "numeric", maxlength: 5, pattern: "\\d{5}", placeholder: "10001", value: settings?.zip || "" });
  const budget = h("input", { type: "number", id: "budget", min: 1, step: "0.01", inputmode: "decimal", placeholder: "No limit", value: settings?.budget ? (settings.budget.cents / 100).toFixed(2) : "" });
  const go = h("button", { class: "btn primary lg", type: "submit" }, "Find and compare");
  const every = h("input", { type: "checkbox", id: "every-store", name: "every" });
  // "Buy without asking": off by default, for this search only, confirmed before the search starts.
  const upOn = h("input", { type: "checkbox", id: "buy-without-asking", "aria-describedby": "bwa-hint" });
  const upTo = h("input", { type: "number", id: "bwa-up-to", min: 1, step: "0.01", inputmode: "decimal", placeholder: "60", disabled: true });
  const upStores = h("input", { type: "text", id: "bwa-stores", placeholder: "Every store of this search", disabled: true, autocomplete: "off" });
  const upExpires = h("select", { id: "bwa-expires", disabled: true },
    h("option", { value: "" }, "This search only"), h("option", { value: "1h" }, "1 hour"), h("option", { value: "2h" }, "2 hours"), h("option", { value: "24h" }, "24 hours"));
  const upFields = h("div", { class: "grid3 bwa-fields", hidden: true },
    h("div", { class: "field" }, h("label", { for: "bwa-up-to" }, "Up to, per order ($)"), upTo),
    h("div", { class: "field" }, h("label", { for: "bwa-stores" }, "Only at (optional)"), upStores),
    h("div", { class: "field" }, h("label", { for: "bwa-expires" }, "For"), upExpires));
  upOn.addEventListener("change", () => {
    for (const el of [upTo, upStores, upExpires]) el.disabled = !upOn.checked;
    upFields.hidden = !upOn.checked;
    if (upOn.checked) upTo.focus();
  });
  const storeCount = h("span", { class: "faint" });
  const updateCount = () => {
    const n = form.querySelectorAll("input[name=store]:checked").length;
    storeCount.textContent = `${n} store${n === 1 ? "" : "s"}${zip.value ? `, ZIP ${zip.value}` : ""}${budget.value ? `, up to $${budget.value}` : ""}`;
  };

  const form = h("form", {
    class: "hero",
    oninput: () => updateCount(),
    onsubmit: async (ev) => {
      ev.preventDefault();
      const prompt = ta.value.trim();
      if (!prompt) { ta.focus(); toast("Write what you want to buy, or pick an example", true); return; }
      const picked = [...form.querySelectorAll("input[name=store]:checked")].map((i) => i.value);
      if (!picked.length) { toast("Choose at least one store", true); form.querySelector("details.opts").open = true; return; }
      let mandate;
      if (upOn.checked) {
        const amount = Number(upTo.value);
        if (!(amount > 0)) { toast("Set the most one order may cost, or turn off Buy without asking", true); form.querySelector("details.opts").open = true; upTo.focus(); return; }
        const where = upStores.value.trim() ? ` at ${upStores.value.trim()}` : " at any store of this search";
        const until = upExpires.value ? ` for the next ${upExpires.selectedOptions[0].textContent}` : " for this search only";
        const ok = await confirmDialog("Buy without asking?",
          `${app.meta.demo ? "Demo: pretend orders only. " : ""}The agent will place orders without asking you when a store's checkout total, with shipping and tax, is $${amount.toFixed(2)} or less${where},${until}. Anything else still waits for your OK. Store sign-ins, codes and bank checks still come to you.`,
          `Allow up to $${amount.toFixed(2)}`);
        if (!ok) return;
        mandate = { maxTotal: amount, stores: upStores.value.trim() || undefined, expiresIn: upExpires.value || undefined, confirmed: true };
      }
      go.disabled = true;
      go.replaceChildren(h("span", { class: "spin", "aria-hidden": "true" }), "Starting");
      try {
        const { runId } = await api("/api/runs", { method: "POST", body: { prompt, stores: picked, zip: zip.value || undefined, budget: budget.value || undefined, everyStore: every.checked || undefined, mandate } });
        location.hash = `#/run/${encodeURIComponent(runId)}`;
      } catch (e) {
        toast(e.message, true);
        go.disabled = false;
        go.replaceChildren("Find and compare");
      }
    },
  },
    h("h1", {}, "What should I buy?"),
    h("p", { class: "lead" }, "One request. Every store compared. You approve each purchase."),
    h("div", { class: "prompt-box" },
      h("label", { for: "prompt", class: "sr" }, "What to buy"), ta,
      h("div", { class: "prompt-foot" }, h("span", { class: "faint small" }, h("kbd", {}, "Enter"), " to search"), go)),
    h("p", { id: "prompt-hint", class: "sr" }, "Describe the items, sizes and a budget. Press Enter to search."),
    h("div", { class: "chips", role: "group", "aria-label": "Examples" },
      h("span", { class: "chips-label" }, "Try"),
      EXAMPLES.map((ex) => h("button", { type: "button", class: "chip", onclick: () => { ta.value = ex; ta.focus(); } }, ex))),
    h("details", { class: "opts" },
      h("summary", {}, "Stores, ZIP, budget", h("span", { class: "opts-now" }, storeCount)),
      h("div", { class: "body stack" },
        h("fieldset", {}, h("legend", {}, "Stores"),
          h("div", { class: "checks" }, ALL_STORES.map((s) =>
            h("label", { class: "check" }, h("input", { type: "checkbox", name: "store", value: s, checked: stores.includes(s) }), storeIcon(s, undefined, "sm"), STORE_NAMES[s])))),
        h("div", { class: "grid2" },
          h("div", { class: "field" }, h("label", { for: "zip" }, "Delivery ZIP (optional)"), zip),
          h("div", { class: "field" }, h("label", { for: "budget" }, "Budget for everything, $ (optional)"), budget)),
        h("label", { class: "check" }, every, "A cart at every store, to compare real totals"),
        h("fieldset", { class: "bwa" }, h("legend", {}, "Buy without asking"),
          h("label", { class: "check" }, upOn, "Buy without asking, within a limit"),
          h("p", { id: "bwa-hint", class: "faint small" }, "Off by default. You still choose the picks and fill the carts; a checkout at or under the limit is then bought with no question. Anything over it waits for your OK."),
          upFields))),
    h("ol", { class: "how", "aria-label": "How it works" },
      h("li", {}, h("strong", {}, "Compare"), h("span", {}, "Searches every store at once")),
      h("li", {}, h("strong", {}, "Fill carts"), h("span", {}, "Only when you say so")),
      h("li", {}, h("strong", {}, "You buy"), h("span", {}, "Each order needs your OK"))),
    recent.length ? h("section", { class: "recent", "aria-labelledby": "recent-h" },
      h("div", { class: "row" }, h("h2", { id: "recent-h" }, "Recent"), h("span", { class: "spacer" }), h("a", { href: "#/history", class: "small" }, "All history")),
      h("ul", { class: "list" }, recent.map((r) => h("li", {}, h("a", { class: "rowlink", href: `#/run/${encodeURIComponent(r.runId)}` },
        h("div", { class: "grow" }, h("div", { class: "title" }, r.prompt)),
        h("span", { class: "amt faint" }, r.picksTotal ? `$${(r.picksTotal.cents / 100).toFixed(2)}` : "")))))) : null,
  );
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  main.append(form);
  updateCount();
  ta.focus();
}

// ---------- settings ----------

const BROWSER_MODES = [
  ["burner", "Fresh browser per run (about 1 credit)"],
  ["persistent", "Saved store profiles (keeps logins and carts, 50 credits a month per store)"],
];

async function settingsView() {
  document.title = "Settings - Open Shopping Agent";
  const s = await api("/api/settings");
  const key = h("input", { type: "password", id: "s-key", autocomplete: "off", spellcheck: "false", placeholder: s.hasBrowsaApiKey ? s.browsaApiKey : "bk_...", "aria-describedby": "s-key-hint" });
  const [llmProv, llmModelName] = (() => { const t = s.llm || "browsa"; const i = t.indexOf(":"); return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i + 1)]; })();
  const llm = h("select", { id: "s-llm" },
    h("option", { value: "browsa", selected: llmProv === "browsa" }, "None (Browsa hosted on Browsa, rules parser elsewhere)"),
    h("option", { value: "anthropic", selected: llmProv === "anthropic" }, "Anthropic, own key"),
    h("option", { value: "openai", selected: llmProv === "openai" }, "OpenAI or compatible, own key"),
    h("option", { value: "openrouter", selected: llmProv === "openrouter" }, "OpenRouter, own key"),
    h("option", { value: "google", selected: llmProv === "google" }, "Google, own key"));
  const llmModel = h("input", { type: "text", id: "s-llmmodel", spellcheck: "false", value: llmModelName, placeholder: "Default model" });
  const llmBase = h("input", { type: "text", id: "s-llmbase", spellcheck: "false", value: s.byok?.llmBaseUrl || "", placeholder: "Only for a compatible API: https://.../v1" });
  const llmKey = h("input", { type: "password", id: "s-llmkey", autocomplete: "off", spellcheck: "false", placeholder: s.hasLlmApiKey ? s.llmApiKey : "Optional" });
  const llmSpec = () => (llm.value === "browsa" ? "browsa" : llmModel.value.trim() ? `${llm.value}:${llmModel.value.trim()}` : llm.value);
  const testOut = (id) => h("p", { class: "hint test-out", id, role: "status" });
  const keyOut = testOut("s-llmtest");
  const testKey = h("button", { class: "btn sm", type: "button", onclick: async () => {
    keyOut.textContent = "Testing...";
    try {
      const r = await api("/api/settings/test-key", { method: "POST", body: { llm: llmSpec(), llmApiKey: llmKey.value || undefined, llmBaseUrl: llmBase.value || undefined } });
      keyOut.textContent = r.ok ? `Works: ${r.model}, ${r.ms} ms` : `Did not work${r.model ? ` (${r.model})` : ""}: ${r.error}`;
    } catch (e) { keyOut.textContent = e.message; }
  } }, "Test key");
  const by = s.byok || { browser: "auto", choices: [], table: [], storeProxies: {}, proxyPool: [] };
  const cdpUrl = h("input", { type: "password", id: "s-cdp", autocomplete: "off", spellcheck: "false", placeholder: by.hasCdpUrl ? by.cdpUrl : "ws://host:9222/devtools/browser/... or http://host:9222", "aria-describedby": "s-cdp-hint" });
  const storeProxy = Object.fromEntries(ALL_STORES.map((st) => [st, h("input", { type: "password", id: `s-proxy-${st}`, autocomplete: "off", spellcheck: "false", placeholder: by.storeProxies?.[st] || "Same as above" })]));
  const pool = h("textarea", { id: "s-pool", rows: 3, spellcheck: "false", placeholder: "One per line: host:port, http://user:pass@host:port, socks5://host:port" }, (by.proxyPool || []).join("\n"));
  const proxyOut = testOut("s-proxytest");
  const testProxyBtn = (label, body) => h("button", { class: "btn sm", type: "button", onclick: async () => {
    proxyOut.textContent = "Testing...";
    try {
      const r = await api("/api/settings/test-proxy", { method: "POST", body: body() });
      proxyOut.textContent = r.ok ? `Works: ${r.proxy} exits at ${r.ip}${r.country ? ` (${r.country})` : ""}, ${r.ms} ms` : `Did not work${r.proxy ? ` (${r.proxy})` : ""}: ${r.error}`;
    } catch (e) { proxyOut.textContent = e.message; }
  } }, label);
  const capTable = by.table?.length ? h("table", { class: "caps" },
    h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Browsa"), h("th", {}, "Your Chrome"), h("th", {}, "CDP"))),
    h("tbody", {}, by.table.map((r) => h("tr", {}, h("th", { scope: "row" }, r.feature), h("td", {}, r.browsa), h("td", {}, r.local), h("td", {}, r.cdp))))) : null;
  const zip = h("input", { type: "text", id: "s-zip", inputmode: "numeric", maxlength: 5, pattern: "\\d{5}", value: s.zip, placeholder: "82001" });
  const budget = h("input", { type: "number", id: "s-budget", min: "1", step: "0.01", inputmode: "decimal", value: s.budget ? (s.budget.cents / 100).toFixed(2) : "", placeholder: "No limit" });
  const shop = h("input", { type: "text", id: "s-shop", value: s.shopifyDomains.join(", "), placeholder: "shop.example.com, another-store.com", "aria-describedby": "s-shop-hint" });
  const catalog = h("input", { type: "checkbox", id: "s-catalog", checked: !!s.shopCatalog, disabled: !!s.shopCatalogFromEnv, "aria-describedby": "s-catalog-hint" });
  const proxy = h("input", { type: "password", id: "s-proxy", autocomplete: "off", spellcheck: "false", placeholder: s.hasProxy ? s.proxy : "http://user:pass@host:port", "aria-describedby": "s-proxy-hint" });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save");

  const form = h("form", {
    class: "stack",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const stores = [...form.querySelectorAll("input[name=sstore]:checked")].map((i) => i.value);
      if (!stores.length) { toast("Pick at least one store", true); return; }
      save.disabled = true;
      try {
        await api("/api/settings", { method: "PUT", body: {
          browsaApiKey: key.value || undefined, llm: llmSpec(), llmApiKey: llmKey.value || undefined, llmBaseUrl: llmBase.value.trim(),
          zip: zip.value, budget: budget.value || null, allowedStores: stores,
          shopifyDomains: shop.value.split(/[\s,]+/).filter(Boolean),
          ...(s.shopCatalogFromEnv ? {} : { shopCatalog: catalog.checked }),
          browserMode: form.querySelector("input[name=bmode]:checked")?.value || "burner",
          browser: form.querySelector("input[name=bprov]:checked")?.value || "auto",
          ...(cdpUrl.value.trim() ? { cdpUrl: cdpUrl.value.trim() } : {}),
          ...(proxy.value.trim() ? { proxy: proxy.value.trim() } : {}),
          storeProxies: Object.fromEntries(ALL_STORES.map((st) => [st, storeProxy[st].value.trim()])),
          proxyPool: pool.value,
        } });
        meta = await api("/api/meta").catch(() => meta);
        document.getElementById("demo-badge").hidden = !meta.demo;
        toast("Saved");
        main.replaceChildren();
        await settingsView();
      } catch (e) { toast(e.message, true); }
      save.disabled = false;
    },
  },
    h("section", { class: "card stack", "aria-labelledby": "h-browser" },
      h("h2", { id: "h-browser" }, "Browser"),
      h("fieldset", {}, h("legend", { class: "sr-only" }, "Where the browsers run"),
        h("div", { class: "checks col" }, (by.choices || []).map((c) => h("label", { class: "check" },
          h("input", { type: "radio", name: "bprov", value: c.value, checked: (by.browser || "auto") === c.value }), c.label)))),
      h("div", { class: "field" }, h("label", { for: "s-cdp" }, "CDP browser URL (for Any CDP browser)"), cdpUrl,
        h("p", { class: "hint", id: "s-cdp-hint" }, by.hasCdpUrl ? "Saved. Leave empty to keep it." : "Your own remote Chrome or another provider. Its own proxy applies.")),
      capTable,
      h("p", { class: "hint" }, "Everything works on every browser. Browsa adds bot checks passed by Phantom, captchas solved in-session, a US home-internet exit per store and take-over from any device.")),
    h("section", { class: "card stack", "aria-labelledby": "h-keys" },
      h("h2", { id: "h-keys" }, "Keys"),
      h("div", { class: "field" }, h("label", { for: "s-key" }, "Browsa API key"), key,
        h("p", { class: "hint", id: "s-key-hint" }, s.hasBrowsaApiKey ? "Saved on this server. Leave empty to keep it." : h("span", {}, "Get one at ", h("a", { href: "https://browsa.io", target: "_blank", rel: "noopener" }, "browsa.io"), ". Stays on this server."))),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: "s-llm" }, "Your model"), llm),
        h("div", { class: "field" }, h("label", { for: "s-llmmodel" }, "Model name"), llmModel)),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: "s-llmkey" }, "Model API key"), llmKey),
        h("div", { class: "field" }, h("label", { for: "s-llmbase" }, "Base URL (optional)"), llmBase)),
      h("div", { class: "row" }, testKey),
      keyOut,
      h("p", { class: "hint" }, "Your key reads the request and runs the AI fallback on every browser. It stays in .osa/config.json on this computer.")),
    h("section", { class: "card stack", "aria-labelledby": "h-shop" },
      h("h2", { id: "h-shop" }, "Shopping"),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: "s-zip" }, "Delivery ZIP"), zip),
        h("div", { class: "field" }, h("label", { for: "s-budget" }, "Budget per run ($)"), budget)),
      h("fieldset", {}, h("legend", {}, "Allowed stores"),
        h("div", { class: "checks" }, ALL_STORES.map((st) => h("label", { class: "check" }, h("input", { type: "checkbox", name: "sstore", value: st, checked: s.allowedStores.includes(st) }), storeIcon(st, undefined, "sm"), STORE_NAMES[st])))),
      h("div", { class: "field" }, h("label", { for: "s-shop" }, "Shopify stores"), shop, h("p", { class: "hint", id: "s-shop-hint" }, "Domains, comma separated.")),
      h("div", { class: "field" },
        h("label", { class: "check" }, catalog, "Also find Shopify stores through Shop's catalog"),
        h("p", { class: "hint", id: "s-catalog-hint" },
          s.shopCatalogFromEnv ? "Set by OSA_SHOP_CATALOG. " : "",
          "Off by default. Sends your search words to Shopify's catalog API (mcp.shop.com); ",
          h("a", { href: "https://www.shopify.com/legal/api-terms", target: "_blank", rel: "noopener" }, "Shopify's API terms"),
          " apply. No Shop account. Carts and checkout stay on each store's own site, with your approval.")),
      h("fieldset", {}, h("legend", {}, "Browsers"),
        h("div", { class: "checks col" }, BROWSER_MODES.map(([v, label]) => h("label", { class: "check" },
          h("input", { type: "radio", name: "bmode", value: v, checked: (s.browserMode || "burner") === v }), label))),
        h("p", { class: "hint" }, "Phantom browsers on Browsa. Saved profiles let you sign in to a store once.")),
      h("div", { class: "field" }, h("label", { for: "s-proxy" }, "Your proxy (optional)"), proxy,
        h("p", { class: "hint", id: "s-proxy-hint" }, s.hasProxy
          ? "Saved. Every store uses it. Leave empty to keep it."
          : "Every store uses it when set; free on Browsa. Without one, Amazon, Target and Best Buy get Browsa's residential US exit when your account has it.")),
      h("div", { class: "row" }, testProxyBtn("Test proxy", () => ({ proxy: proxy.value.trim() || undefined }))),
      h("details", {}, h("summary", {}, "Per-store proxies and a pool"),
        h("div", { class: "stack" },
          h("div", { class: "grid2" }, ALL_STORES.map((st) => h("div", { class: "field" }, h("label", { for: `s-proxy-${st}` }, STORE_NAMES[st]), storeProxy[st]))),
          h("p", { class: "hint" }, "A store's own proxy wins over the one above. Type none to remove one."),
          h("div", { class: "field" }, h("label", { for: "s-pool" }, "Proxy pool"), pool,
            h("p", { class: "hint" }, "Rotated per store and run; one that fails a quick check is skipped.")))),
      proxyOut),
    h("div", { class: "row" }, save, h("span", { class: "faint small" }, "Orders always need your approval.")),
  );
  main.append(h("div", { class: "page-head" }, h("h1", {}, "Settings")), form);
}

// ---------- start ----------

installShortcuts();
api("/api/meta").then((m) => {
  meta = m;
  document.getElementById("demo-badge").hidden = !m.demo;
}).catch(() => {}).finally(() => {
  window.addEventListener("hashchange", route);
  route();
});
