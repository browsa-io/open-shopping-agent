// Open Shopping Agent web app. No framework, no build step. Renders the RunEvent stream from
// /api/runs/:id/events (Server-Sent Events) into stores, comparison, carts, checkout and orders.

const STORE_NAMES = { amazon: "Amazon", walmart: "Walmart", ebay: "eBay", bestbuy: "Best Buy", target: "Target", shopify: "Shopify" };
const ALL_STORES = ["amazon", "walmart", "ebay", "bestbuy", "target", "shopify"];
const EXAMPLES = [
  "usb-c hub and 6 ft hdmi under $60",
  "65W usb-c charger",
  "wireless mouse and keyboard under $80",
  "2 x hdmi cable 10 ft",
];

const main = document.getElementById("main");
let meta = { demo: false };
let current = null; // { es, timer } of the open run view

// ---------- helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function money(m) {
  if (!m) return "?";
  const v = (m.cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (m.currency === "USD" || !m.currency ? "$" : m.currency + " ") + v;
}
const delivered = (o) => o.price.cents + (o.shipping ? o.shipping.cents : 0);
const storeName = (s, domain) => (s === "shopify" && domain ? domain : STORE_NAMES[s] || s);
const shipText = (o) => (!o.shipping ? "?" : o.shipping.cents === 0 ? "Free" : money(o.shipping));
const dayText = (o) => (o.deliveryText || "").replace(/^Arrives\s+/i, "") || "?";
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const elapsed = (from, to) => {
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}

function confirmDialog(title, body, yesLabel) {
  const d = document.getElementById("confirm");
  d.querySelector("#confirm-title").textContent = title;
  d.querySelector("#confirm-body").textContent = body;
  d.querySelector("#confirm-yes").textContent = yesLabel;
  return new Promise((resolve) => {
    d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true });
    d.returnValue = "";
    d.showModal();
    d.querySelector("button[value=no]").focus();
  });
}

