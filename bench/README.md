# Bench

Fixed shopping tasks, run on every store adapter, so the store table in the README is measured and not claimed. The table gives the date of the run it comes from.

## Stages

| Stage | Passes when |
|---|---|
| search | the search returns at least `minOffers` offers, `minPriced` with a price, `minRated` with a rating, and `minRelevant` whose title has one of `titleAny` |
| details | the product page of the first in-stock new offer gives a price (and shipping or delivery when `requireDelivery` is set) |
| cart | that offer is in the cart after adding it, and still there when the cart is read back |
| checkout | checkout reaches the sign-in or guest page, or the order review page |

**The bench never places an order.** `placeOrder` is blocked in the runner, and the checkout stage stops at the first page that asks who you are. Each store gets one Phantom browser, which is destroyed at the end. Carts are cleared after each task.

## Run it

```bash
npm run bench -- --dry-run                       # check tasks.json, list installed adapters, no browser
BROWSA_API_KEY=... npm run bench                 # all stores, writes results and the README table
BROWSA_API_KEY=... npm run bench -- --stores amazon,ebay --tasks 3 --max-credits 10 --no-readme
```

| Option | Meaning |
|---|---|
| `--stores a,b` | only these stores (others keep their last results in the README) |
| `--tasks N` | first N tasks per store |
| `--stages search,details` | only these stages |
| `--max-credits N` | stop starting new tasks once N credits are used, and refuse a browser or AI task that would pass N (default 60). Counts only the bench's own browsers and tasks (the credit ledger), never the account balance |
| `--no-ai` | turn off the AI fallback, to measure direct code alone |
| `--no-readme` | do not touch README.md |
| `--file path` | another task file |

A store whose adapter is missing is recorded as "not installed".

## Files

- `tasks.json`: the tasks, about 10 per store.
- `results/<date>.json`: one file per run, with every stage's pass or fail, time in ms and the reason for a failure, plus the credits the run's own browsers and tasks used, per store and in total.
- `results/latest.json`: the latest result per store, used for the README table.

[.github/workflows/bench.yml](../.github/workflows/bench.yml) runs it on a daily schedule once the repository has a `BROWSA_API_KEY` secret (without one it only checks the tasks) and commits the results and the README table.
