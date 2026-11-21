# Release check

## 0.2.1, 2026-11-21

The packed 0.2.1 tarball installed into an empty folder, no settings, no key. No order was placed, no
cart was filled, no store account was signed in to, no card or address was typed.

- **`--help`, `--version`, `mcp --help`, `mcp --version`** print and exit (0.2.1).
- **The README's first command**, exactly as written, on your Chrome with a window and no terminal
  input: `npx open-shopping-agent "usb-c hub with hdmi under \$40"`. It took 139 s and ended with
  exit code 3. Amazon 8 offers, Target 8 (all shown out of stock), Best Buy 5; "eBay: Blocked at
  search (403)"; "Walmart: Blocked at search (bot check)". Best pick Amazon $8.49 plus shipping,
  "Lowest price of the 13 offers compared ... 21 found, 8 left out: 8 out of stock". The question
  "Fill cart at Amazon (1 item, $8.49)? [y/N]" was answered n because there was no terminal. Last
  lines: "0 orders placed, 2 store failures." and "Exit code 3: eBay blocked at search (403);
  Walmart blocked at search (bot check)." The full output is in
  [runs/2026-11-21-first-command-0.2.1.txt](runs/2026-11-21-first-command-0.2.1.txt).
- **`--browser browsa` without a key**: one line saying what to set, exit 1, no demo data.
- **Web app** (`npx open-shopping-agent web`): listens on 127.0.0.1 only; requests with a `Host` of
  another name or address get 403 "Open the agent at http://localhost"; a connection to the
  machine's other address is refused.
- **MCP** (`npx open-shopping-agent mcp` over stdio): protocol 2025-06-18, 7 tools, each with
  annotations; `place_order` is marked destructive and answers `orders_disabled` without
  `OSA_MCP_ALLOW_ORDERS=1`.
- **Tests**: the default suite launches no browser; the browser suite (5 tests, real headless
  Chrome on a local page) ran on its own.

# Release check, 2026-11-18

The first public release, checked the way people will run it: the npm package installed into an
empty folder on a laptop, no repo files, no settings. Every number below is from a real run on that
day. No order was placed, no store account was signed in to, no card or address was typed.

## Setup

| | |
|---|---|
| Package | `open-shopping-agent` 0.1.0, packed with `npm pack` from commit `b7f52c1` (store fixes merged); fixes below re-packed and re-checked from `798c18d` |
| Machine | macOS 15.6.1, Node 26.0.0, npm 11.12.1 |
| Your Chrome | Google Chrome 157.0.8103.79, through playwright-core 1.65.1 |
| Phantom | Browsa cloud browsers through the `browsa` SDK 0.3.1, `OSA_MAX_BROWSERS` 1 or 2 |
| Connection | a test connection that the stores did not see as a US address (on your Chrome and CDP runs) |
| Request | `usb-c hub with hdmi and a 6 ft hdmi cable under $60`, `--zip 10001`, `--every-store` (a cart at every store), answers y to "Fill cart" and "Review checkout", Enter (N) to "Buy" |

Install: `npm install ./open-shopping-agent-0.1.0.tgz` in an empty folder took 3 min 21 s the first
time (npm registry fetches on this connection) and 1.5 s the second time. `npx open-shopping-agent
--help` and `npx osa --version` (0.1.0) work. `--demo` finishes in 6 s with made-up data and says so.

## Browsers x stores

Each cell: offers found, cart read back from the store, where checkout stopped, seconds. Seconds are
from the start of the run for your Chrome and CDP, and from the store's cart browser opening to the
checkout stop for Phantom (stores took turns there, see below).

