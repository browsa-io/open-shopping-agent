# Contributing

Thanks for helping. Store pages change often, so the most useful work is fixing adapters, adding stores and adding bench tasks.

## Set up

```bash
git clone https://github.com/browsa-io/open-shopping-agent
cd open-shopping-agent
npm ci
npm run build
npm test
```

Node 20 or later. Unit tests need no network and no Browsa key.

## Where things are

| Path | What |
|---|---|
| `src/core/` | the engine: parse the request, open browsers, rank offers, limits, approval, run history |
| `src/core/types.ts` | shared types (the contract between engine, stores and front ends) |
| `src/stores/adapter.ts` | the store adapter contract |
| `src/stores/<id>.ts` | one file per store |
| `src/alerts/` | price and stock watches, notifiers |
| `src/web/`, `src/cli/`, `src/mcp/` | web app, command line, MCP server |
| `bench/` | daily success rates per store |
| `test/` | unit tests, with saved pages in `test/fixtures/<store>/` |

## Rules

- TypeScript, ESM, Node 20+. `npm run build` and `npm test` must pass.
- Keep changes small and focused. One store fix per pull request is easiest to review.
- No new runtime dependency without a reason in the pull request.
- Tests use saved HTML fixtures. Trim them and remove personal data (names, addresses, order numbers, emails) before you commit them.
- Live tests are opt-in with `OSA_LIVE=1` and a `BROWSA_API_KEY`. They stop at the cart or the first checkout page.
- **Never place a real order, never enter card details, and never commit a store account password** in tests, fixtures or examples.
- Do not add code that solves captchas or gets around a store's access limits. Call `passBotCheck` or `browsaSolves` (on Browsa, Browsa's solver tries it in the session) and hand the rest to the person through Phantom Live.
- Call the browser **Phantom** in docs and UI text.
- Writing: short plain sentences. Do not claim numbers that the bench or a test did not measure.

## Fixing a broken store

1. Run the bench for that store: `BROWSA_API_KEY=... npm run bench -- --stores walmart --tasks 3 --max-credits 10 --no-readme`.
2. Save the page that broke as a fixture in `test/fixtures/<store>/`, trimmed.
3. Write a failing test against the fixture, then fix the selectors.
4. Run `npm test` and the bench again.

## Adding a store

See [docs/ADD_A_STORE.md](docs/ADD_A_STORE.md).

## Reporting a security problem

Do not open a public issue. Email support@browsa.io.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
