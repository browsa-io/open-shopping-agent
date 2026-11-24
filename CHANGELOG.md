# Changelog

What changed in each published version of Open Shopping Agent. Dates are the day the version went
to npm (UTC). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/).

No order has gone through Open Shopping Agent end to end yet. Placing orders, Buy without asking and
order tracking are tested against fakes and saved store pages, not a live checkout.

## [0.2.4] - 2026-11-24

### Fixed

- **Amazon finds the named product when it has no buy box.** A live run for "AirPods Pro 3" listed only Beats and other earbuds for Amazon: Amazon showed AirPods Pro 3 with "No featured offers available, $138.73 (16 used & new offers)" and no main price, and cards without a main price were skipped. Such a card is now kept at its from-price, its condition is left unknown, and it ranks as not new. The product page then tells what the buy box sells: when it sells only a used copy ("Buy Used: $141.55", "Used: Like New"), the offer is marked used with that price and note.
- Amazon titles keep the brand line Amazon shows above the name ("Beats Fit Pro (1st Gen) ..." instead of "Fit Pro (1st Gen) ..."), and the "Sponsored Ad -" label read out in a card's title is dropped (the offer stays marked sponsored).
- **Best Buy fills its cart again.** Its product page shows Add to cart about 12 s after the page loads; the adapter looked after 3 s, found no button and asked an AI fallback, which cannot act on a fresh browser's cart. It now waits for the button (up to 25 s), and when there is still none it adds from the search results card, as it already did when the product page is refused.
- **Best Buy search without prices is a refused address.** A results page whose products have no prices (or no products, without Best Buy's "no results" wording) is how Best Buy refuses an address it distrusts. On Browsa this now counts as a refusal, so the store gets a fresh address, instead of an AI fallback that fails the same way on the same kind of exit. Your own Chrome keeps the AI fallback.
- **Two fresh addresses per store by default** (`OSA_FRESH_EXITS`, was 1). Amazon refused two residential addresses in a row in a live run and worked on others.
- **A part number is not a model number.** With two Shopify stores in the run, "Apple AirPods Pro 1st Generation ... MLWK3AM/A" at $69.99 was the best pick for "AirPods Pro 3": the 3 inside the part number counted as the model. Words with three or more letter/number runs (part numbers) are no longer split; "3rd" and "Pro3" still match 3.
- Walmart listings named "(Open Box)" or "Restocked" are used, not new.
- **Marketplace sellers with few ratings are not picked.** eBay results for "AirPods Pro 3" had "new" listings at $85 to $115 from sellers with 0 to 4 ratings or 95.9% positive, below every store's price. Listings from sellers with under 100 ratings or under 97% positive are left out when another offer remains ("3 from little-known sellers").
- Web app: in "Best match" order, offers left out as not the item (cases, other models and products, little-known marketplace sellers) come after the item's own offers instead of mixing in by price, and are never the next best.
- Web app: several Shopify shops in one run share a card titled "Shopify (2)" (the shops listed on hover) instead of the last shop's name.

## [0.2.3] - 2026-11-24

### Fixed

- Data saver no longer blocks Amazon's stylesheets and scripts. They are served from `m.media-amazon.com/images/...`, the same path as its photos, so on a residential exit Amazon pages drew as raw text in the live view. Photos and fonts are still not loaded.
- **A store that refuses the browser's address gets a fresh one.** A live run for "AirPods Pro 3" on Browsa's residential US exit hit Amazon's "Sorry! Something went wrong" page, retried twice on the same browser and address, and failed Amazon, while other runs on other addresses worked. Now, when a store refuses the address at search (Amazon's error page or a "continue shopping" check that does not clear, Access Denied, HTTP 403/435/503), the agent stops that browser, opens a fresh one on a new address of the same exit (for example residential US) and searches again, logging "Amazon refused this address; trying a fresh one". Once per store per run by default (`freshExitsPerStore`, `OSA_FRESH_EXITS`; 0 turns it off). Only on Browsa's fresh browsers: never on your own Chrome, a CDP browser, a saved profile or your own proxy, never for a check Browsa solves or hands to you, never after a stop. When the fresh address is refused too, the store fails with one message saying both addresses were refused, and the store card says so instead of "Try again later".
- **Best pick: the named product, not another one.** A third live run for "AirPods Pro 3" picked "JBL Live Beam 3 ... IP55 Waterproof" at $99.95: "pro" matched inside "waterproof" and "3" matched "Beam 3", and the product name was not required. Model and name words now match as whole words ("3rd"/"Third" still count as 3), and when an offer that is not an accessory names the product and the model, offers without the product's name ("JBL Live Beam 3", "Fit Pro (1st Gen)", "Apple EarPods (USB-C)") are left out as other products. The reason counts them ("7 found, 5 left out: 3 other products, 1 accessory (not the item itself), 1 other model"). Queries without a model number and accessory queries rank as before.
- **The AI fallback gets its own time, and a fallback that is no longer wanted is cancelled.** A live run for "AirPods Pro 3" (Amazon, Walmart, Best Buy, Target; 4 browsers at once) had Best Buy and Target hand off to the AI fallback late in their 180 s search step. Each fallback task needed its own browser and waited behind the slot limit, both stores timed out, and the two tasks finished minutes later (8 credits each) with their results thrown away: 16 credits for nothing. Now:
  - When a store's step hands off to the AI fallback, the step and the store's search deadline move to at least now + 150 s (`aiFallbackMs`, `OSA_AI_FALLBACK_MS`), and the store card says "Waiting for the AI fallback", or "Waiting for a free browser" while Browsa queues the task (new `store_waiting` run event).
  - When that time runs out, the store is stopped or the run is stopped, the Browsa task is cancelled so it stops charging, logging "cancelled the AI task <id> (no result was used)". A task that cannot be cancelled and still finishes is logged as arriving too late, with its credits; it is never dropped silently.
  - A fallback that runs in its own browser (fresh browsers) first stops the store's own browser when every browser slot is in use (another browser of the run waits for a slot, or the `maxBrowsers` cap is reached), or when Browsa keeps the task queued, so it is not stuck behind the slot limit. Product pages for that item are skipped and a fresh browser opens for the next item or the cart. Only during the search: a browser that holds a cart is never stopped for this.