| Store | Your Chrome, window | Your Chrome, headless | CDP (local Chrome) | Phantom on Browsa |
|---|---|---|---|---|
| Amazon | 16 offers. Cart 2 lines $15.83. Stop: sign-in page, 419 s | 16 offers. Cart 1 of 2 lines $9.99, the second add hit a bot check. Checkout: bot check, 427 s | not run | 16 offers (US residential exit). Cart 2 lines $13.83. Checkout said an item is out of stock although the cart shows it: handed off with a live link, 127 s |
| Walmart | 8 offers (the bot check cleared once after waiting). Cart: blocked, "Walmart shows a bot check that did not clear on this browser", 530 s | 0 offers: same bot check at search, 36 s | 16 offers. Cart: blocked by the same bot check, 41 s | 16 offers. Cart 2 lines $22.99. Stop: sign-in or create account, 59 s |
| eBay | 0 offers: "eBay refused the page twice (Error Page, status 403)" | 0 offers, same 403 | not run | 16 offers. Cart 2 lines $9.94. Stop: guest checkout asks for email and address, 143 s |
| Best Buy | 13 offers (product pages refused, added from results). Cart 2 lines $32.98. Checkout stayed on the cart, Best Buy guessed ZIP 12345 and "This item is no longer available for shipping". Before the fix this showed a false Buy question, see bugs | 4 offers. Cart: blocked, product page refused and no Add to cart button in the results | not run | 16 offers (US residential exit). Cart 1 of 2 lines $9.49 (the hub needed the AI fallback, which cannot act on a fresh browser). Stop: sign-in or guest page, 64 s |
| Target | 16 offers, all shown out of stock: no pick | 8 offers (the press-and-hold check did not clear for the cable search). Cart 1 line $14.99. "Target did not open its checkout page", 468 s | not run | 16 offers. Cart 2 lines $23.98. Stop: $35 shipping minimum, then sign-in, 167 s |
| satechi.com (Shopify) | 16 offers. Cart 2 lines $64.98. Stop: guest checkout (contact, address, payment), 387 s | 16 offers. Cart 2 lines $64.98. Stop: guest checkout, 385 s | 16 offers. Cart 2 lines $64.98. Stop: guest checkout, 25 s | 16 offers. Cart 2 lines $64.98. Stop: guest checkout, 27 s |
| Whole run | 652 s, 0 credits | 519 s, 0 credits | 63 s, 0 credits | 1308 s with one browser at a time, 19 credits (Browsa ledger) |

Every Buy question that appeared was answered with Enter and nothing was bought ("Not bought at
Best Buy. The cart stays filled."). Phantom browsers were destroyed at the end of each run (their
guest carts went with them); the local profile folders with guest carts were deleted.

On your Chrome a blocked store ends with one plain line, for example "Walmart blocked this browser.
Browsa's Phantom passes it: browsa.io". Headless runs say "Run without OSA_HEADLESS=1 to solve it
in the browser window, or run with Browsa".

Phantom on Browsa reached a checkout stop with a filled cart on all 6 stores. Your Chrome on this
connection reached one on Amazon (window only), Target (headless only) and satechi.com;
Walmart and eBay blocked it. A connection the stores see as a US home address may do better; that was not measured.

### Phantom run notes

- The workspace has 4 browser slots shared by every run on the account. Other runs held 3 of them
  for most of the check, so the first Phantom run waited 8 minutes and found no free slot. The run
  above started when one slot was free and used `OSA_MAX_BROWSERS=1`: each store opened a browser for
  its search, stopped it, and opened a fresh one for the cart (12 browsers for 6 stores).
- Credits: the Browsa ledger for this run's 12 browsers says 19 credits (5 per browser, 4 refunded
  for short browsers, plus residential traffic). The run printed 34 credits, fixed since (see
  below).

## Surfaces

- **Web app** (`osa web` from the installed package, your Chrome headless for the stores, a
  headless Chrome driving the page): Amazon and satechi.com searched (24 offers), best picks both
  at Amazon ($16.68), "Fill cart at Amazon" clicked, cart read back 2 lines $16.68, "Review
  checkout" clicked, stopped at Amazon's sign-in page after 42 s. No Buy button appeared.
- **MCP** (`npx open-shopping-agent mcp` over stdio): `initialize` answers protocol 2025-06-18,
  `tools/list` gives find_and_compare, fill_carts, review_checkout, place_order, watch_price,
  list_runs. One `find_and_compare` (Amazon and satechi.com, ZIP 10001) answered in 24 s with a
  run id, the comparison table and structured picks (total $16.68).

## Bring your own keys

- **Model key**: `OSA_LLM=openai:openai/gpt-4.1-mini` on OpenRouter, capped at 10 model calls by a
  counting pass-through. The model read the request as 2 items with a $60 budget (the rule parser
  reads "under $60" as the cable's price limit instead). The AI fallback ran on eBay's 403 page:
  8 steps, it opened the same search again and again and returned nothing. The second fallback hit
  the cap and asked 7 more times in 3 s (fixed, see below). 10 calls, about $0.003.
- **Proxy**: no test proxy was available, so a local HTTP proxy with a user and password was used
  (`OSA_PROXY=http://user:pass@127.0.0.1:port`). Amazon and satechi.com found 16 offers each in
  16 s, 139 requests went through the proxy, and logs show only `127.0.0.1:port`. This checks the
  proxy setting, not a different exit country.

## Safety

- Without a terminal (stdin is a pipe) every question is answered N: "Fill cart at Amazon (1 item,
  $27.99)? [y/N] n (no terminal input)". Now a test: `test/surfaces/cli-no-tty.test.ts`.
