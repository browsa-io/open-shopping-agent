// The run page: header, per-store progress, compare, carts and checkout, and a dock with the one
// next action. Live runs stream over Server-Sent Events; saved runs replay with no browsers.

import { api, confirmDialog, copyText, download, elapsed, h, icon, mount, store, toast } from "../lib/dom.js";
import { formatCents, money, reduceStores, shortRaw, storeName, storeStatus } from "../lib/wording.js";
import { DEFAULT_FILTERS, computePlan, planChoices, runModel, summaryText, toCSV, toJSON, watchFromOffer } from "../lib/model.js";
import { renderCompare } from "./compare.js";
import { renderCheckout } from "./checkout.js";
import { storeIcon } from "../lib/store-icon.js";

const narrowMq = matchMedia("(max-width: 760px)");

function loadView() {
  const v = store.get("osa.view", null);
  return {
    sort: v?.sort?.key ? v.sort : { key: "best", dir: 1 },
    filters: { ...DEFAULT_FILTERS, ...(v?.filters || {}), hiddenStores: Array.isArray(v?.filters?.hiddenStores) ? v.filters.hiddenStores : [] },
  };
}

export async function runView(main, id, app) {
  const run = {
    id, prompt: "", status: "running", startedAt: new Date().toISOString(), finishedAt: null, events: [], summary: null,
    gates: new Map(), answered: new Set(), busy: new Set(), replay: false,
  };
  const ui = { live: null, expanded: new Set(), narrow: narrowMq.matches };
  let view = loadView();
  let planState = store.get(`osa.plan.${id}`, {});
  const els = { head: h("div"), stores: h("div"), live: h("div"), compare: h("div"), checkout: h("div"), log: h("div"), dock: h("div", { class: "dock-wrap" }) };
  main.append(els.head, els.stores, els.live, els.compare, els.checkout, els.log, els.dock);
  main.classList.add("has-dock");

  const rec = await api(`/api/runs/${encodeURIComponent(id)}`);
  run.prompt = rec.prompt;
  run.startedAt = rec.startedAt || run.startedAt;
  run.finishedAt = rec.finishedAt || null;
  run.replay = rec.status !== "running";
  // A saved run replays with its final status; "failed" means it ended without finishing.
  if (rec.status !== "running") run.status = rec.status;
  document.title = `${rec.prompt.slice(0, 50)} - Open Shopping Agent`;

  const derive = () => {
    const model = runModel(run.events);
    const red = reduceStores(run.events);
    const plan = computePlan(model, planState);
    // Once a cart was tried (filled, reviewed, ordered, or failed past the search), the picks are history.
    const locked = [...red.stores.values()].some((s) => s.cart || s.review || s.order || s.failures.some((f) => f.stage !== "search"))
      || [...run.answered].some((k) => k.startsWith("cart:"));
    if (locked && Object.keys(planState).length && !run.answered.size) planState = {};
    const browser = [...run.events].reverse().find((e) => e.type === "browser") || null;
    return { model, stores: red.stores, order: red.order, plan, locked, browser };
  };

  const savePlan = () => store.set(`osa.plan.${id}`, planState);
  const setItem = (itemId, patch) => { planState = { ...planState, [itemId]: { ...(planState[itemId] || {}), ...patch } }; savePlan(); render(); };

  const actions = {
    choose: (itemId, key) => setItem(itemId, { offerKey: key, skip: false }),
    setQty: (itemId, q) => setItem(itemId, { quantity: Math.min(99, Math.max(1, Math.round(Number(q)) || 1)) }),
    toggleItemStore: (itemId, s) => {
      const ex = new Set(planState[itemId]?.excludedStores || []);
      ex.has(s) ? ex.delete(s) : ex.add(s);
      const cur = planState[itemId]?.offerKey;
      setItem(itemId, { excludedStores: [...ex], offerKey: cur && cur.startsWith(`${s}|`) && ex.has(s) ? undefined : cur });
    },
    setSort: (key, dir = 1) => { view = { ...view, sort: { key, dir } }; store.set("osa.view", view); render(); },
    setFilter: (patch) => { view = { ...view, filters: { ...view.filters, ...patch } }; store.set("osa.view", view); render(); },
    clearFilters: () => { view = { ...view, filters: { ...DEFAULT_FILTERS, hiddenStores: [] } }; store.set("osa.view", view); render(); },
    toggleShownStore: (s) => {
      const hid = new Set(view.filters.hiddenStores);
      hid.has(s) ? hid.delete(s) : hid.add(s);
      actions.setFilter({ hiddenStores: [...hid] });
    },
    toggleExpanded: (itemId) => { ui.expanded.has(itemId) ? ui.expanded.delete(itemId) : ui.expanded.add(itemId); render(); },
    watch: async (offer, label) => {
      try {
        const w = await api("/api/watches", { method: "POST", body: watchFromOffer(offer, label) });
        toast(`Watching. You get an alert at ${money(w.below)} or less.`);
      } catch (e) { toast(e.message, true); }
    },
    answer: async (step, s, yes) => {
      const k = `${step}:${s}`;
      run.answered.add(k);
      run.busy.add(k);
      render();
      try { await api(`/api/runs/${encodeURIComponent(id)}/confirm`, { method: "POST", body: { step, store: s, yes } }); }
      catch (e) { toast(e.message, true); run.answered.delete(k); }
      run.busy.delete(k);
      render();
    },
    fillCarts: async () => {
      const { plan } = derive();
      run.busy.add("fill");
      render();
      try {
        const r = await api(`/api/runs/${encodeURIComponent(id)}/fill`, { method: "POST", body: plan.changed ? { plan: planChoices(plan) } : {} });
        for (const s of r.stores) run.answered.add(`cart:${s}`);
        toast(`Filling ${r.stores.length === 1 ? "the cart" : `${r.stores.length} carts`}. Nothing is bought yet.`);
      } catch (e) { toast(e.message, true); }
      run.busy.delete("fill");
      render();
    },
    reviewAll: () => {
      for (const k of [...run.gates.keys()]) if (k.startsWith("checkout:")) actions.answer("checkout", k.slice(9), true);
      document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    buy: async (s, r, name) => {
      const ok = await confirmDialog(`Buy at ${name}?`,
        app.meta.demo ? `Demo: places a pretend order for ${money(r.total)}. Nothing is bought.` : `${name} will charge ${money(r.total)}. The agent checks the total again first and stops if it changed.`,
        `Buy for ${money(r.total)}`);
      if (!ok) return;
      const k = `buy:${s}`;
      run.busy.add(k);
      render();
      try { await api(`/api/runs/${encodeURIComponent(id)}/approve`, { method: "POST", body: { store: s, approvedTotal: r.total } }); }
      catch (e) { toast(e.message, true); run.busy.delete(k); render(); }
    },
    dontBuy: async (s, name) => {
      try { await api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { store: s } }); toast(`Not buying at ${name}. The cart stays filled.`); }
      catch (e) { toast(e.message, true); }
    },
    retryStore: async (s) => {
      try {
        const { runId } = await api("/api/runs", { method: "POST", body: { prompt: run.prompt, stores: [s] } });
        toast(`Trying ${storeName(s)} again in a new search`);
        location.hash = `#/run/${encodeURIComponent(runId)}`;
      } catch (e) { toast(e.message, true); }
    },
    searchAgain: async () => {
      const req = runModel(run.events).request;
      try {
        const { runId } = await api("/api/runs", { method: "POST", body: { prompt: run.prompt, stores: req?.stores } });
        location.hash = `#/run/${encodeURIComponent(runId)}`;
      } catch (e) { toast(e.message, true); }
    },
    cancel: async () => {
      try { await api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }); run.status = "cancelled"; render(); }
      catch (e) { toast(e.message, true); }
    },
    toggleLive: (s) => { ui.live = ui.live === s ? null : s; render(); },
  };

  const getEx = () => {
    const d = derive();
    const link = `${location.origin}${location.pathname}#/run/${encodeURIComponent(id)}/summary`;
    return { text: () => summaryText(run, d.model, d.plan, link), json: () => toJSON(run, d.model, d.plan), csv: () => toCSV(d.model, d.plan) };
  };

  function render() {
    const d = derive();
    const running = run.status === "running";
    const ctx = { run, ui, view, actions, app, today: run.startedAt, narrow: ui.narrow, ...d };
    renderHead(els.head, run, d, getEx, actions, app);
    renderStores(els.stores, run, d, ui, actions);
    renderLive(els.live, run, d, ui, actions);
    renderCompare(els.compare, ctx);
    renderCheckout(els.checkout, ctx);
    renderLog(els.log, run);
    renderDock(els.dock, run, d, actions, running);
  }

  const onNarrow = () => { ui.narrow = narrowMq.matches; render(); };
  narrowMq.addEventListener("change", onNarrow);

  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  };
  es.addEventListener("run", (m) => {
    const e = JSON.parse(m.data);
    run.events.push(e);
    if (e.type === "done") {
      run.summary = e.summary;
      run.finishedAt = e.summary.finishedAt;
      if (run.status === "running") run.status = "done";
      run.gates.clear();
      es.close();
    }
    if (e.type === "order") run.busy.delete(`buy:${e.result.store}`);
    schedule();
  });
  es.addEventListener("gate", (m) => {
    const g = JSON.parse(m.data);
    const key = `${g.step}:${g.store}`;
    if (g.open) { run.gates.set(key, g); run.answered.delete(key); } else run.gates.delete(key);
    schedule();
  });
  es.onerror = () => { if (run.summary || run.replay) es.close(); };
  const timer = setInterval(() => run.status === "running" && renderHead(els.head, run, derive(), getEx, actions, app), 1000);
  render();
  return () => { es.close(); clearInterval(timer); narrowMq.removeEventListener("change", onNarrow); main.classList.remove("has-dock"); };
}

