// Carts and checkout: one panel per store with the plan, the cart read back from the store, the
// checkout review and the Buy button. Every step says what happens next.

import { h, icon, mount } from "../lib/dom.js";
import { formatCents, friendlyError, money, shortRaw, storeName } from "../lib/wording.js";

function linesList(lines, priced = true) {
  return h("ul", { class: "lines" }, lines.map((l) => h("li", {},
    h("div", { class: "lt" }, h("span", { class: "clamp2", title: l.title }, l.title),
      h("div", { class: "lq" }, `Qty ${l.quantity}`, l.options ? `, ${Object.values(l.options).join(", ")}` : "")),
    priced ? h("div", { class: "lp" }, l.price ? money(l.price) : formatCents(l.cents, l.unit?.currency)) : null)));
}

const STEPS = ["Fill cart", "Review checkout", "Buy"];

function steps(n) {
  return h("ol", { class: "steps", "aria-label": `Step ${Math.min(n + 1, 3)} of 3` },
    STEPS.map((s, i) => h("li", { class: i < n ? "done" : i === n ? "now" : "" }, h("span", { class: "sr" }, i < n ? "Done: " : i === n ? "Now: " : ""), s)));
}

const spin = (text) => h("p", { class: "working" }, h("span", { class: "spin", "aria-hidden": "true" }), text);

