## What this changes

<!-- One or two sentences. Link the issue: "Closes #12". -->

## How I checked it

<!-- Tests added, and for store changes the command you ran, for example:
osa --browser local --no-cart --stores walmart "aa batteries 24 pack" -->

## Checklist

- [ ] `npm test` and `npm run typecheck` pass.
- [ ] New or changed parsing has a test on a saved fixture.
- [ ] Fixtures are trimmed and have no personal data.
- [ ] Nothing in the change can place an order outside `placeOrder`, type card details or sign in.
- [ ] For a new store: bench tasks added, `npm run bench -- --dry-run` passes, and the store's terms are mentioned below.
- [ ] Docs updated if behaviour or options changed.