// ---------- head ----------

function exportMenu(run, getEx) {
  const item = (label, ico, fn) => h("button", { type: "button", role: "menuitem", class: "menu-item", onclick: (e) => { e.currentTarget.closest("details").open = false; fn(getEx()); } }, icon(ico), label);
  return h("details", { class: "menu" },
    h("summary", { class: "btn sm ghost", "aria-label": "Export results" }, icon("download"), "Export"),
    h("div", { class: "menu-list", role: "menu" },
      item("Copy summary", "copy", (ex) => copyText(ex.text(), "Summary copied")),
      item("Copy as JSON", "copy", (ex) => copyText(ex.json(), "JSON copied")),
      item("Download CSV", "download", (ex) => download(`${run.id}.csv`, ex.csv(), "text/csv")),
      item("Download JSON", "download", (ex) => download(`${run.id}.json`, ex.json(), "application/json"))));
}

function renderHead(el, run, d, getEx, actions, app) {
  const running = run.status === "running";
  const credits = run.summary?.creditsUsed;
  const sig = JSON.stringify([run.status, run.prompt, elapsed(run.startedAt, run.finishedAt), credits, !!d.model.picks, d.browser?.label]);
  mount(el, sig, () => h("header", { class: "run-head" },
    h("div", { class: "run-title" },
      h("h1", { class: "q" }, run.prompt),
      h("div", { class: "meta" },
        running ? h("span", { class: "badge green" }, h("span", { class: "dot pulse" }), "Running")
          : run.status === "cancelled" ? h("span", { class: "badge red" }, "Cancelled")
          : run.status === "failed" ? h("span", { class: "badge amber" }, "Stopped early") : h("span", { class: "badge" }, "Finished"),
        running || run.finishedAt ? h("span", { title: "Time" }, elapsed(run.startedAt, run.finishedAt)) : null,
        d.browser ? h("span", { class: "browser", title: d.browser.fallback || "" }, `Browser: ${d.browser.label}`) : null,
        credits !== undefined ? h("span", { title: "Credits of this run's own browsers and tasks" }, `${run.summary?.creditsEstimated ? "about " : ""}${credits} credit${credits === 1 ? "" : "s"}`) : null,
        run.replay ? h("span", {}, new Date(run.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : null,
        app.meta.demo ? h("span", { class: "badge demo" }, "Demo data") : null)),
    h("div", { class: "run-actions" },
      d.model.picks ? h("a", { class: "btn sm ghost", href: `#/run/${encodeURIComponent(run.id)}/summary` }, icon("share"), "Share") : null,
      d.model.picks ? exportMenu(run, getEx) : null,
      running ? h("button", { class: "btn sm ghost danger", "data-key": "cancel-run", onclick: actions.cancel }, "Cancel run") : null)));
}

// ---------- stores ----------

// "Amazon blocked this browser. Browsa's Phantom passes it: browsa.io" with browsa.io as a link.
function hintText(text) {
  const i = text.lastIndexOf("browsa.io");
  if (i < 0) return text;
  return h("span", {}, text.slice(0, i), h("a", { href: "https://browsa.io", target: "_blank", rel: "noopener" }, "browsa.io"), text.slice(i + 9));
}

function renderStores(el, run, d, ui, actions) {
  const running = run.status === "running";
  const picked = !!d.model.picks;
  const list = d.order.map((s) => d.stores.get(s));
  const states = list.map((st) => storeStatus(st, { running, picked, gates: run.gates, answered: run.answered }));
  // "Amazon showed prices in IDR from your location; ...": those offers are listed, never picked.
  const curNotes = new Map();
  for (const e of run.events) if (e.type === "log" && e.store && /showed prices in [A-Z]{3}/.test(e.message)) curNotes.set(e.store, e.message);
  const sig = JSON.stringify([list.map((st, i) => [st.store, st.domain, states[i].word, states[i].detail, st.failure?.hint, !!st.liveUrl && running, curNotes.get(st.store)]), ui.live]);
  mount(el, sig, () => [
    h("div", { class: "section-head" }, h("h2", {}, "Stores"), h("span", { class: "count" }, list.length ? `${list.length}` : "")),
    list.length ? h("div", { class: "stores" }, list.map((st, i) => {
      const s = states[i];
      const f = s.failure;
      return h("section", { class: `card store tone-${s.tone}`, "aria-label": `${storeName(st.store, st.domain)}: ${s.word}` },
        h("div", { class: "name", title: st.exit ? `Connects through ${st.exit}` : null }, storeIcon(st.store, st.domain, "lg"),
          h("span", { class: "nm", title: st.store === "shopify" && st.domain ? `Shopify store ${st.domain}` : null }, storeName(st.store, st.domain))),
        h("div", { class: `status ${s.tone}`, role: "status" }, h("span", { class: `dot${s.tone === "busy" ? " pulse" : ""}`, "aria-hidden": "true" }), s.word),
        s.detail ? h("p", { class: "detail" }, s.detail) : null,
        st.failure?.hint ? h("p", { class: "blocked-note" }, hintText(st.failure.hint)) : null,
        curNotes.get(st.store) ? h("p", { class: "blocked-note" }, curNotes.get(st.store)) : null,
        f ? h("details", { class: "raw" }, h("summary", {}, "Details"), h("code", {}, shortRaw(f.raw, 300))) : null,
        h("div", { class: "store-actions" },
          f && f.action === "retry" && f.stage === "search" ? h("button", { class: "btn sm", "data-key": `retry-${st.store}`, onclick: () => actions.retryStore(st.store) }, icon("retry"), "Try again") : null,
          st.liveUrl && running ? h("button", {
            class: "btn sm ghost", "data-key": `live-${st.store}`, "aria-expanded": ui.live === st.store ? "true" : "false",
            onclick: () => actions.toggleLive(st.store),
          }, icon("eye"), ui.live === st.store ? "Hide" : "Watch live") : null));
    })) : h("div", { class: "card empty" }, h("span", { class: "dot pulse", "aria-hidden": "true" }), " Reading your request"),
  ]);
}

function renderLive(el, run, d, ui, actions) {
  const st = ui.live ? d.stores.get(ui.live) : null;
  const url = run.status === "running" ? st?.liveUrl : null;
  // Built once per store; Phantom Live links can be single-use, so never reload the frame.
  mount(el, JSON.stringify([ui.live, url]), () => (url ? h("div", { class: "card live-panel" },
    h("div", { class: "row" }, h("h2", {}, `${storeName(st.store, st.domain)}, live in Phantom`), h("span", { class: "spacer" }),
      h("button", { class: "btn sm ghost", onclick: () => actions.toggleLive(null) }, "Close")),
    h("p", { class: "hint" }, "View only. To type or click, use Take over at checkout."),
    h("iframe", { class: "live-frame", src: url, title: `${storeName(st.store)} live view`, allow: "clipboard-read; clipboard-write", referrerpolicy: "no-referrer" }),
  ) : null));
}

function renderLog(el, run) {
  const logs = run.events.filter((e) => e.type === "log");
  mount(el, String(logs.length), () => (logs.length ? h("details", { class: "log" },
    h("summary", {}, `Activity log (${logs.length})`),
    h("ol", {}, logs.map((l) => h("li", {}, h("span", { class: "s" }, l.store ? storeName(l.store) : "Agent"), h("span", {}, l.message))))) : null));
}

// ---------- the dock: one next action ----------

export function nextStep(run, d) {
  const running = run.status === "running";
  const { model, plan, stores } = d;
  const list = [...stores.values()];
  const offers = Object.values(model.offers).reduce((n, l) => n + l.length, 0);
  const names = (arr) => arr.map((s) => storeName(s.store, s.domain)).join(", ");
  const totalText = `${formatCents(plan.totalCents, plan.currency)}${plan.shippingUnknown ? " plus shipping" : ""}`;
  const budget = model.request?.budget;

  const awaiting = list.filter((s) => s.lastKind === "awaiting" && s.awaiting && !s.order);
  if (running && awaiting.length) {
    const one = awaiting.length === 1 ? awaiting[0] : null;
    return { tone: "ok", text: one ? `Ready to buy at ${storeName(one.store, one.domain)}` : `Ready to buy at ${awaiting.length} stores`, sub: "Review the total, then buy. Nothing is bought without your OK.",
      primary: { label: one ? `Buy for ${money(one.awaiting.total)}` : "Review and buy", act: one ? "buy" : "scroll", store: one?.store } };
  }
  const needs = list.filter((s) => s.lastKind === "needs" && s.needs && !s.order);
  if (running && needs.length) {
    const s = needs[0];
    return { tone: "warn", text: `${storeName(s.store, s.domain)} needs you`, sub: s.needs.message, primary: s.needs.liveUrl || s.liveUrl ? { label: "Open the live browser", act: "link", href: s.needs.liveUrl || s.liveUrl } : null };
  }
  const coGates = [...run.gates.keys()].filter((k) => k.startsWith("checkout:"));
  if (running && coGates.length) {
    return { tone: "ok", text: coGates.length === 1 ? "Cart filled" : `${coGates.length} carts filled`, sub: "Review checkout goes to the order page and stops before Place order.", primary: { label: "Review checkout", act: "review" } };
  }
  const cartGates = [...run.gates.keys()].filter((k) => k.startsWith("cart:"));
  if (running && cartGates.length && !run.busy.has("fill")) {
    if (plan.overBudget) return { tone: "bad", text: `Over your ${money(budget)} budget`, sub: `Your picks come to ${totalText}. Choose cheaper offers to go on.`, primary: { label: "Fill carts", act: "fill", disabled: true } };
    if (!plan.stores.length) return { tone: "warn", text: "Nothing to buy", sub: "Choose an offer for at least one item.", primary: null };
    const n = plan.stores.length;
    return { tone: "ok", text: `Total ${totalText}`, sub: `${plan.changed ? "Your picks" : "Best picks"} at ${names(plan.stores)}. Before tax. Nothing is bought yet.`,
      primary: { label: n === 1 ? `Fill cart at ${storeName(plan.stores[0].store, plan.stores[0].domain)}` : `Fill ${n} carts`, act: "fill" } };
  }
  if (running && !model.picks) {
    const active = list.filter((s) => !s.failure).length;
    return { tone: "busy", text: offers ? `Comparing ${offers} offer${offers === 1 ? "" : "s"}` : `Searching ${list.length || ""} store${list.length === 1 ? "" : "s"}`.replace("  ", " "),
      sub: offers ? `${active} of ${list.length} stores still in. Picks come when the stores finish.` : `${!d.browser || d.browser.provider === "browsa" ? "Phantom browsers open" : "The browser opens"} each store. This takes a minute or two.`, primary: { label: "Cancel", act: "cancel", ghost: true } };
  }
  if (running) {
    const working = list.filter((s) => run.answered.has(`cart:${s.store}`) || run.answered.has(`checkout:${s.store}`));
    return { tone: "busy", text: working.length ? "Working on the carts" : "Finishing", sub: working.length ? `${names(working)}. You will be asked before anything is bought.` : "", primary: { label: "Cancel", act: "cancel", ghost: true } };
  }
  // finished
  const placed = list.filter((s) => s.order?.placed);
  if (placed.length) return { tone: "ok", text: `${placed.length} order${placed.length === 1 ? "" : "s"} placed`, sub: names(placed), primary: { label: "New search", act: "new", ghost: true } };
  if (model.picks?.length) {
    if (model.overBudget && !plan.changed) return { tone: "bad", text: `Over your ${money(budget)} budget`, sub: `The best picks come to ${money(model.total)}. Search again with a higher budget or fewer items.`, primary: { label: "Search again", act: "again" } };
    return { tone: "idle", text: `Total ${totalText}`, sub: `${plan.changed ? "Your picks" : "Best picks"} at ${names(plan.stores)}, before tax. This search has ended; search again to fill carts.`, primary: { label: "Search again", act: "again" }, share: true };
  }
  if (run.status === "failed") return { tone: "warn", text: "This search stopped early", sub: "It ended before the stores finished. Search again to get prices.", primary: { label: "Search again", act: "again" } };
  const failed = list.filter((s) => s.failure);
  if (list.length && failed.length === list.length) return { tone: "bad", text: "No store finished", sub: "Each store stopped early. Try again, or choose other stores.", primary: { label: "Try again", act: "again" } };
  if (run.status === "cancelled") return { tone: "idle", text: "Cancelled", sub: "", primary: { label: "New search", act: "new", ghost: true } };
  return { tone: "warn", text: "Nothing found", sub: "No store had a match. Try simpler words, like \"usb-c hub\".", primary: { label: "New search", act: "new" } };
}

function renderDock(el, run, d, actions, running) {
  const s = nextStep(run, d);
  const sig = JSON.stringify([s, run.busy.has("fill"), [...run.busy]]);
  mount(el, sig, () => {
    const p = s.primary;
    const onPrimary = () => {
      if (!p) return;
      if (p.act === "fill") actions.fillCarts();
      else if (p.act === "review") actions.reviewAll();
      else if (p.act === "buy") { const st = d.stores.get(p.store); actions.buy(p.store, st.awaiting, storeName(p.store, st.domain)); }
      else if (p.act === "scroll") document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" });
      else if (p.act === "cancel") actions.cancel();
      else if (p.act === "again") actions.searchAgain();
      else if (p.act === "new") location.hash = "#/";
    };
    const btn = !p ? null : p.act === "link"
      ? h("a", { class: "btn primary", href: p.href, target: "_blank", rel: "noopener noreferrer" }, icon("live"), p.label)
      : h("button", { class: `btn ${p.ghost ? "ghost" : "primary"}`, "data-key": "dock-primary", disabled: p.disabled || run.busy.has("fill") || run.busy.has(`buy:${p.store}`), onclick: onPrimary },
        run.busy.has("fill") && p.act === "fill" ? [h("span", { class: "spin", "aria-hidden": "true" }), "Starting"] : p.label);
    return h("div", { class: `dock tone-${s.tone}`, role: "region", "aria-label": "Next step" },
      h("div", { class: "dock-text" },
        h("div", { class: "dock-main", "aria-live": "polite" }, s.tone === "busy" ? h("span", { class: "dot pulse", "aria-hidden": "true" }) : null, s.text),
        s.sub ? h("div", { class: "dock-sub" }, s.sub) : null),
      h("div", { class: "dock-actions" },
        s.share ? h("a", { class: "btn ghost", href: `#/run/${encodeURIComponent(run.id)}/summary` }, icon("share"), "Share") : null,
        btn));
  });
}
