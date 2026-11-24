import { test } from "node:test";
import assert from "node:assert/strict";
import { DATA_SAVER_BLOCKED } from "../../src/core/browsers.js";

// Chrome's Network.setBlockedURLs patterns: "*" matches any run of characters.
const matches = (url: string) =>
  DATA_SAVER_BLOCKED.some((p) => new RegExp("^" + p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(url));

test("data saver keeps Amazon's stylesheets and scripts (they live under m.media-amazon.com/images)", () => {
  assert.equal(matches("https://m.media-amazon.com/images/I/61xJcNKKLJL.css?AUIClients/AmazonUI"), false);
  assert.equal(matches("https://m.media-amazon.com/images/I/41X0pQe7pVL.js?AUIClients/AmazonUIjQuery"), false);
});

test("data saver still blocks Amazon's product photos and fonts", () => {
  assert.equal(matches("https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg"), true);
  assert.equal(matches("https://m.media-amazon.com/images/I/31abc.png"), true);
  assert.equal(matches("https://m.media-amazon.com/images/S/sash/font.woff2"), true);
});
