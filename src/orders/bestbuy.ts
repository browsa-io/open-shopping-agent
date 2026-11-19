// Best Buy order pages: "Thank you for your order" and Order details (BBY01-... order numbers).

import type { OrderPageAdapter } from "./types.js";
import { capture, findLink, genericTracking, moneyAfter, phrase } from "./common.js";

export const bestbuyOrders: OrderPageAdapter = {
  store: "bestbuy",
  ordersUrl: () => "https://www.bestbuy.com/purchasehistory/purchases",
  orderUrl: (id) => `https://www.bestbuy.com/profile/ss/orders/order-details/${encodeURIComponent(id)}/view`,
  confirmation(p) {
    const page = /thank-you|order-confirmation|\/confirmation/i.test(p.url) || /thank you for your order|order (is )?confirmed|we('|’)ve received your order/i.test(p.text);
    if (!page) return undefined;
    const orderId = capture(p.text, /\b(BBY01-\d{9,})\b/);
    if (!orderId) return undefined;
    return {
      orderId,
      orderUrl: findLink(p, new RegExp(`order-details/${orderId}`)) ?? bestbuyOrders.orderUrl(orderId, "bestbuy.com"),
      total: moneyAfter(p.text, /(?:order )?total/),
      confirmationText: phrase(p.text, /thank you for your order|we('|’)ve received your order/i),
    };
  },
  tracking: (p) => genericTracking(p, {
    signInUrl: /\/identity\/signin|\/signin\b/i,
    storeTrack: /bestbuy\.com\/.*track/i,
    looksLikeOrder: /order (details|number|#)|BBY01-/i,
  }),
};
