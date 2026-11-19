// Shopify order pages: the thank-you page is also the order status page (it shows shipping updates
// and the tracking number once the shop ships).

import type { OrderPageAdapter } from "./types.js";
import { capture, findLink, genericTracking, moneyAfter, phrase } from "./common.js";

export const shopifyOrders: OrderPageAdapter = {
  store: "shopify",
  ordersUrl: (domain) => `https://${domain}/account/orders`,
  orderUrl: () => undefined, // order status pages carry a token; only the confirmation page knows it
  confirmation(p) {
    const page = /\/thank[-_]?you|\/orders\/[0-9a-f]{16,}/i.test(p.url) || /thank you for your (order|purchase)|your order is confirmed/i.test(p.text);
    if (!page) return undefined;
    const orderId = capture(p.text, /\b(?:order|confirmation)\s*(?:#|number:?|no\.)\s*([A-Z0-9-]*\d[A-Z0-9-]*)\b/i);
    if (!orderId) return undefined;
    const status = /\/thank[-_]?you|\/orders\//i.test(p.url) ? p.url.split("#")[0] : findLink(p, /\/orders\/[0-9a-f]{16,}/i);
    return {
      orderId,
      orderUrl: status,
      total: moneyAfter(p.text, /\btotal/),
      confirmationText: phrase(p.text, /thank you(?= for)|your order is confirmed/i),
    };
  },
  tracking: (p) => genericTracking(p, {
    signInUrl: /\/account\/login|shopify\.com\/authentication/i,
    looksLikeOrder: /order\s*(#|number)|confirmation\s*#|order (details|updates|confirmed)/i,
  }),
};