/** Replace a container's content only when its signature changed, keeping keyboard focus. */
function mount(container, signature, build) {
  if (container._sig === signature) return;
  container._sig = signature;
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.getAttribute("data-key") : null;
  container.replaceChildren(...[build()].flat(Infinity).filter(Boolean));
  if (key) container.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

function setNav(name) {
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function closeRun() {
  if (current) {
    current.es?.close();
    clearInterval(current.timer);
    current = null;
  }
}

// ---------- router ----------

async function route() {
  closeRun();
  const hash = location.hash.replace(/^#/, "") || "/";
  const [, page, arg] = hash.split("/");
  main.replaceChildren();
  try {
    if (page === "run" && arg) { setNav(""); await runView(decodeURIComponent(arg)); }
    else if (page === "history") { setNav("history"); await historyView(); }
    else if (page === "watches") { setNav("watches"); await watchesView(); }
    else if (page === "settings") { setNav("settings"); await settingsView(); }
    else { setNav("new"); await homeView(); }
  } catch (e) {
    main.replaceChildren(h("div", { class: "card empty" }, e.message));
  }
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// ---------- home ----------

async function homeView() {
  const settings = await api("/api/settings").catch(() => null);
  document.title = "Open Shopping Agent";
  const ta = h("textarea", {
    id: "prompt", name: "prompt", rows: 3, maxlength: 500, required: true,
    placeholder: "Describe what to buy, sizes, budget", "aria-describedby": "prompt-hint",
  });
  const stores = settings?.allowedStores || ["amazon", "walmart", "ebay", "bestbuy", "target"];
  const zip = h("input", { type: "text", id: "zip", inputmode: "numeric", maxlength: 5, pattern: "\\d{5}", placeholder: "82001", value: settings?.zip || "" });
  const budget = h("input", { type: "number", id: "budget", min: 1, step: "0.01", inputmode: "decimal", placeholder: "No limit", value: settings?.budget ? (settings.budget.cents / 100).toFixed(2) : "" });
  const go = h("button", { class: "btn primary", type: "submit" }, "Find and compare");

  const form = h("form", {
    class: "hero",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const prompt = ta.value.trim();
      if (!prompt) { ta.focus(); return; }
      const picked = [...form.querySelectorAll("input[name=store]:checked")].map((i) => i.value);
      if (!picked.length) { toast("Pick at least one store", true); return; }
      go.disabled = true;
      go.replaceChildren(h("span", { class: "spin", "aria-hidden": "true" }), "Starting");
      try {
        const { runId } = await api("/api/runs", { method: "POST", body: { prompt, stores: picked, zip: zip.value || undefined, budget: budget.value || undefined } });
        location.hash = `#/run/${encodeURIComponent(runId)}`;
      } catch (e) {
        toast(e.message, true);
        go.disabled = false;
        go.replaceChildren("Find and compare");
      }
    },
  },
    h("h1", {}, "What should I buy?"),
    h("p", { class: "lead" }, "One request, every store. You approve each purchase."),
    h("div", { class: "prompt-box" }, h("label", { for: "prompt", class: "sr" }, "What to buy"), ta),
    h("p", { id: "prompt-hint", class: "sr" }, "Describe the items, sizes and a budget. Press Enter to search."),
    h("div", { class: "chips", role: "group", "aria-label": "Examples" },
      EXAMPLES.map((ex) => h("button", { type: "button", class: "chip", onclick: () => { ta.value = ex; ta.focus(); } }, ex))),
    h("div", { class: "row" }, go, h("span", { class: "faint small" }, "Nothing is bought without your OK.")),
    h("details", { class: "opts" },
      h("summary", {}, "Stores, ZIP, budget"),
      h("div", { class: "body stack" },
        h("fieldset", {}, h("legend", {}, "Stores"),
          h("div", { class: "checks" }, ALL_STORES.map((s) =>
            h("label", { class: "check" }, h("input", { type: "checkbox", name: "store", value: s, checked: stores.includes(s) }), STORE_NAMES[s])))),
        h("div", { class: "grid2" },
          h("div", { class: "field" }, h("label", { for: "zip" }, "Delivery ZIP"), zip),
          h("div", { class: "field" }, h("label", { for: "budget" }, "Budget, total ($)"), budget)))),
  );
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  main.append(form);
  ta.focus();
}

// ---------- run view ----------

function emptyRun(id) {
  return {
    id, prompt: "", status: "running", startedAt: new Date().toISOString(), finishedAt: null, request: null,
    stores: {}, order: [], items: [], offers: {}, picks: null, total: null, overBudget: false, logs: [], summary: null,
    gates: new Map(), answered: new Set(), busy: new Set(),
  };
}

function storeOf(run, s) {
  if (!run.stores[s]) {
    run.stores[s] = { store: s, domain: "", started: false, offers: 0, failed: null, cart: null, review: null, needs: null, awaiting: null, order: null, liveUrl: null, exit: null };
    if (!run.order.includes(s)) run.order.push(s);
  }
  return run.stores[s];
}

function apply(run, e) {
  switch (e.type) {
    case "parsed":
      run.request = e.request;
      run.items = e.request.items.map((i) => ({ id: i.id, label: i.description || i.query, qty: i.quantity, options: i.options }));
      for (const s of e.request.stores) storeOf(run, s);
      break;
    case "store_started": { const st = storeOf(run, e.store); st.started = true; st.liveUrl = e.liveUrl || st.liveUrl; st.exit = e.exit || st.exit; break; }
    case "offers": {
      const st = storeOf(run, e.store);
      st.started = true;
      st.offers += e.offers.length;
      if (e.offers[0]) st.domain = e.offers[0].storeDomain;
      (run.offers[e.itemId] ||= []).push(...e.offers);
      break;
    }
    case "store_failed": storeOf(run, e.store).failed = { stage: e.stage, error: e.error }; break;
    case "picks": run.picks = e.picks; run.total = e.total; run.overBudget = e.overBudget; break;
    case "cart": storeOf(run, e.cart.store).cart = e.cart; break;
    case "checkout_review": storeOf(run, e.review.store).review = e.review; break;
    case "needs_user": { const st = storeOf(run, e.store); st.needs = e.needs; st.awaiting = null; break; }
    case "awaiting_approval": { const st = storeOf(run, e.store); st.awaiting = e.review; st.needs = null; break; }
    case "order": { const st = storeOf(run, e.result.store); st.order = e.result; st.awaiting = null; run.busy.delete(`buy:${e.result.store}`); break; }
    case "log": run.logs.push({ store: e.store, message: e.message, at: Date.now() }); break;
    case "done":
      run.summary = e.summary;
      run.finishedAt = e.summary.finishedAt;
      if (run.status === "running") run.status = "done";
      run.gates.clear();
      break;
  }
}

function storeStatus(run, st) {
  if (st.order) return st.order.placed ? ["ok", "Ordered"] : ["bad", "Not placed"];
  if (st.needs) return ["warn", "Needs you"];
  if (st.awaiting) return ["ok", "Ready to buy"];
  if (st.review) return ["", "Checkout reviewed"];
  if (st.cart) return ["", "Cart filled"];
  if (st.failed) return ["bad", `Failed at ${st.failed.stage}`];
  if (run.gates.has(`cart:${st.store}`)) return ["warn", "Waiting for you"];
  if (st.offers) return [run.picks ? "" : "busy", `${st.offers} offer${st.offers === 1 ? "" : "s"}`];
  if (st.started) return ["busy", "Searching"];
  if (run.status !== "running") return ["", "Not searched"];
  return ["busy", "Starting browser"];
}

async function runView(id) {
  const run = emptyRun(id);
  const ui = { live: null, expanded: new Set() };
  const els = {
    head: h("div"), stores: h("div"), live: h("div"), compare: h("div"), checkout: h("div"), log: h("div"),
  };
  main.append(els.head, els.stores, els.live, els.compare, els.checkout, els.log);

  const rec = await api(`/api/runs/${encodeURIComponent(id)}`);
  run.prompt = rec.prompt;
  run.startedAt = rec.startedAt;
  document.title = `${rec.prompt.slice(0, 50)} - Open Shopping Agent`;
  if (rec.status === "cancelled") run.status = "cancelled";

  const render = () => {
    renderHead(els.head, run);
    renderStores(els.stores, run, ui, render);
    renderLive(els.live, run, ui, render);
    renderCompare(els.compare, run, ui, render);
    renderCheckout(els.checkout, run, render);
    renderLog(els.log, run);
  };

  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  current = { es, timer: setInterval(() => run.status === "running" && renderHead(els.head, run), 1000) };
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  };
  es.addEventListener("run", (m) => {
    const e = JSON.parse(m.data);
    apply(run, e);
    if (e.type === "done") es.close();
    schedule();
  });
  es.addEventListener("gate", (m) => {
    const g = JSON.parse(m.data);
    const key = `${g.step}:${g.store}`;
    if (g.open) run.gates.set(key, g);
    else run.gates.delete(key);
    schedule();
  });
  es.onerror = () => { if (run.summary) es.close(); };
  render();
}

function renderHead(el, run) {
  const running = run.status === "running";
  const sig = JSON.stringify([run.status, run.prompt, elapsed(run.startedAt, run.finishedAt), !!run.summary]);
  mount(el, sig, () => h("div", { class: "run-head" },
    h("div", { class: "spacer" },
      h("h1", { class: "q" }, run.prompt),
      h("div", { class: "meta" },
        running
          ? h("span", { class: "badge green" }, h("span", { class: "dot pulse" }), "Running")
          : run.status === "cancelled" ? h("span", { class: "badge red" }, "Cancelled") : h("span", { class: "badge" }, "Finished"),
        h("span", {}, elapsed(run.startedAt, run.finishedAt)),
        run.summary && run.summary.creditsUsed !== undefined ? h("span", {}, `${run.summary.creditsUsed} credits`) : null,
        meta.demo ? h("span", { class: "badge demo" }, "Demo data") : null)),
    running ? h("button", {
      class: "btn ghost sm danger", "data-key": "cancel-run",
      onclick: async () => {
        try { await api(`/api/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST", body: {} }); run.status = "cancelled"; renderHead(el, run); }
        catch (e) { toast(e.message, true); }
      },
    }, "Cancel run") : null));
}

function renderStores(el, run, ui, rerender) {
  const list = run.order.map((s) => run.stores[s]);
  const sig = JSON.stringify([list.map((st) => [st.store, st.domain, storeStatus(run, st), st.failed, !!st.liveUrl, st.exit]), ui.live]);
  mount(el, sig, () => [
    h("div", { class: "section-head" }, h("h2", {}, "Stores"), h("span", { class: "count" }, list.length ? `${list.length}` : "")),
    list.length ? h("div", { class: "stores" }, list.map((st) => {
      const [tone, text] = storeStatus(run, st);
      return h("section", { class: "card store", "aria-label": storeName(st.store, st.domain) },
        h("div", { class: "name" }, storeName(st.store), st.store === "shopify" && st.domain ? h("span", { class: "domain" }, st.domain) : null),
        h("div", { class: `status ${tone === "busy" ? "" : tone}` }, tone === "busy" ? h("span", { class: "dot pulse", "aria-hidden": "true" }) : null, text),
        st.failed ? h("div", { class: "err" }, st.failed.error) : null,
        st.exit ? h("div", { class: "exit", title: "The address the store sees" }, `Exit: ${st.exit}`) : null,
        st.liveUrl ? h("button", {
          class: "btn sm ghost live-btn", "data-key": `live-${st.store}`, "aria-expanded": ui.live === st.store ? "true" : "false",
          onclick: () => { ui.live = ui.live === st.store ? null : st.store; rerender(); },
        }, ui.live === st.store ? "Hide live view" : "Watch live") : null);
    })) : h("div", { class: "card empty" }, h("span", { class: "dot pulse" }), " Reading your request"),
  ]);
}

function renderLive(el, run, ui, rerender) {
  const st = ui.live ? run.stores[ui.live] : null;
  const url = st?.liveUrl;
  // The iframe is built once per store; Phantom Live links can be single-use, so never reload it.
  mount(el, JSON.stringify([ui.live, url]), () => (url ? h("div", { class: "card live-panel" },
    h("div", { class: "row" }, h("h2", {}, `${storeName(st.store, st.domain)}, live in Phantom`), h("span", { class: "spacer" }),
      h("button", { class: "btn sm ghost", onclick: () => { ui.live = null; rerender(); } }, "Close")),
    h("p", { class: "hint" }, "View only. Use Take over at checkout to control the browser."),
    h("iframe", { class: "live-frame", src: url, title: `${storeName(st.store)} Phantom Live view`, allow: "clipboard-read; clipboard-write", referrerpolicy: "no-referrer" }),
  ) : null));
}

function renderCompare(el, run, ui, rerender) {
  const itemIds = run.items.length ? run.items.map((i) => i.id) : Object.keys(run.offers);
  const sig = JSON.stringify([itemIds, itemIds.map((i) => (run.offers[i] || []).length), run.picks, run.total, run.overBudget, [...ui.expanded], run.status]);
  mount(el, sig, () => {
    if (!itemIds.length) return null;
    const budget = run.request?.budget;
    return [
      h("div", { class: "section-head" }, h("h2", {}, "Compare"), h("span", { class: "count" }, `${itemIds.length} item${itemIds.length === 1 ? "" : "s"}`)),
      itemIds.map((itemId) => {
        const item = run.items.find((i) => i.id === itemId) || { id: itemId, label: itemId, qty: 1 };
        const pick = run.picks?.find((p) => p.itemId === itemId);
        const key = (o) => `${o.store}|${o.url}`;
        let rows = (run.offers[itemId] || []).slice().sort((a, b) => Number(b.inStock) - Number(a.inStock) || delivered(a) - delivered(b));
        if (pick) rows = [rows.find((o) => key(o) === key(pick.offer)) || pick.offer, ...rows.filter((o) => key(o) !== key(pick.offer))];
        const open = ui.expanded.has(itemId);
        const limit = matchMedia("(max-width: 760px)").matches ? 3 : 6;
        const shown = open ? rows : rows.slice(0, limit);
        return h("section", { class: "card pad0 item", "aria-label": item.label },
          h("div", { class: "item-head" },
            h("h3", {}, item.label),
            item.qty > 1 ? h("span", { class: "badge" }, `x${item.qty}`) : null,
            item.options ? h("span", { class: "faint small" }, Object.values(item.options).filter((v) => !item.label.toLowerCase().includes(String(v).toLowerCase())).join(", ")) : null,
            h("span", { class: "spacer" }),
            h("span", { class: "faint small" }, `${rows.length} offer${rows.length === 1 ? "" : "s"}`)),
          pick ? h("div", { class: "pick" },
            h("div", { class: "t" }, h("span", { class: "badge green" }, "Best pick"), " ", pick.offer.title),
            h("div", { class: "why" }, `${storeName(pick.offer.store, pick.offer.storeDomain)}. ${pick.reason}`),
            h("div", { class: "price" }, money({ cents: delivered(pick.offer), currency: pick.offer.price.currency }), h("small", {}, pick.offer.shipping ? "delivered" : "plus shipping"))) :
            run.status === "running" ? h("div", { class: "pick" }, h("div", { class: "why" }, h("span", { class: "dot pulse" }), " Comparing as offers arrive")) : null,
          rows.length ? h("table", { class: "cmp" },
            h("caption", { class: "sr" }, `Offers for ${item.label}`),
            h("thead", {}, h("tr", {},
              h("th", { scope: "col" }, "Store"), h("th", { scope: "col" }, "Product"), h("th", { scope: "col", class: "num" }, "Price"),
              h("th", { scope: "col", class: "num" }, "Shipping"), h("th", { scope: "col", class: "num" }, "Total"), h("th", { scope: "col" }, "Delivery"), h("th", { scope: "col" }, "Rating"), h("th", { scope: "col" }, "Seller"))),
            h("tbody", {}, shown.map((o) => {
              const best = pick && key(o) === key(pick.offer);
              return h("tr", { class: [best ? "best" : "", o.inStock ? "" : "out"].join(" ").trim() || null },
                h("td", { class: "c-store" }, storeName(o.store, o.storeDomain)),
                h("td", { class: "c-prod prod" },
                  h("a", { href: o.url, target: "_blank", rel: "noopener noreferrer" }, o.title),
                  (best || o.sponsored || !o.inStock || (o.condition && o.condition !== "new")) ? h("div", { class: "tags" },
                    best ? h("span", { class: "badge green" }, "Best pick") : null,
                    o.sponsored ? h("span", { class: "badge" }, "Sponsored") : null,
                    o.condition && o.condition !== "new" ? h("span", { class: "badge amber" }, o.condition) : null,
                    !o.inStock ? h("span", { class: "badge red" }, "Out of stock") : null) : null),
                h("td", { class: "c-price num" }, money(o.price), o.listPrice ? h("div", { class: "faint small" }, h("s", {}, money(o.listPrice))) : null),
                h("td", { class: "c-ship num" }, shipText(o)),
                h("td", { class: "c-total num" }, o.shipping ? money({ cents: delivered(o), currency: o.price.currency }) : "?"),
                h("td", { class: "c-del" }, dayText(o)),
                h("td", { class: "c-rate" }, o.rating ? h("span", { class: "stars" }, `${o.rating.stars.toFixed(1)} `, h("small", {}, `(${o.rating.count.toLocaleString("en-US")})`)) : h("span", { class: "faint" }, "None")),
                h("td", { class: "c-seller faint small" }, o.seller || ""),
                h("td", { class: "c-meta" }, [shipText(o) === "Free" ? "Free shipping" : `Shipping ${shipText(o)}`, dayText(o),
                  o.rating ? `${o.rating.stars.toFixed(1)} stars (${o.rating.count.toLocaleString("en-US")})` : null].filter(Boolean).join(" · ")));
            }))) : null,
          rows.length > limit ? h("div", { class: "more" }, h("button", {
            class: "btn sm ghost", "data-key": `more-${itemId}`, "aria-expanded": open ? "true" : "false",
            onclick: () => { open ? ui.expanded.delete(itemId) : ui.expanded.add(itemId); rerender(); },
          }, open ? "Show fewer" : `Show all ${rows.length}`)) : null);
      }),
      run.picks ? h("div", { class: "card totals" },
        h("span", { class: "muted" }, "Total for best picks"),
        h("span", { class: "sum" }, money(run.total)),
        budget ? h("span", { class: `badge ${run.overBudget ? "red" : "green"}` }, run.overBudget ? `Over budget of ${money(budget)}` : `Within ${money(budget)}`) : null,
        h("span", { class: "faint small" }, "Tax added at checkout")) : null,
    ];
  });
}

function planLines(run, store) {
  return (run.picks || []).filter((p) => p.offer.store === store).map((p) => {
    const qty = run.items.find((i) => i.id === p.itemId)?.qty || 1;
    return { title: p.offer.title, quantity: qty, price: { cents: p.offer.price.cents * qty, currency: p.offer.price.currency } };
  });
}

function linesList(lines) {
  return h("ul", { class: "lines" }, lines.map((l) => h("li", {},
    h("div", { class: "lt" }, l.title, h("div", { class: "lq" }, `Qty ${l.quantity}`, l.options ? `, ${Object.values(l.options).join(", ")}` : "")),
    h("div", { class: "lp" }, money(l.price)))));
}

async function answerGate(run, step, store, yes, rerender) {
  const k = `${step}:${store}`;
  run.answered.add(k);
  run.busy.add(k);
  rerender();
  try {
    await api(`/api/runs/${encodeURIComponent(run.id)}/confirm`, { method: "POST", body: { step, store, yes } });
  } catch (e) {
    toast(e.message, true);
    run.answered.delete(k);
  }
  run.busy.delete(k);
  rerender();
}

function renderCheckout(el, run, rerender) {
  if (!run.picks) { mount(el, "none", () => null); return; }
  const stores = [...new Set(run.picks.map((p) => p.offer.store))];
  const openCart = stores.filter((s) => run.gates.has(`cart:${s}`));
  const sig = JSON.stringify([stores.map((s) => run.stores[s]), [...run.gates.keys()], [...run.answered], [...run.busy], run.status, meta.demo]);
  mount(el, sig, () => [
    h("div", { class: "section-head" }, h("h2", {}, "Checkout"), h("span", { class: "count" }, `${stores.length} store${stores.length === 1 ? "" : "s"}`),
      h("span", { class: "spacer" }),
      openCart.length > 1 ? h("button", { class: "btn sm", "data-key": "fill-all", onclick: () => openCart.forEach((s) => answerGate(run, "cart", s, true, rerender)) }, "Fill all carts") : null),
    h("div", { class: "checkout" }, stores.map((s) => checkoutPanel(run, s, rerender))),
  ]);
}

function checkoutPanel(run, store, rerender) {
  const st = run.stores[store] || storeOf(run, store);
  const name = storeName(store, st.domain);
  const stepN = st.order ? 3 : st.review ? 2 : st.cart ? 1 : 0;
  const live = st.needs?.liveUrl || st.liveUrl;
  const takeOver = live ? h("a", { class: "btn ghost", href: live, target: "_blank", rel: "noopener noreferrer" }, "Take over in Phantom Live") : null;
  const body = [];
  const skipBtn = (step, label) => h("button", { class: "btn ghost", "data-key": `skip-${step}-${store}`, disabled: run.busy.has(`${step}:${store}`), onclick: () => answerGate(run, step, store, false, rerender) }, label);

  if (st.order) {
    const o = st.order;
    body.push(o.placed
      ? h("div", { class: "order" },
        h("div", { class: "big" }, "Order placed"),
        h("p", { class: "muted" }, `${money(o.total)} at ${name}`),
        o.orderId ? h("p", {}, "Order ", h("span", { class: "oid" }, o.orderId)) : null,
        o.confirmationText ? h("p", { class: "faint small" }, o.confirmationText) : null)
      : h("div", { class: "note bad" }, o.error || o.confirmationText || "The order was not placed."));
    if (!o.placed && o.needsUser?.liveUrl) body.push(h("a", { class: "btn", href: o.needsUser.liveUrl, target: "_blank", rel: "noopener noreferrer" }, "Take over in Phantom Live"));
  } else if (st.needs) {
    if (st.cart) body.push(linesList(st.cart.lines));
    body.push(h("div", { class: "note warn", role: "status" }, st.needs.message));
    const again = run.gates.has(`checkout:${store}`);
    body.push(h("div", { class: "actions" }, st.needs.liveUrl ? h("a", { class: "btn primary", href: st.needs.liveUrl, target: "_blank", rel: "noopener noreferrer" }, "Take over in Phantom Live") : null,
      again ? h("button", { class: "btn", "data-key": `again-checkout-${store}`, disabled: run.busy.has(`checkout:${store}`), onclick: () => answerGate(run, "checkout", store, true, rerender) }, "Review checkout again") : null,
      again ? skipBtn("checkout", "Stop here") : null));
    body.push(h("p", { class: "hint" }, again ? "Finish it in the live browser, then review the checkout again. The cart stays filled." : "Finish it in the live browser. The cart stays filled."));
  } else if (st.awaiting) {
    const r = st.awaiting;
    const k = `buy:${store}`;
    body.push(linesList(r.lines));
    body.push(h("dl", { class: "sums" },
      h("dt", {}, "Subtotal"), h("dd", {}, money(r.subtotal)),
      h("dt", {}, "Shipping"), h("dd", {}, r.shipping ? (r.shipping.cents === 0 ? "Free" : money(r.shipping)) : "?"),
      h("dt", {}, "Tax"), h("dd", {}, r.tax ? money(r.tax) : "?"),
      h("dt", { class: "grand" }, "Total"), h("dd", { class: "grand" }, money(r.total))));
    if (r.shipTo || r.paymentHint) body.push(h("p", { class: "faint small" }, [r.shipTo && `Ships to ${r.shipTo}`, r.paymentHint].filter(Boolean).join(" · ")));
    body.push(h("button", {
      class: "btn primary buy", "data-key": `buy-${store}`, disabled: run.busy.has(k),
      onclick: async () => {
        const ok = await confirmDialog(`Buy at ${name}?`,
          meta.demo ? `Demo: places a pretend order for ${money(r.total)}. Nothing is bought.` : `${name} will charge ${money(r.total)}. The agent re-checks the total first and stops if it changed.`,
          `Buy for ${money(r.total)}`);
        if (!ok) return;
        run.busy.add(k);
        rerender();
        try { await api(`/api/runs/${encodeURIComponent(run.id)}/approve`, { method: "POST", body: { store, approvedTotal: r.total } }); }
        catch (e) { toast(e.message, true); run.busy.delete(k); rerender(); }
      },
    }, run.busy.has(k) ? [h("span", { class: "spin", "aria-hidden": "true" }), "Placing order"] : `Buy for ${money(r.total)} at ${name}`));
    body.push(h("div", { class: "sub-actions" }, takeOver,
      h("button", {
        class: "btn ghost", "data-key": `nobuy-${store}`,
        onclick: async () => {
          try { await api(`/api/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST", body: { store } }); toast(`Not buying at ${name}. The cart stays filled.`); }
          catch (e) { toast(e.message, true); }
        },
      }, "Don't buy")));
  } else if (run.gates.has(`checkout:${store}`)) {
    body.push(h("p", { class: "faint small" }, `Cart read back from ${name}`));
    body.push(linesList(st.cart?.lines || []));
    for (const w of st.cart?.warnings || []) body.push(h("div", { class: "note warn" }, w));
    body.push(h("div", { class: "actions" },
      h("button", { class: "btn primary", "data-key": `go-checkout-${store}`, disabled: run.busy.has(`checkout:${store}`), onclick: () => answerGate(run, "checkout", store, true, rerender) }, "Review checkout"),
      skipBtn("checkout", "Stop here")));
    body.push(h("p", { class: "hint" }, "Goes to the order review page and stops before Place order."));
  } else if (st.cart) {
    body.push(linesList(st.cart.lines));
    for (const w of st.cart.warnings || []) body.push(h("div", { class: "note warn" }, w));
    if (run.answered.has(`checkout:${store}`) && run.status === "running") body.push(h("p", { class: "muted small" }, h("span", { class: "dot pulse" }), " Going to checkout"));
    else if (run.status !== "running") body.push(h("p", { class: "faint small" }, "Cart filled. Checkout not reviewed."));
  } else if (run.gates.has(`cart:${store}`)) {
    body.push(linesList(planLines(run, store)));
    body.push(h("div", { class: "actions" },
      h("button", { class: "btn primary", "data-key": `fill-${store}`, disabled: run.busy.has(`cart:${store}`), onclick: () => answerGate(run, "cart", store, true, rerender) }, `Fill cart at ${name}`),
      skipBtn("cart", "Skip")));
  } else {
    body.push(linesList(planLines(run, store)));
    if (st.failed) body.push(h("div", { class: "note bad" }, st.failed.error));
    else if (run.answered.has(`cart:${store}`) && run.status === "running") body.push(h("p", { class: "muted small" }, h("span", { class: "dot pulse" }), " Adding to cart, then reading the cart back"));
    else if (run.status !== "running") body.push(h("p", { class: "faint small" }, "Cart not filled."));
    else body.push(h("p", { class: "muted small" }, h("span", { class: "dot pulse" }), " Waiting"));
  }

  return h("section", { class: "card co", "aria-label": `Checkout at ${name}` },
    h("div", { class: "co-head" }, h("h3", {}, name),
      h("div", { class: "steps", role: "img", "aria-label": `Step ${stepN} of 3: cart, review, order` },
        [1, 2, 3].map((n) => h("span", { class: n <= stepN ? "on" : "" })))),
    body);
}

function renderLog(el, run) {
  mount(el, JSON.stringify([run.logs.length, run.status]), () => (run.logs.length ? h("details", { class: "log" },
    h("summary", {}, `Activity (${run.logs.length})`),
    h("ol", {}, run.logs.map((l) => h("li", {}, h("span", { class: "s" }, l.store ? storeName(l.store) : "Agent"), h("span", {}, l.message))))) : null));
}

// ---------- history ----------

async function historyView() {
  document.title = "History - Open Shopping Agent";
  const runs = await api("/api/runs");
  main.append(
    h("div", { class: "page-head" }, h("h1", {}, "History"), h("span", { class: "spacer" }), h("a", { class: "btn sm", href: "#/" }, "New search")),
    h("div", { class: "card pad0" }, runs.length ? h("ul", { class: "list" }, runs.map((r) => h("li", {},
      h("a", { class: "rowlink", href: `#/run/${encodeURIComponent(r.runId)}` },
        h("div", { class: "grow" },
          h("div", { class: "title" }, r.prompt),
          h("div", { class: "sub" }, [ago(r.startedAt), r.stores?.length ? r.stores.map((s) => STORE_NAMES[s]).join(", ") : null].filter(Boolean).join(" · "))),
        r.orders ? h("span", { class: "badge green" }, `${r.orders} order${r.orders > 1 ? "s" : ""}`) : null,
        r.status === "running" ? h("span", { class: "badge green" }, h("span", { class: "dot pulse" }), "Running") :
          r.status === "cancelled" ? h("span", { class: "badge red" }, "Cancelled") : null,
        h("span", { class: "amt" }, r.picksTotal ? money(r.picksTotal) : ""))))) :
      h("div", { class: "empty" }, "No runs yet. ", h("a", { href: "#/" }, "Start one"))),
  );
}

// ---------- watches ----------

const WATCH_STATUS = { saved: "Not checked yet", active: "Watching", triggered: "Alert sent", paused: "Paused" };

async function watchesView() {
  document.title = "Watches - Open Shopping Agent";
  const list = h("div", { class: "card pad0" });
  const load = async () => {
    const watches = await api("/api/watches");
    list.replaceChildren(watches.length ? h("ul", { class: "list" }, watches.map((w) => h("li", {},
      h("div", { class: "rowitem" },
        h("div", { class: "grow" },
          h("div", { class: "title" }, w.item),
          h("div", { class: "sub" }, [
            w.kind === "price_drop" ? `At or below ${money(w.below)}` : "Back in stock",
            w.stores?.length ? w.stores.map((s) => STORE_NAMES[s]).join(", ") : "All allowed stores",
            w.lastPrice ? `Last ${money(w.lastPrice)}${w.lastStore ? ` at ${STORE_NAMES[w.lastStore]}` : ""}` : null,
            w.lastError ? `Last check failed: ${w.lastError}` : null,
          ].filter(Boolean).join(" · "))),
        h("span", { class: `badge ${w.status === "triggered" ? "green" : ""}` }, WATCH_STATUS[w.status] || w.status),
        meta.canCheckWatches ? h("button", {
          class: "btn sm", "aria-label": `Check ${w.item} now`,
          onclick: async (ev) => {
            const b = ev.currentTarget;
            b.disabled = true;
            b.textContent = "Checking";
            try {
              const r = await api(`/api/watches/${encodeURIComponent(w.id)}/check`, { method: "POST", body: {} });
              toast(r.lastError ? `Check failed: ${r.lastError}` : r.lastPrice ? `Best now ${money(r.lastPrice)}` : "Checked, none in stock", !!r.lastError);
              load();
            } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = "Check now"; }
          },
        }, "Check now") : null,
        h("button", {
          class: "btn sm ghost", "aria-label": `Delete watch ${w.item}`,
          onclick: async () => { try { await api(`/api/watches/${encodeURIComponent(w.id)}`, { method: "DELETE" }); toast("Watch deleted"); load(); } catch (e) { toast(e.message, true); } },
        }, "Delete"))))) : h("div", { class: "empty" }, "No watches yet."));
  };

  const item = h("input", { type: "text", id: "w-item", required: true, maxlength: 300, placeholder: "6 ft HDMI 2.1 cable, or a product link" });
  const below = h("input", { type: "number", id: "w-below", min: "0.01", step: "0.01", inputmode: "decimal", placeholder: "49.99" });
  const belowWrap = h("div", { class: "field" }, h("label", { for: "w-below" }, "Notify at or below ($)"), below);
  const form = h("form", {
    class: "card stack",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const kind = form.querySelector("input[name=kind]:checked").value;
      const stores = [...form.querySelectorAll("input[name=wstore]:checked")].map((i) => i.value);
      const text = item.value.trim();
      if (!text) { item.focus(); return; }
      if (kind === "price_drop" && !below.value) { below.focus(); toast("Add a price", true); return; }
      try {
        await api("/api/watches", { method: "POST", body: { kind, item: text, url: /^https:\/\//.test(text) ? text : undefined, below: kind === "price_drop" ? below.value : undefined, stores: stores.length ? stores : undefined } });
        item.value = ""; below.value = "";
        toast("Watch saved");
        load();
      } catch (e) { toast(e.message, true); }
    },
  },
    h("fieldset", {}, h("legend", {}, "Notify me when"),
      h("div", { class: "checks" },
        h("label", { class: "check" }, h("input", { type: "radio", name: "kind", value: "price_drop", checked: true, onchange: () => (belowWrap.hidden = false) }), "Price drops"),
        h("label", { class: "check" }, h("input", { type: "radio", name: "kind", value: "back_in_stock", onchange: () => (belowWrap.hidden = true) }), "Back in stock"))),
    h("div", { class: "grid2" }, h("div", { class: "field" }, h("label", { for: "w-item" }, "Item"), item), belowWrap),
    h("fieldset", {}, h("legend", {}, "Stores (none = all allowed)"),
      h("div", { class: "checks" }, ALL_STORES.map((s) => h("label", { class: "check" }, h("input", { type: "checkbox", name: "wstore", value: s }), STORE_NAMES[s])))),
    h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Save watch"),
      h("span", { class: "faint small" }, meta.alertsDemo ? "Saved locally. Checks start when the alerts service runs." :
        meta.canCheckWatches ? "Checks run with osa watch run, about 1 credit per store." : "Add a Browsa API key in Settings to check watches.")),
  );
  main.append(h("div", { class: "page-head" }, h("h1", {}, "Watches")), form, h("div", { class: "section-head" }, h("h2", {}, "Your watches")), list);
  await load();
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
  const llm = h("select", { id: "s-llm" },
    h("option", { value: "browsa", selected: s.llm === "browsa" }, "Browsa hosted (default)"),
    h("option", { value: "anthropic", selected: s.llm === "anthropic" }, "Anthropic, own key"),
    h("option", { value: "openai", selected: s.llm === "openai" }, "OpenAI, own key"),
    h("option", { value: "google", selected: s.llm === "google" }, "Google, own key"));
  const llmKey = h("input", { type: "password", id: "s-llmkey", autocomplete: "off", spellcheck: "false", placeholder: s.hasLlmApiKey ? s.llmApiKey : "Optional" });
  const zip = h("input", { type: "text", id: "s-zip", inputmode: "numeric", maxlength: 5, pattern: "\\d{5}", value: s.zip, placeholder: "82001" });
  const budget = h("input", { type: "number", id: "s-budget", min: "1", step: "0.01", inputmode: "decimal", value: s.budget ? (s.budget.cents / 100).toFixed(2) : "", placeholder: "No limit" });
  const shop = h("input", { type: "text", id: "s-shop", value: s.shopifyDomains.join(", "), placeholder: "shop.example.com, another-store.com", "aria-describedby": "s-shop-hint" });
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
          browsaApiKey: key.value || undefined, llm: llm.value, llmApiKey: llmKey.value || undefined,
          zip: zip.value, budget: budget.value || null, allowedStores: stores,
          shopifyDomains: shop.value.split(/[\s,]+/).filter(Boolean),
          browserMode: form.querySelector("input[name=bmode]:checked")?.value || "burner",
          ...(proxy.value.trim() ? { proxy: proxy.value.trim() } : {}),
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
    h("section", { class: "card stack", "aria-labelledby": "h-keys" },
      h("h2", { id: "h-keys" }, "Keys"),
      h("div", { class: "field" }, h("label", { for: "s-key" }, "Browsa API key"), key,
        h("p", { class: "hint", id: "s-key-hint" }, s.hasBrowsaApiKey ? "Saved on this server. Leave empty to keep it." : h("span", {}, "Get one at ", h("a", { href: "https://browsa.io", target: "_blank", rel: "noopener" }, "browsa.io"), ". Stays on this server."))),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: "s-llm" }, "Model"), llm),
        h("div", { class: "field" }, h("label", { for: "s-llmkey" }, "Model API key"), llmKey))),
    h("section", { class: "card stack", "aria-labelledby": "h-shop" },
      h("h2", { id: "h-shop" }, "Shopping"),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: "s-zip" }, "Delivery ZIP"), zip),
        h("div", { class: "field" }, h("label", { for: "s-budget" }, "Budget per run ($)"), budget)),
      h("fieldset", {}, h("legend", {}, "Allowed stores"),
        h("div", { class: "checks" }, ALL_STORES.map((st) => h("label", { class: "check" }, h("input", { type: "checkbox", name: "sstore", value: st, checked: s.allowedStores.includes(st) }), STORE_NAMES[st])))),
      h("div", { class: "field" }, h("label", { for: "s-shop" }, "Shopify stores"), shop, h("p", { class: "hint", id: "s-shop-hint" }, "Domains, comma separated.")),
      h("fieldset", {}, h("legend", {}, "Browsers"),
        h("div", { class: "checks col" }, BROWSER_MODES.map(([v, label]) => h("label", { class: "check" },
          h("input", { type: "radio", name: "bmode", value: v, checked: (s.browserMode || "burner") === v }), label))),
        h("p", { class: "hint" }, "Phantom browsers on Browsa. Saved profiles let you sign in to a store once.")),
      h("div", { class: "field" }, h("label", { for: "s-proxy" }, "Your proxy (optional)"), proxy,
        h("p", { class: "hint", id: "s-proxy-hint" }, s.hasProxy
          ? "Saved. Every store uses it. Leave empty to keep it."
          : "Every store uses it when set; free on Browsa. Without one, Amazon, Target and Best Buy get Browsa's residential US exit when your account has it."))),
    h("div", { class: "row" }, save, h("span", { class: "faint small" }, "Orders always need your approval.")),
  );
  main.append(h("div", { class: "page-head" }, h("h1", {}, "Settings")), form);
}

// ---------- start ----------

api("/api/meta").then((m) => {
  meta = m;
  document.getElementById("demo-badge").hidden = !m.demo;
}).catch(() => {}).finally(() => {
  window.addEventListener("hashchange", route);
  route();
});
