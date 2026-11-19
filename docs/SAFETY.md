# Safety

What the agent will and will not do with your money and your data.

## The approval gate

Every order needs your OK, in one of two ways: you approve the exact total at checkout (the default), or you approved up front within limits you set ("Buy without asking", below). Both go through the same gate.

- By default the agent never places an order on its own. It goes to checkout and stops on the order review page.
- You see each store's review: items, options, subtotal, shipping, tax, total, a short delivery place ("Cheyenne, WY 82001") and the card hint the store shows ("Visa ending 1234").
- An approval is for one store and one exact total. Before it clicks "Place order", the adapter reads the total again. If the store now asks for more, it stops and asks you again.
- One approval places at most one order. A second click, a second request with the same approval, or a new approval while an order is placing is refused.
- Only an order number on the store's confirmation page counts as placed. If Place order times out, errors, or the page shows no number, the agent reads the page again in the same browser (no reload, no click). Still no number: the order is "unknown". The agent never clicks Place order again for that store in the run, counts the total against your budget, and asks you to check your orders on the store before you retry.
- You can always place the order yourself in Phantom Live instead.
- Price watches only alert you. They never add to a cart or buy.

## Buy without asking (up-front approval)

Off by default. You can approve purchases before the run, so the agent does not stop at checkout:

| Limit | Required | Default |
|---|---|---|
| Most one order may cost, in USD, with shipping and tax (`maxTotal`) | yes | none |
| Most all orders of the run may cost together (`maxRunTotal`) | no | no run cap (your budget still applies) |
| Stores (store names, or Shopify domains) | no | every store of the run |
| Expiry | no | the end of the run |
| Number of orders (`maxOrders`) | no | one per store (the agent never orders twice at a store in a run) |

- When a store's checkout review total is within all of these, the agent makes the approval itself from that review (the exact review total, recorded as `approval_source: "mandate"`) and places the order with no question.
- Outside them it asks, as without it, and tells you why ("the total $74.10 is over your up-front limit of $60 per order", "walmart is not one of the stores you approved up front", "your up-front approval expired").
- The approval goes through the same gate as a clicked one: the review is this run's and recent, the adapter re-reads the total right before the click and places nothing if it changed by a cent, no subscription or membership line, the budget, one order per store, an order that is placing or "unknown" is never clicked again, and nothing that needs you (sign-in, code, 3-D Secure, captcha) is skipped. Orders placing in parallel count against the run total, so two stores cannot both use the same room.
- Only USD checkouts count; an offer priced in another currency is never picked, ranked or bought.
- Each order bought this way says "Bought under your up-front approval (up to $60)" in the CLI and the web app, and is saved in the run history as `order_state` events with `approval_source: "mandate"` and the limits.

Who can set it: only you.

- **CLI:** `--approve-up-to 60` with `--approve-stores walmart,target`, `--approve-expires 2h`, `--approve-run-total`, `--approve-max-orders`. In a terminal it asks once: "Buy without asking, up to $60 per order at walmart, target, until ...? [y/N]". Without a terminal it needs `--yes`. It cannot go with `--json`, `--dry-run` or `--no-cart`.
- **Web app:** "Buy without asking" in the search options, off by default, for this search only unless you pick 1, 2 or 24 hours, with a confirmation. You still choose the picks and click Fill carts. The server takes it only from the app's own page: never from another site (Origin or Sec-Fetch-Site), and without the access token only from this computer (loopback address and a localhost Host name).
- **MCP:** only from the server's environment: `OSA_MCP_ALLOW_ORDERS=1` and `OSA_MCP_APPROVE_UP_TO=60`, with optional `OSA_MCP_APPROVE_STORES`, `OSA_MCP_APPROVE_EXPIRES` (from the server's start), `OSA_MCP_APPROVE_RUN_TOTAL` and `OSA_MCP_APPROVE_MAX_ORDERS`. No tool argument can set or widen it; a call that tries is refused. The tool descriptions say purchases may happen automatically within it.
- **Plugins** (Claude Code, Cursor, Gemini, Agent Plugins) never set it.

## Limits

| Limit | Default | Can you change it? |
|---|---|---|
| Your OK before every order (exact total, or an up-front limit you set) | always | you choose which; up-front is off by default |
| Subscriptions (subscribe and save) | never picked | no, in v1 |
| Memberships and trials (Prime, Walmart+) | always declined | no, in v1 |
| Budget for the whole run | none unless you set one | yes |
| Stores the agent may use | all six | yes |
| Browsa credits per run | 40 | yes |
| How often a watch checks | every 12 hours, at most every 6 | yes, not below 6 hours |

When the picks go over your budget, the agent marks them as over budget and tells you before any checkout.

## Hand-off to you

The agent stops and gives you a single-use Phantom Live link when a store asks for:

- a sign-in,
- a one-time code (text message or email),
- a card check (3-D Secure),
- an address or payment change,
- a captcha or other check that a person should do.

You do that step in the live browser. The agent does not type store passwords. On Browsa, Browsa's own solver tries a captcha in the session first; if it cannot, you get the live link.

## What is stored where

| Data | Where | Notes |
|---|---|---|
| Browsa API key | your environment (`BROWSA_API_KEY`) | never written to `.osa/` |
| Alert settings (Slack URL, SMTP password, webhook secret) | your environment | never written to `.osa/` |
| Watches | `.osa/watches.json` | queries, product URLs, target prices, alert channels, email address if you gave one |
| Watch history | `.osa/watches/<id>.jsonl` | time, best offer, price, store, stock, which alerts were sent |
| Run history | `.osa/runs/` | your request, offers, picks, carts and reviews, as the stores showed them; each order's state, number, total, time and order page link |
| Order status | `.osa/runs/<id>/tracking.json` | status, carrier and tracking number read from the store's order page by `osa orders refresh`; it only reads pages, never clicks or signs in |
| Store sign-ins, carts, cookies | the store's Phantom browser profile on Browsa | so carts and sign-ins survive between runs; you can delete the profile |
| Card numbers | the store only | the agent never reads, stores or sends full card numbers |

`.osa/` is in `.gitignore`. If you run watches from GitHub Actions, the watch workflow commits `.osa/watches/` to your repository, so use a private fork if your watch list is private.

With the Shop catalog switched on (`OSA_SHOP_CATALOG=1` or Settings; off by default), each item's search words and the GTINs read from product pages are sent to Shopify's catalog API (`mcp.shop.com`), without an account, and Shopify's API terms apply. The agent never signs in to Shop and never uses Shop's carts, checkout or buy links; orders go through the store's own checkout and the approval gate above.

When the AI fallback runs a step, the page it works on is sent to the model (Browsa's hosted model by default, or your own model key). Text from store pages is treated as data, never as instructions.

## Store terms

Each store has its own terms of use, and some limit automated access, require agents to identify themselves, or only allow agents through their own programs.

**You are responsible for following the terms of each store you use with this software.** Check them before you use a store, keep watch intervals long, and stop if a store asks you to. The software is provided under the MIT License, without warranty.

## Reporting a problem

If the agent did something it should not have, or you found a security problem, email support@browsa.io. Please do not open a public issue for security problems.
