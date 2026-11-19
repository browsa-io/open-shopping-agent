// eBay order pages: "Order confirmed" after Confirm and pay, and the order details page.

import type { OrderPageAdapter } from "./types.js";
import { capture, findLink, genericTracking, moneyAfter, phrase } from "./common.js";

export const ebayOrders: OrderPageAdapter = {
  store: "ebay",
  ordersUrl: () => "https://www.ebay.com/mye/myebay/purchase",
  orderUrl: (id) => `https://order.ebay.com/ord/show?orderId=${encodeURIComponent(id)}#/`,
  confirmation(p) {
    const page = /order (is )?confirmed|thank you for your (order|purchase)|you're all set/i.test(p.text);
    if (!page) return undefined;
    const orderId = capture(p.text, /order number\s*:?\s*(\d{2}-\d{5}-\d{5}|\d[\d-]{7,})/i);
    if (!orderId) return undefined;
    return {
      orderId,
      orderUrl: findLink(p, /order\.ebay\.com\/ord\/show|FetchOrderDetails/i) ?? ebayOrders.orderUrl(orderId, "ebay.com"),
      total: moneyAfter(p.text, /(?:order )?total/),
      confirmationText: phrase(p.text, /order (is )?confirmed|thank you for your (order|purchase)/i),
    };
  },
  tracking: (p) => genericTracking(p, {
    signInUrl: /signin\.ebay\.com/i,
    storeTrack: /ebay\.com\/.*(track|shipment)/i,
    looksLikeOrder: /order (details|number|info)/i,
  }),
};
