// The order page adapter of each store (see types.ts).

import type { StoreId } from "../core/types.js";
import type { OrderPageAdapter } from "./types.js";
import { amazonOrders } from "./amazon.js";
import { walmartOrders } from "./walmart.js";
import { ebayOrders } from "./ebay.js";
import { bestbuyOrders } from "./bestbuy.js";
import { targetOrders } from "./target.js";
import { shopifyOrders } from "./shopify.js";

export const ORDER_PAGES: Record<StoreId, OrderPageAdapter> = {
  amazon: amazonOrders, walmart: walmartOrders, ebay: ebayOrders, bestbuy: bestbuyOrders, target: targetOrders, shopify: shopifyOrders,
};

export function orderPages(store: StoreId): OrderPageAdapter {
  return ORDER_PAGES[store];
}

export type { ConfirmationInfo, OrderPageAdapter, PageExtract, TrackingInfo } from "./types.js";
export { extractPage } from "./common.js";
