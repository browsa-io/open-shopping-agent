// Amazon order pages: the "Order placed, thanks!" page and Your Orders > Order details.

import type { OrderPageAdapter } from "./types.js";
import { capture, findLink, genericTracking, moneyAfter, phrase } from "./common.js";

const ORDER_ID = /(\d{3}-\d{7}-\d{7})/;

export const amazonOrders: OrderPageAdapter = {
  store: "amazon",
  ordersUrl: () => "https://www.amazon.com/gp/css/order-history",
  orderUrl: (id) => `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(id)}`,
  confirmation(p) {
    const page = /\/buy\/thankyou|order-confirmation/i.test(p.url) || /order placed,? thank(s| you)|your order has been placed/i.test(p.text);
    if (!page) return undefined;
    const orderId = capture(p.text, new RegExp(`order\\s*(?:#|number)?\\s*:?\\s*${ORDER_ID.source}`, "i"))
      ?? capture(findLink(p, /order-details\?orderID=/i) ?? "", /orderID=(\d{3}-\d{7}-\d{7})/i);
    if (!orderId) return undefined;
    return {
      orderId,
      orderUrl: findLink(p, new RegExp(`order-details\\?orderID=${orderId}`, "i")) ?? amazonOrders.orderUrl(orderId, "amazon.com"),
      total: moneyAfter(p.text, /order total/),
      confirmationText: phrase(p.text, /order placed,? thanks?(?: you)?|thank you, your order has been placed/i),
    };
  },
  tracking: (p) => genericTracking(p, {
    signInUrl: /\/ap\/signin|\/ap\/mfa/i,
    storeTrack: /\/(progress-tracker|gp\/your-account\/ship-track)/i,
    looksLikeOrder: /order (details|placed|#)/i,
  }),
};