- At "Buy for $35.12 at Best Buy? [y/N]" Enter means no.
- A changed total is refused: `test/core/limits.test.ts` (approval gate) and
  `test/core/engine.test.ts` ("approve places the order only with the exact review total").

## Bugs fixed in this check (with tests)

1. **Best Buy offered Buy from the cart page.** When the Checkout click stayed on the cart, the cart
   summary was read as an order review, and "Shipping to 12345" became $12,345.00 shipping. Placing
   the order would still have been refused (no Place Your Order button), but the question was wrong.
   Now it hands off with the cart's own reason, and a ZIP is never read as a price. Re-checked live.
2. **Ctrl-C took 3 to 4 minutes** while waiting for a free browser place or a busy Browsa slot.
   Both waits now end at once.
3. **The local AI fallback kept calling a failing model API** (7 calls in 3 s after a 429). It now
   stops at the first API error; a bad answer is still retried.
4. **The web app said "Phantom browsers open each store"** on your own Chrome. Now it names
   Phantom only on Browsa.

## Bugs fixed after the check (with tests)

1. **The credit meter counted the whole account** (34 printed for a 19-credit run; carts refused
   after 10 real credits). It now counts only the run's own browsers and tasks: the ledger rows of
   their agent ids and job ids, else each browser's own charged and refunded credits, else an
   estimate from browser time marked "about". Checked live: a 2-browser run (Amazon on the
   residential exit, eBay) printed 4 credits, the ledger rows of its 2 browsers add up to 4, while
   the account's balance moved 17 credits during the run because of other runs.
2. **The cap held 5 credits per browser although 4 come back.** A fresh browser now counts 1
   credit per started 12 minutes it has run, plus its data, so 6 stores with `--every-store` and
   `OSA_MAX_BROWSERS` (12 short browsers) fit the default cap of 40.
3. **Best Buy and Walmart ignored `--zip`.** Each now types the ZIP in the store's own location box
   (no sign-in) and checks it. When the store keeps its own ZIP, the run notes and the cart say
   which ZIP its prices and delivery are for. Not re-checked live on the stores.
4. **CDP runs left their tabs open.** The tabs a run opened, and the tabs those opened, are closed
   when the run ends or is stopped. Your other tabs are not touched.

## Later the same day: README recording and the first bench run

- **Bench** (`npm run bench -- --tasks 3 --max-credits 40`, Phantom, one browser at a time): 6
  stores, 18 tasks, 20 min, 13 credits from the ledger rows of its own browsers. Every search,
  product page and cart passed except one task file error (gymshark.com is not a Shopify store any
  more; replaced with satechi.com). Checkout reached sign-in or guest on Walmart, Best Buy and
  Target; Amazon's checkout said an item was out of stock and handed off. eBay and Shopify stopped
  at their guest checkout (address), which the bench counted as a fail although its own README
  calls that page reached; the rule was fixed and both stores re-run (2 credits, both reached).
- **Web app recording** (`osa web`, `OSA_MAX_BROWSERS=2`, 6 stores with satechi.com, ZIP 10001):
  96 offers in 4 min 3 s, both picks at eBay ($6.88), Fill cart at eBay, cart read back with 2
  lines, Review checkout stopped at eBay's guest checkout (email and address). 7 min 10 s, 7
  browsers, 11 credits (ledger and each browser's own totals agree). This is the README GIF.
- **Bug found and fixed:** an earlier attempt's recorder crashed and stopped `osa web` with SIGINT
  mid-search; its 2 browsers kept running (destroyed by hand, 3 credits). `osa web` now cancels
  running searches and closes their browsers on Ctrl-C and SIGTERM.
- Every browser of these runs was checked afterwards: destroyed. No order, sign-in, card or address.

## Bugs left

1. "under $60" after the last item is that item's price limit for the rule parser and a total
   budget for a model. Both are reasonable; the CLI shows which one it used.
