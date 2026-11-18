// The shareable summary of a run (#/run/<id>/summary): the picks with prices and links, the total,
// and buttons to copy the link or the text. Uses the same plan as the run page (your swaps included).

import { api, copyText, h, icon, store } from "../lib/dom.js";
import { formatCents, money, storeName } from "../lib/wording.js";
import { storeIcon } from "../lib/store-icon.js";
import { computePlan, deliveryShort, runModel, shippingKnown, summaryText, totalCents } from "../lib/model.js";

export async function summaryView(main, id) {
  const rec = await api(`/api/runs/${encodeURIComponent(id)}`);
  const run = { id, prompt: rec.prompt, startedAt: rec.startedAt };
  const model = runModel(rec.events || []);
  const plan = computePlan(model, store.get(`osa.plan.${id}`, {}));
  const link = `${location.origin}${location.pathname}#/run/${encodeURIComponent(id)}/summary`;
  document.title = `Summary: ${rec.prompt.slice(0, 40)} - Open Shopping Agent`;
  const when = rec.startedAt ? new Date(rec.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";

  main.append(h("article", { class: "summary" },
    h("div", { class: "page-head" },
      h("div", {},
        h("p", { class: "eyebrow" }, "Shopping summary"),
        h("h1", {}, rec.prompt),
        h("p", { class: "faint small" }, [when, `${plan.items.filter((i) => i.offer).length} of ${plan.items.length} items picked`].filter(Boolean).join(". "))),
      h("span", { class: "spacer" }),
      h("div", { class: "row" },
        h("button", { class: "btn sm", onclick: () => copyText(link, "Link copied") }, icon("copy"), "Copy link"),
        h("button", { class: "btn sm ghost", onclick: () => copyText(summaryText(run, model, plan, link), "Summary copied") }, icon("copy"), "Copy text"),
        h("a", { class: "btn sm ghost", href: `#/run/${encodeURIComponent(id)}` }, "Open the run"))),
    plan.items.length ? h("ol", { class: "card pad0 sum-list" }, plan.items.map((it) => {
      const o = it.offer;
      if (!o) return h("li", { class: "sum-item" }, h("div", { class: "sum-main" }, h("div", { class: "sum-label" }, it.label), h("p", { class: "muted" }, "No pick")));
      return h("li", { class: "sum-item" },
        h("span", { class: "thumb lg" }, o.image ? h("img", { src: o.image, alt: "", loading: "lazy", referrerpolicy: "no-referrer", width: 64, height: 64 }) : null),
        h("div", { class: "sum-main" },
          h("div", { class: "sum-label" }, it.label, it.quantity > 1 ? ` (x${it.quantity})` : ""),
          h("a", { class: "clamp2 sum-title", href: o.url, target: "_blank", rel: "noopener noreferrer", title: o.title }, o.title),
          h("p", { class: "faint small" }, storeIcon(o.store, o.storeDomain, "sm"), " ", [storeName(o.store, o.storeDomain), o.rating ? `${o.rating.stars.toFixed(1)} stars (${o.rating.count.toLocaleString("en-US")})` : null,
            deliveryShort(o, rec.startedAt) ? `Delivery ${deliveryShort(o, rec.startedAt)}` : null].filter(Boolean).join(". "))),
        h("div", { class: "sum-price" },
          h("div", { class: "amt strong" }, formatCents(totalCents(o, it.quantity), o.price.currency)),
          h("div", { class: "sub" }, shippingKnown(o) ? (o.shipping.cents === 0 ? "free shipping" : `incl. ${money(o.shipping)} shipping`) : "plus shipping")));
    })) : h("div", { class: "card empty" }, "This run has no picks to share."),
    plan.items.length ? h("div", { class: "card totals" },
      h("span", { class: "muted" }, "Total"),
      h("span", { class: "sum" }, formatCents(plan.totalCents, plan.currency)),
      h("span", { class: "faint small" }, plan.shippingUnknown ? "plus shipping where the store did not show it, before tax" : "before tax")) : null,
    h("p", { class: "hint" }, "This link opens on the computer that runs Open Shopping Agent. Copy the text to share it anywhere."),
  ));
}
