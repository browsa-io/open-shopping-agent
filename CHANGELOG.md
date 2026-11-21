# Changelog

What changed in each published version of Open Shopping Agent. Dates are the day the version went
to npm (UTC). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/).

No order has gone through Open Shopping Agent end to end yet. Placing orders, Buy without asking and
order tracking are tested against fakes and saved store pages, not a live checkout.

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

[0.2.1]: https://github.com/browsa-io/open-shopping-agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/browsa-io/open-shopping-agent/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/browsa-io/open-shopping-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/browsa-io/open-shopping-agent/releases/tag/v0.1.0