function panel(ctx, store, planStore) {
  const { run, stores, actions } = ctx;
  const st = stores.get(store) || { store, failures: [], lastKind: "" };
  const name = storeName(store, st.domain || planStore?.domain);
  const running = run.status === "running";
  const gate = (step) => run.gates.has(`${step}:${store}`);
  const busy = (step) => run.busy.has(`${step}:${store}`);
  const said = (step) => run.answered.has(`${step}:${store}`);
  const live = st.needs?.liveUrl || st.liveUrl;
  const stepN = st.order?.placed ? 3 : st.awaiting || st.review ? 2 : st.cart ? 1 : 0;
  const body = [];
  const planLines = planStore ? linesList(planStore.lines) : null;
  const k = st.lastKind;

  if (st.order) {
    const o = st.order;
    body.push(o.placed
      ? h("div", { class: "order" }, h("div", { class: "big" }, icon("check"), "Order placed"),
        h("p", { class: "muted" }, `${money(o.total)} at ${name}`),
        o.orderId ? h("p", {}, "Order ", h("span", { class: "oid" }, o.orderId)) : null,
        o.confirmationText ? h("p", { class: "faint small" }, o.confirmationText) : null)
      : h("div", { class: "note bad" }, h("strong", {}, "Not ordered. "), o.error || o.confirmationText || "The store did not confirm the order. Nothing was charged by the agent."));
    if (!o.placed && o.needsUser?.liveUrl) body.push(h("a", { class: "btn", href: o.needsUser.liveUrl, target: "_blank", rel: "noopener noreferrer" }, icon("live"), "Open the live browser"));
  } else if (k === "needs" && st.needs && !running) {
    if (st.cart) body.push(linesList(st.cart.lines));
    body.push(h("div", { class: "note warn" }, h("strong", {}, "Stopped here. "), st.needs.message));
    body.push(h("p", { class: "hint" }, `This search has ended and its browser is closed. Search again to fill a new cart at ${name}.`));
  } else if (k === "needs" && st.needs) {
    if (st.cart) body.push(linesList(st.cart.lines));
    body.push(h("div", { class: "note warn", role: "status" }, h("strong", {}, "Needs you. "), st.needs.message));
    const again = gate("checkout");
    body.push(h("div", { class: "actions" },
      live ? h("a", { class: "btn primary", href: live, target: "_blank", rel: "noopener noreferrer" }, icon("live"), "Open the live browser") : null,
      again ? h("button", { class: "btn", "data-key": `again-${store}`, disabled: busy("checkout"), onclick: () => actions.answer("checkout", store, true) }, "Review checkout again") : null,
      again ? h("button", { class: "btn ghost", "data-key": `stop-${store}`, disabled: busy("checkout"), onclick: () => actions.answer("checkout", store, false) }, "Stop here") : null));
    body.push(h("p", { class: "hint" }, again ? "Finish it in the live browser, then review the checkout again. The cart stays filled." : "Finish it in the live browser. The cart stays filled."));
  } else if (k === "awaiting" && st.awaiting) {
    const r = st.awaiting;
    body.push(linesList(r.lines));
    body.push(h("dl", { class: "sums" },
      h("dt", {}, "Subtotal"), h("dd", {}, money(r.subtotal)),
      h("dt", {}, "Shipping"), h("dd", {}, r.shipping ? (r.shipping.cents === 0 ? "Free" : money(r.shipping)) : "not shown"),
      h("dt", {}, "Tax"), h("dd", {}, money(r.tax)),
      h("dt", { class: "grand" }, "Total"), h("dd", { class: "grand" }, money(r.total))));
    if (r.shipTo || r.paymentHint) body.push(h("p", { class: "faint small" }, [r.shipTo && `Ships to ${r.shipTo}`, r.paymentHint].filter(Boolean).join(". ")));
    body.push(h("button", {
      class: "btn primary buy", "data-key": `buy-${store}`, disabled: run.busy.has(`buy:${store}`), onclick: () => actions.buy(store, r, name),
    }, run.busy.has(`buy:${store}`) ? [h("span", { class: "spin", "aria-hidden": "true" }), "Placing order"] : `Buy for ${money(r.total)}`));
    body.push(h("div", { class: "sub-actions" },
      live ? h("a", { class: "btn ghost sm", href: live, target: "_blank", rel: "noopener noreferrer" }, icon("live"), "Take over") : null,
      h("button", { class: "btn ghost sm", "data-key": `nobuy-${store}`, onclick: () => actions.dontBuy(store, name) }, "Don't buy")));
    body.push(h("p", { class: "hint center" }, "The agent checks the total again on the store and stops if it changed."));
  } else if (k === "failed" && st.failure && (st.failure.stage !== "search" || st.cart)) {
    const f = friendlyError(st.failure.error, st.failure.stage, store, st.domain);
    if (st.cart?.lines.length) body.push(linesList(st.cart.lines)); else if (planLines) body.push(planLines);
    body.push(h("div", { class: "note bad" }, h("strong", {}, `${f.title}. `), f.hint,
      h("details", { class: "raw" }, h("summary", {}, "Details"), h("code", {}, shortRaw(f.raw, 400)))));
    if (f.action === "retry") body.push(h("div", { class: "actions" }, h("button", { class: "btn", "data-key": `retry-co-${store}`, onclick: () => actions.retryStore(store) }, icon("retry"), `Try ${name} again`)));
  } else if (st.cart && gate("checkout")) {
    body.push(h("p", { class: "faint small" }, `Cart read back from ${name}`));
    body.push(linesList(st.cart.lines));
    for (const w of st.cart.warnings || []) body.push(h("div", { class: "note warn" }, w));
    body.push(h("div", { class: "actions" },
      h("button", { class: "btn primary", "data-key": `co-${store}`, disabled: busy("checkout"), onclick: () => actions.answer("checkout", store, true) }, "Review checkout"),
      h("button", { class: "btn ghost", "data-key": `stop-${store}`, disabled: busy("checkout"), onclick: () => actions.answer("checkout", store, false) }, "Stop here")));
    body.push(h("p", { class: "hint" }, "Goes to the order review page and stops before Place order."));
  } else if (st.cart) {
    body.push(h("p", { class: "faint small" }, `Cart read back from ${name}`));
    body.push(linesList(st.cart.lines));
    for (const w of st.cart.warnings || []) body.push(h("div", { class: "note warn" }, w));
    if (running && said("checkout")) body.push(spin("Going to checkout. It stops before Place order."));
    else if (!running) body.push(h("p", { class: "faint small" }, "Cart filled. The checkout was not reviewed."));
  } else {
    if (planLines) body.push(planLines);
    // Filling goes through the dock's "Fill carts", which sends your swaps and quantities first.
    if (running && gate("cart")) body.push(h("p", { class: "faint small" }, "Not in the cart yet. Fill carts below when the picks look right."));
    else if (running && said("cart")) body.push(spin("Adding to the cart, then reading the cart back"));
    else if (running) body.push(h("p", { class: "faint small" }, "Waiting for the comparison to finish"));
    else body.push(h("p", { class: "faint small" }, "Cart not filled."));
  }

  const sum = planStore ? h("span", { class: "co-sum" }, formatCents(planStore.cents), planStore.shippingUnknown ? h("small", {}, " plus shipping") : null) : null;
  return h("section", { class: "card co", "aria-label": `Checkout at ${name}` },
    h("div", { class: "co-head" }, h("h3", {}, name), sum), steps(stepN), body);
}

/** Stores shown: the plan's stores, plus any store with cart or checkout activity. */
export function renderCheckout(el, ctx) {
  const { run, plan, stores, model } = ctx;
  if (!model.picks) { mount(el, "none", () => null); return; }
  const keys = plan.stores.map((s) => s.store);
  for (const [s, st] of stores) if ((st.cart || st.review || st.order || st.needs) && !keys.includes(s)) keys.push(s);
  const sig = JSON.stringify([keys.map((s) => { const st = stores.get(s); return st ? [st.lastKind, st.last, st.cart?.lines.length, !!st.order] : null; }),
    plan.stores, [...run.gates.keys()], [...run.answered], [...run.busy], run.status]);
  mount(el, sig, () => keys.length ? [
    h("div", { class: "section-head", id: "checkout" }, h("h2", {}, "Carts and checkout"), h("span", { class: "count" }, `${keys.length} store${keys.length === 1 ? "" : "s"}`)),
    h("div", { class: "checkout" }, keys.map((s) => panel(ctx, s, plan.stores.find((p) => p.store === s)))),
  ] : null);
}
