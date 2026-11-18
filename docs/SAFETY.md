# Safety

What the agent will and will not do with your money and your data.

## The approval gate

- The agent never places an order on its own. It goes to checkout and stops on the order review page.
- You see each store's review: items, options, subtotal, shipping, tax, total, a short delivery place ("Cheyenne, WY 82001") and the card hint the store shows ("Visa ending 1234").
- An approval is for one store and one exact total. Before it clicks "Place order", the adapter reads the total again. If the store now asks for more, it stops and asks you again.
- You can always place the order yourself in Phantom Live instead.
- Price watches only alert you. They never add to a cart or buy.

## Limits

| Limit | Default | Can you change it? |
|---|---|---|
| Approval before every order | always | no |
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

You do that step in the live browser. The agent does not type store passwords and does not solve captchas.

## What is stored where

| Data | Where | Notes |
|---|---|---|
| Browsa API key | your environment (`BROWSA_API_KEY`) | never written to `.osa/` |
| Alert settings (Slack URL, SMTP password, webhook secret) | your environment | never written to `.osa/` |
| Watches | `.osa/watches.json` | queries, product URLs, target prices, alert channels, email address if you gave one |
| Watch history | `.osa/watches/<id>.jsonl` | time, best offer, price, store, stock, which alerts were sent |
| Run history | `.osa/runs/` | your request, offers, picks, carts and reviews, as the stores showed them |
| Store sign-ins, carts, cookies | the store's Phantom browser profile on Browsa | so carts and sign-ins survive between runs; you can delete the profile |
| Card numbers | the store only | the agent never reads, stores or sends full card numbers |

`.osa/` is in `.gitignore`. If you run watches from GitHub Actions, the watch workflow commits `.osa/watches/` to your repository, so use a private fork if your watch list is private.

When the AI fallback runs a step, the page it works on is sent to the model (Browsa's hosted model by default, or your own model key). Text from store pages is treated as data, never as instructions.

## Store terms

Each store has its own terms of use, and some limit automated access, require agents to identify themselves, or only allow agents through their own programs.

**You are responsible for following the terms of each store you use with this software.** Check them before you use a store, keep watch intervals long, and stop if a store asks you to. The software is provided under the MIT License, without warranty.

## Reporting a problem

If the agent did something it should not have, or you found a security problem, email support@browsa.io. Please do not open a public issue for security problems.
