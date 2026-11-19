// Orders: every order across runs, newest first, with its state (placing, placed, check the store),
// the store's order page, and the last status read from it. "Refresh status" reads each placed
// order's page on the store in the saved store profile; it never clicks or signs in.

import { ago, api, h, icon, toast } from "../lib/dom.js";
import { money, storeName, upFrontText } from "../lib/wording.js";
import { storeIcon } from "../lib/store-icon.js";
import { stateBadge } from "./checkout.js";

function trackingLine(t) {
  if (!t) return null;
  if (t.error) return h("p", { class: "faint small" }, `Status not read: ${t.error}`);
  if (t.signIn) return h("p", { class: "faint small" }, "Status not read: the saved store profile is not signed in. Sign in once in the live browser, then refresh.");
  const words = [t.status, t.deliveryText, [t.carrier, t.trackingNumber].filter(Boolean).join(" ")].filter(Boolean).join(". ");
  if (!words) return h("p", { class: "faint small" }, "The order page did not show a status.");
  return h("p", { class: "small" }, words,
    t.trackingUrl ? [" ", h("a", { href: t.trackingUrl, target: "_blank", rel: "noopener noreferrer" }, "Track")] : null,
    t.checkedAt ? h("span", { class: "faint" }, ` (read ${ago(t.checkedAt)})`) : null);
}

function row(o) {
  const name = storeName(o.store, o.storeDomain);
  return h("li", { class: `order-row state-${o.state}` },
    h("div", { class: "rowitem" },
      storeIcon(o.store, o.store === "shopify" ? o.storeDomain : undefined, "lg"),
      h("div", { class: "grow" },
        h("div", { class: "title" }, name, o.orderId ? h("span", { class: "oid" }, ` ${o.orderId}`) : null),
        h("div", { class: "sub" }, ago(o.at), o.prompt ? ` · ${o.prompt}` : "")),
      stateBadge(o.state),
      h("span", { class: "amt" }, money(o.total, ""))),
    o.state === "unknown" ? h("div", { class: "note warn order-note", role: "status" }, h("strong", {}, "Not confirmed. "), o.message || `Check your orders on ${name} before you try again.`) : null,
    o.state === "failed" && o.message ? h("p", { class: "faint small order-note" }, o.message) : null,
    h("div", { class: "order-foot" },
      upFrontText(o) ? h("p", { class: "faint small" }, upFrontText(o)) : null,
      o.state === "placed" ? trackingLine(o.tracking) : null,
      h("div", { class: "row" },
        o.orderUrl ? h("a", { class: "btn sm ghost", href: o.orderUrl, target: "_blank", rel: "noopener noreferrer" }, icon("ext"), "Order page") : null,
        o.state === "unknown" || !o.orderUrl ? h("a", { class: `btn sm ${o.state === "unknown" ? "" : "ghost"}`, href: o.ordersUrl, target: "_blank", rel: "noopener noreferrer" }, icon("ext"), `Your ${name} orders`) : null,
        h("a", { class: "btn sm ghost", href: `#/run/${encodeURIComponent(o.runId)}` }, "Open the run"))));
}

export async function ordersView(main, app) {
  document.title = "Orders - Open Shopping Agent";
  let orders = await api("/api/orders");
  const list = h("div", { class: "card pad0" });
  const count = h("span", { class: "count" });
  const refresh = h("button", { class: "btn sm", type: "button", onclick: async () => {
    refresh.disabled = true;
    refresh.replaceChildren(h("span", { class: "spin", "aria-hidden": "true" }), "Reading order pages");
    try {
      const read = await api("/api/orders/refresh", { method: "POST", body: {} });
      toast(read.length ? `Read ${read.length} order page${read.length === 1 ? "" : "s"}` : "No placed order with an order page to read");
      orders = await api("/api/orders");
      draw();
    } catch (e) { toast(e.message, true); }
    refresh.disabled = false;
    refresh.replaceChildren(icon("retry"), "Refresh status");
  } }, icon("retry"), "Refresh status");
  const draw = () => {
    count.textContent = orders.length ? `${orders.length}` : "";
    list.replaceChildren(orders.length
      ? h("ul", { class: "list orders" }, orders.map(row))
      : h("div", { class: "empty" }, h("p", {}, "No orders yet."), h("p", { class: "faint small" }, "An order shows here after you approve a checkout's exact total.")));
  };
  const canRefresh = orders.some((o) => o.state === "placed" && o.orderUrl);
  main.append(...[
    h("div", { class: "page-head" }, h("h1", {}, "Orders"), count, h("span", { class: "spacer" }), canRefresh ? refresh : null),
    canRefresh ? h("p", { class: "hint" }, app?.meta?.demo
      ? "Demo: refresh shows made-up shipping status."
      : "Refresh reads each order's page in your saved store profile. No clicks, no sign-in. Uses browser time.") : null,
    list,
  ].filter(Boolean));
  draw();
}