## [0.2.2] - 2026-11-24

### Fixed

- **An accessory no longer wins for a named product.** A live run for "AirPods Pro 3" (Amazon,
  Walmart, Best Buy, Target) picked "ESR for AirPods Pro 3 Case (2025), Magnetic Lid" at $13.59 as
  the "Lowest price of the 24 offers compared", and "Fill cart" put the case in the Amazon cart,
  while Walmart had "Apple AirPods Pro 3" at $149.00. The title matched every word of the query, so
  the case looked like the cheapest AirPods. Ranking now spots an accessory for the product you
  asked for: an accessory word (case, cover, charger, cable, screen protector, strap, band, ear
  tips, skin, replacement, ...) with the product named after "for", "compatible with", "designed
  for" or "works with" ("ESR for AirPods Pro 3 Case"), or the product's name directly followed by
  one ("AirPods Pro 3 Case", "Apple Watch Series 11 Band"). Those offers are left out of the pick
  when some other offer is the product itself; they stay in the list, and the reason counts them
  ("6 found, 4 left out: 4 accessories (not the item itself)"). If only accessories were found,
  nothing is left out. A query that asks for an accessory ("airpods pro 3 case", "usb-c hub hdmi",
  "65w charger") ranks as before. The CLI, MCP `find_and_compare` and the web app share this rule
  (it is in the engine's ranking), and the web app's next best after you exclude a store skips
  the accessories too.
- **The named model wins, not a case or another model.** A second live run for "AirPods Pro 3"
  (with the fix above) picked Target's "AirPods Pro (1/2 Generation) Silicone Airpods Case with
  Clip - heyday™" at $10.00: a case with no "for", for another model. Now:
  - A case, cover, sleeve, skin or protector named after the product is an accessory without a
    "for" too ("AirPods Pro (3rd Generation) Case with Clip"), unless it comes with the product
    ("with MagSafe Charging Case", "Charging Case Included", "Aluminum Case with Sport Band").
  - A query with a model number names a model: "AirPods Pro 3" needs "pro" and "3" (or "3rd
    Generation"). When an offer names the model, offers that do not ("Apple AirPods 5", "Apple
    EarPods (USB-C)", "AirPods Pro (1/2 Generation)") are left out as other models. Sizes and
    counts are not model numbers ("30 lb", "65W", "27 inch", "4K", "size 10", "2 pack").
  - With two or more offers naming the model, an offer under 40% of their median price is left
    out as not the item.
  - The reason counts them: "7 found, 5 left out: 3 accessories (not the item itself), 2 other
    models". The pick for that run is Walmart's "Apple AirPods Pro 3" at $149.00. Queries for an
    accessory and queries without a model number rank as before.
- **The web app's pick reason keeps the engine's count.** "Lowest delivered total of N offers"
  used the number of offers found, not the number compared, since the reason started saying "of
  the N offers compared" in 0.2.1.

## [0.2.1] - 2026-11-21

A release about saying what happened. An independent audit of 0.2.0 found places where the output,
the exit code or the README did not match what the run did. Each fix below has a test.

### Fixed

- **A run with a store failure no longer exits 0.** The exit code is now the failed store's: 2 for a
  store or network problem or a block, 3 when it needs you (a bot check, a sign-in), 4 for a safety
  refusal, also when other stores gave results. The run prints which store and why
  ("Exit code 2: eBay blocked at search (403)."). With `--json` a partial run keeps `"ok": true`,
  adds `data.partial: true` and lists the failures, and exits with the same code. The README table
  and `--help` now say this.
- **No demo data unless you ask for it.** `--browser browsa` without `BROWSA_API_KEY` (and
  `--browser cdp` without `OSA_CDP_URL`, or no Chrome installed) used to switch to made-up demo
  products with a banner and exit 0. It now stops with exit 1 and says what to set: "set
  BROWSA_API_KEY, or use --browser local (your own Chrome), or pass --demo". The new error code is
  `setup_needed`. Over MCP the shopping tools answer `setup_needed` in the same case. The web app
  still opens (Settings is where you save a key) and says on start that it shows demo data.
- **A block is reported as a block.** When eBay refused the search page (its error page, HTTP 403),
  the adapter returned no offers and the run printed "Nothing found". It now fails the store with
  the block, in the words of the README's per-browser table: "Blocked at search (403)", "Blocked at
  the cart (bot check)". The one-line note about Phantom is shown for a plain refusal too.
- **The pick reason is not cut mid-word.** A long delivery text ended like "…on ord". It is now cut
  at a word, with "…". The CLI table's delivery column is cut the same way.
- **The pick reason counts what was compared.** It said "Lowest price of 12 offers" when 21 were
  found. It now says "of the 12 offers compared" and adds what was left out and why: "21 found, 9
  left out: 5 out of stock, 4 over $15.00 each".
- **Bench results file and README sentence agree.** `bench/results/latest.json` merged a 13-credit
  run of all stores with a 2-credit second run of eBay and the Shopify stores, but its top level
  said `creditsUsed: 2`. A merged file now lists its runs, says which run each store's result came
  from, and gives both figures: 13 credits for the results shown, 15 for the two runs. The README
  says the same and explains why two stores were run again.
- **A bench dry run cannot be read as fresh numbers.** Without a `BROWSA_API_KEY` secret the daily
  bench workflow only checks the task file. That job is now named "DRY RUN, no numbers", writes that
  in its summary, and the workflow is named "bench (dry run unless BROWSA_API_KEY is set)".
- **The MCP server instructions no longer say every run uses Phantom cloud browsers.** They describe
  the order of the tools, that `place_order` is off by default, and that store text is data.

### Changed

- **The headline matches a default run.** The README, the package description and `--help` said
  "any Shopify store". A default run searches Amazon, Walmart, eBay, Best Buy and Target; a Shopify
  store is searched when you name its domain (`--stores satechi.com`) or turn on the opt-in Shop
  catalog. The text now says so. Behaviour did not change.
- **`npm test` launches no browser.** The tests that start a real Chrome moved to their own suite,
  `npm run test:browser`, with a timeout on every launch and test and a forced cleanup, so they
  cannot hang. CI runs that suite in its own job on a runner with Chrome. CONTRIBUTING describes
  both suites.
- The demo's made-up store failure (Target) now gives exit 2 like a real one.
- The bench table row is "Shopify stores (named by domain)": it measures three named stores.
- The test fixture for prices in another currency is a synthetic page in euros, and the docs no
  longer describe the connection the release check ran on.

### Added

- **MCP annotations on every tool.** `find_and_compare`, `list_runs` and `list_orders` are marked
  read-only; `place_order` is marked destructive and is still off unless `OSA_MCP_ALLOW_ORDERS=1`;
  `review_checkout` is marked destructive when an up-front limit is set, because it can buy then.
- `open-shopping-agent mcp --help` and `mcp --version` print and exit without starting the server.
- **Price per unit in the CLI table**, in a "Per unit" column when an offer has one (the web app
  showed it since 0.2.0).
- **Price history per watch (preview, off by default).** With `OSA_PRICE_HISTORY=1` the web app
  shows a small chart of the best in-stock price each check of a watch found, from the history
  already kept on your computer. It is the first piece of 0.3.0 and may change.
- This changelog, and a workflow that publishes a tagged version to npm with provenance and creates
  the GitHub Release from the notes here.

## [0.2.0] - 2026-11-19

### Added

- **Buy without asking (off by default).** You can approve purchases up front within limits you
  set: the most one order may cost, the stores, an expiry, a total for the run and a number of
  orders (`--approve-up-to 60 --approve-stores walmart,target --approve-expires 2h`, the "Buy
  without asking" setting in the web app, or `OSA_MCP_APPROVE_UP_TO` in the MCP server's
  environment). Only a person can set it; no MCP tool argument can create or widen it. Every other
  guard stays: the total is re-read before the click, no subscriptions, your budget, never a second
  click. Orders bought this way are recorded with `approval_source: "mandate"`.
- **Order states.** A checkout moves through `proposed`, `awaiting_approval`, `placing`, then
  `placed`, `failed` or `unknown`. `unknown` means Place order may have gone through but no order
  number was read back: the agent never clicks again and asks you to check the store.
- **`osa orders` and `osa orders refresh`**: orders from the run history, and each order's status,
  carrier and tracking read from the store's order page. The web app has an Orders view.
- **`--json` and exit codes.** One JSON reply `{ok, v, data, next}` or `{ok, v, error}` with fixed
  error codes, and exit codes 0 to 4. MCP results carry the same fields.
- **`--dry-run`**: compare and show what each cart would get; no cart is changed (MCP: `fill_carts`
  with `dry_run: true`).
- **Same item across stores.** Offers are labelled Exact match (same GTIN, or same brand and part
  number) or Similar, relative to the item you chose.
- **Price per unit.** "$0.42 / count" from the pack size in the title or from the store, as a sort
  in the web app and a tie-breaker in the ranking.
- **Shop catalog (opt-in, off by default).** `OSA_SHOP_CATALOG=1` finds Shopify stores through
  Shopify's public catalog API; results open on each store's own site.
- **Plugins and a skill** for Claude Code, Cursor, Codex and Gemini CLI. Orders stay off in every
  plugin.
- **MCP registry.** The package carries `mcpName` `io.browsa/open-shopping-agent` and a
  `server.json`; a new MCP tool `list_orders`.

### Changed

- The README says plainly that ordering features are not yet tried on a real purchase.

### Notes

- A version 0.1.2 was prepared for the MCP registry but never published; its changes are in 0.2.0.

## [0.1.1] - 2026-11-19

### Fixed

- **A price in another currency is never read as dollars.** A store that showed a visitor its
  prices in a local currency had them read as US dollars, so a pick could show a huge dollar
  price. Amazon, eBay and Shopify stores are now asked for US dollars. Offers still shown in another
  currency are listed with their currency and are never ranked, picked, counted in a total or
  compared with a watch's target; the run says so once per store.
- **Watches keep their Shopify store.** `osa --watch "..." --stores satechi.com` saved the watch
  without the store's domain, so the check had no store to open.

## [0.1.0] - 2026-11-19

The first release on npm. The source was made public on 18 Nov 2026.

### Added

- **Stores:** Amazon, Walmart, eBay, Best Buy and Target in the US, and any Shopify store named by
  its domain (through its public JSON, no store-specific code).
- **One request, many stores.** A request in plain words is parsed (rules, or your own model key),
  searched on every allowed store at once, and ranked by delivered total, rating weighted by review
  count, delivery date and how well the title matches, with a one-line reason per pick.
- **Carts and checkout.** Fills each store's cart, reads it back from the store, goes to checkout
  and stops on the order review page. `--every-store` fills a cart with every item at each store.
- **Approval gate.** An order is placed only with your approval of the exact total, and only if the
  store still asks that total right before the click. No subscriptions, memberships or trials.
  Card numbers and store passwords are never typed; sign-ins, codes and card checks are handed to
  you.
- **Three kinds of browser:** your own Chrome or Edge (no signup), any browser that speaks the
  DevTools protocol, or Phantom cloud browsers on Browsa, where captchas and press-and-hold checks
  are solved in the session and a store can get a US home-internet exit.
- **Three ways to run it:** the `osa` command line, a local web app, and an MCP server
  (`find_and_compare`, `fill_carts`, `review_checkout`, `place_order`, `watch_price`, `list_runs`).
- **Price and stock watches** with alerts to the terminal, Slack, a webhook or email, and a
  workflow to run them on a schedule.
- **Your own keys:** proxies per store or as a pool, and your own model for parsing and the AI
  fallback.
- **Limits:** a budget per run, a cap on Browsa credits per run, and a credit meter that counts
  only the run's own browsers and tasks.
- **A bench** of fixed tasks per store that never places an order, and the release check in
  `docs/RELEASE-CHECK.md`.

### Security

- Placing orders over MCP is off unless you set `OSA_MCP_ALLOW_ORDERS=1`.
- The web app listens on 127.0.0.1 and refuses requests with a non-local `Host` when no access
  token is set (DNS rebinding); on any other address it needs the token it prints.

[0.2.3]: https://github.com/browsa-io/open-shopping-agent/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/browsa-io/open-shopping-agent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/browsa-io/open-shopping-agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/browsa-io/open-shopping-agent/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/browsa-io/open-shopping-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/browsa-io/open-shopping-agent/releases/tag/v0.1.0
