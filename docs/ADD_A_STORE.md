# Add a store

A store is one file: `src/stores/<id>.ts`. It knows that store's pages and nothing else. The engine decides what to buy, applies the limits and asks for approval. An adapter never decides to pay.

This guide walks through the steps: copy the template, fill in each method, save fixtures, write tests, add bench tasks.

## 1. Copy the template

```bash
cp src/stores/_template.ts src/stores/mystore.ts
```

The template implements the `StoreAdapter` contract from `src/stores/adapter.ts`:

| Method | What it does | Required |
|---|---|---|
| `searchUrl(query, domain)` | the store's search URL for a query | yes |
| `search(ctx, item, limit)` | read up to `limit` offers from the search page | yes |
| `details(ctx, offer)` | open the product page, fill shipping, delivery, seller, variants | no, but the bench measures it |
| `addToCart(ctx, offer, quantity, options)` | choose options, choose one-time purchase, add, then read the cart back | yes |
| `readCart(ctx)` | the cart as the store shows it now | yes |
| `clearCart(ctx)` | remove what the run added | no, but tests and the bench use it |
| `reviewCheckout(ctx)` | go to checkout and stop on the review page, before "Place order" | yes |
| `placeOrder(ctx, approval)` | click "Place order" only if the total still equals `approval.approvedTotal` | yes |

Set `id`, `name` and `domains`. A new store id also needs an entry in the `StoreId` type in `src/core/types.ts`; ask in your pull request and a maintainer adds it.

## 2. Write the methods

Use the helpers in `src/stores/util.ts` instead of writing your own:

- `parseMoney("$1,299.99")` gives `{ cents: 129999, currency: "USD" }`. Prices are always cents.
- `parseStars`, `parseCount` and `clean` for ratings, review counts and text.
- `firstVisible(ctx, [selectors])` waits for whichever page state appears first.
- `needsUser(ctx, reason, message)` builds a hand-off with a Phantom Live link.
- HTML: `parseHtml` with `qs`, `qsa` and `textOf` (a small selector engine), or the string helpers
  `elementsWith`, `firstWith`, `attr`, `textLines`, `jsonLd` and `jsonAfterMarker` on raw page HTML.
- Options and dates: `pickVariant`, `optionWarnings`, `sameOption`, `parseDeliveryDate`.
- Bot checks and clicks: `passBotCheck` (on Browsa, Browsa solves it in the session; else wait for Phantom, retry once),
  `passPressAndHold` (PerimeterX "Press & hold"), `browsaSolves` (any other check you detect),
  `clickFirstVisible`, `declineOffer` (only "No thanks" style buttons), and `approvalMatches` in `placeOrder`.
- `ctx.newPage()` replaces a crashed or frozen tab with a fresh one in the same browser (same cookies and cart).
- `aiSearchFallback(ctx, ...)` reads a search page with the AI task when the direct parser found nothing.

Rules every adapter follows:

- **Direct code first.** Read pages with Playwright selectors on `ctx.page`. Prefer stable hooks (`data-*` attributes, JSON in the page) over CSS classes.
- **AI fallback at most once per stage.** If the direct code fails, call `ctx.aiTask(...)` with a schema. It costs more credits and time.
- **Flag what matters.** Set `sponsored` and `subscription` on offers. The engine never picks a subscription by default.
- **Read back, never assume.** `addToCart` returns the cart as read from the store. If an option did not stick, add a warning to `cart.warnings`.
- **Decline memberships and trials** on the way to checkout.
- **Hand off instead of guessing.** If the store needs a sign-in, a code, a card check, an address or a puzzle, return `needsUser` from `reviewCheckout` or `placeOrder`. Do not type passwords and do not solve captchas.
- **Re-read the total before placing.** `placeOrder` aborts if the review total is not `approval.approvedTotal`.

- **Say when the click happened.** Before the click, refuse with `{ placed: false, error }` or `needsUser`. After it, set `submitted: true` on every result. An order counts as placed only with an order number; anything else after the click becomes "unknown" and is never retried.

Register the adapter in `src/stores/index.ts`. Add `src/orders/<id>.ts` (confirmation page, order page, orders list URL) and register it in `src/orders/index.ts`, with extracts in `test/orders/fixtures/pages.json`.

## 3. Save fixtures

Save the pages your code reads in `test/fixtures/<id>/`: a search page, a product page, a cart page and the first checkout page.

- Trim them: remove scripts, styles and large blocks you do not read.
- Remove personal data: names, addresses, emails, order numbers, card hints.

## 4. Write tests

Put tests in `test/stores/<id>.test.ts`. Load a fixture into a page (or parse it directly) and check what your code reads:

- search returns offers with a title, URL, price in cents, rating, stock state, and sponsored flags;
- details fills shipping or delivery;
- the cart parser reads lines, quantities and the subtotal;
- the checkout parser finds the total, or returns `needsUser` on a sign-in page.

Live tests are opt-in with `OSA_LIVE=1`. They must stop at the cart or at the first checkout page.

```bash
npm test
```

## 5. Add bench tasks

Add a block for your store to `bench/tasks.json`, with about 10 tasks:

```json
{ "store": "mystore", "domain": "mystore.com", "tasks": [
  {"id": "mystore-01", "query": "AA batteries", "stages": ["search", "details", "cart", "checkout"],
   "expect": {"minOffers": 5, "minPriced": 5, "minRated": 3, "titleAny": ["batter"], "minRelevant": 3}}
] }
```

- Every task starts with `search`. `cart` adds the first in-stock, new, non-sponsored offer and reads the cart back. `checkout` passes when it reaches the sign-in, guest or review page.
- Pick everyday products that stay in stock, so a failure means the adapter broke and not that the product is gone.
- Put `details` on about half the tasks, `cart` on two and `checkout` on one, to keep a bench run cheap.

Check your tasks without a browser, then run a few for real:

```bash
npm run bench -- --dry-run
BROWSA_API_KEY=... npm run bench -- --stores mystore --tasks 3 --max-credits 10 --no-readme
```

## 6. Open a pull request

Include the bench output for your store. The supported-stores table in the README is written by the bench, not by hand.

Before you add a store, read its terms. If a store forbids automated access, or only allows it through an official API, say so in your pull request.
