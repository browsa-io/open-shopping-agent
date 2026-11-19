// Walmart order pages: "Thanks for your order" and Purchase history > order details (/orders/<id>).

import type { OrderPageAdapter } from "./types.js";
import { capture, findLink, genericTracking, moneyAfter, phrase } from "./common.js";

export const walmartOrders: OrderPageAdapter = {
  store: "walmart",
  ordersUrl: () => "https://www.walmart.com/orders",
  orderUrl: (id) => `https://www.walmart.com/orders/${encodeURIComponent(id.replace(/-/g, ""))}`,
  confirmation(p) {
    const page = /\/thankyou|order-confirmation|\/orders\/\d/i.test(p.url) || /thanks for your order|order confirmed/i.test(p.text);
    if (!page) return undefined;
    const orderId = capture(p.text, /order\s*(?:#|number)\s*:?\s*([\d-]{10,})/i) ?? capture(p.url, /\/orders\/(\d{10,})/);
    if (!orderId) return undefined;
    const digits = orderId.replace(/-/g, "");
    return {
      orderId,
      orderUrl: findLink(p, new RegExp(`/orders/${digits}`)) ?? (/\/orders\/\d/.test(p.url) ? p.url.split("?")[0] : walmartOrders.orderUrl(orderId, "walmart.com")),
      total: moneyAfter(p.text, /(?:order )?total/),
      confirmationText: phrase(p.text, /thanks for your order|order confirmed/i),
    };
  },
  tracking: (p) => genericTracking(p, {
    signInUrl: /\/account\/login|identity\.walmart/i,
    storeTrack: /walmart\.com\/orders\/[\w-]+\/track/i,
    looksLikeOrder: /order\s*#|order details|purchase history/i,
  }),
};
