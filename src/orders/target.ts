// Target order pages: "Thanks for your order!" (/co-thankyou or /order-confirmation) and Orders > order.

import type { OrderPageAdapter } from "./types.js";
import { capture, findLink, genericTracking, moneyAfter, phrase } from "./common.js";

export const targetOrders: OrderPageAdapter = {
  store: "target",
  ordersUrl: () => "https://www.target.com/orders",
  orderUrl: (id) => `https://www.target.com/orders/${encodeURIComponent(id)}`,
  confirmation(p) {
    const page = /order-confirmation|\/co-thankyou/i.test(p.url) || /thanks for your order/i.test(p.text);
    if (!page) return undefined;
    const orderId = capture(p.text, /order\s*(?:#|number)\s*:?\s*(\d{9,})/i);
    if (!orderId) return undefined;
    return {
      orderId,
      orderUrl: findLink(p, new RegExp(`/orders/${orderId}`)) ?? targetOrders.orderUrl(orderId, "target.com"),
      total: moneyAfter(p.text, /(?:order )?total/),
      confirmationText: phrase(p.text, /thanks for your order/i),
    };
  },
  tracking: (p) => genericTracking(p, {
    signInUrl: /\/login\b|\/account\/signin/i,
    storeTrack: /target\.com\/orders\/[\w-]+\/track/i,
    looksLikeOrder: /order\s*(#|number|details)/i,
  }),
};
