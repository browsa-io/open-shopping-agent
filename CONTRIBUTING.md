# Contributing

Thanks for helping. Store pages change often, so the most useful work is fixing adapters, adding stores and adding bench tasks. Issues labelled [good first issue](https://github.com/browsa-io/open-shopping-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped so you can finish them in a pull request or two.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

```bash
git clone https://github.com/browsa-io/open-shopping-agent
cd open-shopping-agent
npm ci
npm run build
npm test                # the default suite: no network, no browser, no Browsa key (about 25 s)
npm run typecheck
npm run test:browser    # optional: the browser suite, needs Chrome, Edge or Chromium on this computer
```

Node 20 or later. There are two test suites:

- **`npm test`**, the default suite. It needs no network, no browser and no Browsa key, and it never launches Chrome. Stores are saved pages in `test/fixtures/`, browsers are fakes. Pull requests must keep it that way: a test that opens a real browser does not belong here.
- **`npm run test:browser`**, the browser suite (`test/browser/*.browser.test.ts`). It launches the Chrome, Edge or Chromium installed on your computer, headless, against a test page served on 127.0.0.1: no store and no network. It is skipped when no browser is found (set `OSA_CHROME_PATH` to point at one). Every launch and every test has a timeout and the browser is closed, then killed, at the end, so it cannot hang. CI runs it in its own job on a runner with Chrome (`OSA_REQUIRE_CHROME=1` makes a missing Chrome a failure there).

`npm run test:all` runs both. Live tests against real stores are separate again and opt-in (`OSA_LIVE=1`, see Rules). To try a change for real, run it on your own Chrome, compare only:

```bash
npx tsx src/cli/index.ts --browser local --no-cart --stores amazon "aa batteries 24 pack"
```

## Where things are

| Path | What |
|---|---|
| `src/core/` | the engine: parse the request, open browsers, rank offers, limits, approval, run history |
| `src/core/types.ts` | shared types (the contract between engine, stores and front ends) |
| `src/stores/adapter.ts` | the store adapter contract |
| `src/stores/_template.ts` | a commented starting point for a new store |
| `src/stores/<id>.ts` | one file per store |
| `src/stores/util.ts` | helpers every adapter uses (money, HTML, options, bot checks, hand-off) |
| `src/alerts/` | price and stock watches, notifiers |
| `src/web/`, `src/cli/`, `src/mcp/` | web app, command line, MCP server |
| `bench/` | measured results per store (the README store table) |
| `test/` | unit tests, with saved pages in `test/fixtures/<store>/` |
| `test/browser/` | the browser suite (`npm run test:browser`), the only tests that launch a real browser |

## Add a store

A store is one file, `src/stores/<id>.ts`, that implements `StoreAdapter` from [`src/stores/adapter.ts`](src/stores/adapter.ts). The adapter knows one store's pages. The engine decides what to buy, applies the limits and asks for approval; an adapter never decides to pay.

| Method | What it does | Required |
|---|---|---|
| `searchUrl(query, domain)` | the store's search URL for a query | yes |
| `search(ctx, item, limit)` | up to `limit` offers from the search page, with `sponsored` and `subscription` flagged | yes |
| `details(ctx, offer)` | open the product page; fill shipping, delivery, seller, variants | no, but the bench measures it |
| `addToCart(ctx, offer, quantity, options)` | choose options and one-time purchase, add, then read the cart back | yes |
| `readCart(ctx)` | the cart as the store shows it now | yes |
| `clearCart(ctx)` | remove what the run added | no, but tests and the bench use it |
| `reviewCheckout(ctx)` | go to checkout and stop on the review page, before "Place order"; return `needsUser` for sign-in, codes, address or payment | yes |
| `placeOrder(ctx, approval)` | click "Place order" only if the total still equals `approval.approvedTotal` | yes |

Steps:

1. **Copy the template.** `cp src/stores/_template.ts src/stores/<id>.ts`. Its header lists the order to read a store in: the store's own JSON, then JSON in the page, then stable selectors, then the AI fallback (`ctx.aiTask`, at most once per stage).
2. **Register the id.** Add it to `StoreId` in `src/core/types.ts`, and to `STORE_IDS`, `STORE_NAMES` and `LOADERS` in `src/stores/index.ts`. Then run `npm run typecheck`: it lists every other per-store map (CLI, proxies, web app) that needs the new id.
3. **Write parsers as pure functions.** Keep the parsing out of the browser code, like `parseSearch`, `parseCart` and `parseCheckout` in `src/stores/ebay.ts`, so tests can run them on saved pages. Prices are `{ cents, currency }`; use `parseMoney(text, currency)` from `util.ts`.
4. **Save fixtures** in `test/fixtures/<id>/`: a search page, a product page, a cart page and the first checkout page (guest or sign-in). Trim scripts, styles and blocks you do not read. Remove personal data: names, addresses, emails, order numbers, card hints.
5. **Write tests** in `test/stores/<id>.test.ts`, on the fixtures: search returns offers with title, URL, price in cents, rating, stock and sponsored flags; details fill shipping or delivery; the cart parser reads lines, quantities and the subtotal; the checkout parser finds the total or returns `needsUser`. `test/stores/ebay.test.ts` is a good model.
6. **Add bench tasks** to `bench/tasks.json` and check them with `npm run bench -- --dry-run`. If you have a Browsa key, run 3 for real: `BROWSA_API_KEY=... npm run bench -- --stores <id> --tasks 3 --max-credits 10 --no-readme`.

The full walkthrough, with every helper in `util.ts`, is [docs/ADD_A_STORE.md](docs/ADD_A_STORE.md).

**Stores outside the US.** Use the store's own currency in every `Money` (`"GBP"`, `"EUR"`, `"INR"`, `"BRL"`), never `"USD"` by default. The engine ranks in one currency per run and leaves out offers in another (`currency` in `src/core/rank.ts`, default USD), so a store in another currency may also need a small change there; say so in your pull request and we will help. Use the store's own postcode field in place of a ZIP.

Before you add a store, read its terms. If a store forbids automated access, or only allows it through an official API, say so in your pull request.

## Fixing a broken store

1. Reproduce it on your own Chrome (`--browser local --no-cart --stores <id>`), or run the bench for that store if you have a Browsa key.
2. Save the page that broke as a fixture in `test/fixtures/<store>/`, trimmed.
3. Write a failing test against the fixture, then fix the parser or selectors.
4. Run `npm test` and `npm run typecheck`.

## Rules

- TypeScript, ESM, Node 20+. `npm run build`, `npm test` and `npm run typecheck` must pass.
- Keep changes small and focused. One store per pull request is easiest to review.
- No new runtime dependency without a reason in the pull request.
- Tests use saved fixtures. A test that launches a browser goes in `test/browser/` and is named `*.browser.test.ts`. Live tests are opt-in with `OSA_LIVE=1` and stop at the cart or the first checkout page.
- Fixtures must not say where they were saved from: no local currency, postcode, language or "ships to" country of the person who saved them. Use a US session, or rewrite the values to made-up ones and say so in a comment at the top.
- **Never place a real order, never enter card details, and never commit a store account password** in tests, fixtures or examples.
- Do not add code that solves captchas or gets around a store's access limits. Call `passBotCheck` or `browsaSolves` from `util.ts` and hand the rest to the person.
- Call the browser **Phantom** in docs and UI text.
- Writing: short plain sentences. Do not claim numbers that the bench or a test did not measure.

## Pull request checklist

- [ ] `npm test` and `npm run typecheck` pass.
- [ ] New or changed parsing has a test on a saved fixture.
- [ ] Fixtures are trimmed and have no personal data.
- [ ] Nothing in the change can place an order outside `placeOrder`, type card details or sign in.
- [ ] For a new store: bench tasks added, `npm run bench -- --dry-run` passes, and the store's terms are mentioned.
- [ ] Docs updated if behaviour or options changed, and a line added under "Unreleased" in `CHANGELOG.md`.

## Reporting a security problem

Do not open a public issue. See [SECURITY.md](SECURITY.md) or email support@browsa.io.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
