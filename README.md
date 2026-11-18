# Open Shopping Agent

An open-source AI shopping agent. It searches Amazon, Walmart, eBay, Best Buy, Target and any Shopify store at once, compares the offers, fills the carts and checks out only after you approve.

[![npm](https://img.shields.io/npm/v/open-shopping-agent.svg)](https://www.npmjs.com/package/open-shopping-agent)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![bench](https://github.com/browsa-io/open-shopping-agent/actions/workflows/bench.yml/badge.svg)](https://github.com/browsa-io/open-shopping-agent/actions/workflows/bench.yml)
[![CI](https://github.com/browsa-io/open-shopping-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/browsa-io/open-shopping-agent/actions/workflows/ci.yml)

![A real run in the web app: Walmart and satechi.com searched, the Walmart cart filled and read back, checkout stopped at Walmart's sign-in (sped up 8x)](docs/demo.gif)

One real run of `osa web` on Phantom browsers, recorded on 2026-11-18 (the middle part is sped up 8x). Screens from the same run: [request](docs/screens/real-home.png), [stores working](docs/screens/real-stores.png), [compare](docs/screens/real-compare.png), [cart read back](docs/screens/real-carts.png), [checkout stop](docs/screens/real-checkout.png). As a guest no store showed its order review in these runs (Walmart asked for a sign-in, eBay for an address, Target for a $35 minimum), so the run hands the browser over there and the Buy button never appears.

## What it does

- **Asks once, searches everywhere.** Type what you want in plain words. It searches every store you allow at the same time.
- **Compares the real total.** Price, shipping, delivery date, rating and seller, side by side, with a one-line reason for each pick.
- **Fills the carts.** It picks the right size or colour, chooses one-time purchase, and reads the cart back from the store to check it.
- **Stops before paying.** It goes to checkout and stops on the review page. Nothing is bought until you approve that exact total.
- **Hands you the browser when needed.** Sign-in, a code by text message or a card check opens in Phantom Live, so you do that step yourself.
- **Watches prices.** Set a target price or a back-in-stock alert and get an email, a Slack message or a webhook.

## Quick start

You need Node 20 or later and a Browsa API key. A free key comes with 100 credits: [browsa.io](https://browsa.io).

### Command line

```bash
export BROWSA_API_KEY=your_key
npx open-shopping-agent "a USB-C hub with HDMI under \$40 and a pack of AA batteries"
```

### Web app (Docker)

```bash
git clone https://github.com/browsa-io/open-shopping-agent
cd open-shopping-agent
docker build -t open-shopping-agent .
docker run --rm -p 3000:3000 -e BROWSA_API_KEY=your_key open-shopping-agent
```

Then open http://localhost:3000.

### MCP (Claude Desktop, Cursor, Claude Code)

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "open-shopping-agent": {
      "command": "npx",
      "args": ["-y", "open-shopping-agent", "mcp"],
      "env": { "BROWSA_API_KEY": "your_key" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add open-shopping-agent -e BROWSA_API_KEY=your_key -- npx -y open-shopping-agent mcp
```

## Supported stores

Success rates come from the [bench](bench/): fixed shopping tasks run on every store, every day. The checkout column counts runs that reached the sign-in, guest or order review page. The bench never places an order.

<!-- bench:start -->
| Store | Search | Product page | Cart | Checkout reached | Last run |
|---|---|---|---|---|---|
| Amazon | pending first run | pending first run | pending first run | pending first run | pending first run |
| Walmart | pending first run | pending first run | pending first run | pending first run | pending first run |
| eBay | pending first run | pending first run | pending first run | pending first run | pending first run |
| Best Buy | pending first run | pending first run | pending first run | pending first run | pending first run |
| Target | pending first run | pending first run | pending first run | pending first run | pending first run |
| Any Shopify store | pending first run | pending first run | pending first run | pending first run | pending first run |

Measured daily by [the bench](bench/). No results yet.
<!-- bench:end -->

## How it works

1. **One Phantom browser per store.** Each store gets its own cloud browser profile on [Browsa](https://browsa.io). Carts and sign-ins stay in that profile between runs.
2. **Direct code first, AI as a fallback.** Each store has an adapter that reads search results, product pages and carts with plain page code. That is fast and cheap. If a page changed and the code fails, an AI agent finishes that one step. With saved store profiles it works in the same profile (same cart). With a fresh browser per run (the default) it runs in its own browser with a separate cart, so it can read pages there but cannot fill your cart; those steps then fail without spending credits.
3. **Shopify through its public JSON.** Any Shopify store works without store-specific code.
4. **The engine decides, the adapter only reads and clicks.** The engine ranks offers, applies your budget and limits, and asks for approval.
5. **Approval gate.** The agent stops on the order review page and shows you the total. It places the order only with your approval, and only if the store still asks the same total. You can also click the final button yourself.
6. **Phantom Live hand-off.** When a store wants a sign-in, a one-time code, a card check or a puzzle, you get a single-use link to that browser and do the step yourself.

### Exit address per store

Amazon, Target and Best Buy block Browsa's default exit, which is not in the US (measured 2026-11-18: Amazon shows "I am human", Target answers 429, Best Buy resets the connection). The agent picks the exit per store:

1. **Your own proxy**, when you set one (`OSA_PROXY=http://user:pass@host:port`, or Settings in the web app). Every store uses it. Your own proxies are free on Browsa.
2. Else Amazon, Target and Best Buy get **Browsa's residential US exit** when your account's proxy network lists it (billed per GB from credits). If Browsa refuses it, the store falls back to the default exit with a warning.
3. Else the default exit, with a warning naming the stores that may block.

Walmart, eBay and Shopify stores work on the default exit. The exit shows on each store card and in the CLI. `OSA_US_EXIT=0` turns step 2 off.

## Price and stock watches

```bash
npx open-shopping-agent watch add "27 inch 4K monitor" --store walmart,bestbuy --target 250 --notify slack
npx open-shopping-agent watch add --url https://www.target.com/p/... --back-in-stock --notify email --to you@example.com
npx open-shopping-agent watch run           # keep checking
npx open-shopping-agent watch run --once    # one pass, for cron
```

Watches live in `.osa/watches.json` and each check is a line in `.osa/watches/<id>.jsonl`. A watch checks at most every 6 hours (12 hours by default), so stores are not polled hard. You get an alert when the best in-stock price reaches your target, when it drops again, or when the item is back in stock.

Alerts go to:

| Channel | Settings |
|---|---|
| Desktop | prints to the terminal |
| Slack | `OSA_SLACK_WEBHOOK_URL` (an incoming webhook) |
| Webhook | `OSA_WEBHOOK_URL`, optional `OSA_WEBHOOK_SECRET` (signs the body with HMAC-SHA256 in `X-OSA-Signature`) |
| Email | SMTP: `OSA_SMTP_HOST`, `OSA_SMTP_PORT`, `OSA_SMTP_USER`, `OSA_SMTP_PASS`, `OSA_SMTP_FROM`. Or `RESEND_API_KEY` or `SENDGRID_API_KEY` with `OSA_EMAIL_FROM` |

Test a channel with `watch test slack`.

**Run watches on a schedule without your own server:**

- **GitHub Actions.** Fork this repo, add `BROWSA_API_KEY` and your alert settings as repository secrets, set the repository variable `OSA_WATCHES` to `on`, and commit your `.osa/watches.json`. The [watch workflow](.github/workflows/watch.yml) runs `watch run --once` every 6 hours and commits the history back. Actions minutes are free on public repositories.
- **Browsa schedules.** A Browsa schedule runs an agent task on an interval (1 hour to 30 days) and posts the result to a webhook. Use it when you want a plain-language check with no machine of yours involved.

Each check uses Browsa credits for browser time. The scheduler itself costs nothing.

## Safety

- **Never buys without your approval.** The approval is tied to the exact total you saw. If the store asks for more, the order is not placed.
- **No subscriptions or memberships.** It picks one-time purchase and declines Prime, Walmart+ and free trials.
- **Budget caps.** Set a total budget per run and a cap on Browsa credits per run (default 40).
- **Your keys stay local.** Your Browsa key and alert settings stay in your environment. Store passwords are never typed by the agent: you sign in yourself in Phantom Live.
- **You are responsible for following each store's terms.** Some stores limit automated access. Read [docs/SAFETY.md](docs/SAFETY.md).

## Compared with other tools

| | Searches many stores | Fills carts | Checks out with your approval | Open source |
|---|---|---|---|---|
| Open Shopping Agent | yes | yes | yes | yes, MIT |
| Price trackers (changedetection.io, PriceGhost, PriceBuddy) | they watch pages you give them | no | no | yes |
| General browser agents (browser-use, Stagehand, Skyvern) | if you write the task | if you write the task | no shopping logic built in | yes |
| Assistants inside one company's app | mostly their own store or partners | yes | yes | no |

Price trackers watch but never buy. General browser agents can do anything, but you write the shopping logic, the checks and the limits. Closed assistants are tied to one app and its partners.

## Add a store in one file

A store is one file in `src/stores/`, built from `src/stores/_template.ts`, plus saved page fixtures, tests and bench tasks. See [docs/ADD_A_STORE.md](docs/ADD_A_STORE.md).

## FAQ

**What does it cost?**
The code is free. Browsers run on Browsa: a free key has 100 credits. What one shopping run costs depends on the stores and on how often the AI fallback is needed. The [bench](bench/) records the credits of every daily run, so see the latest results there.

**Does it work without Browsa?**
Not in v1. Each store runs in a Phantom cloud browser so carts and sign-ins persist and you can take over from your phone.

**Which countries?**
The US stores for now (amazon.com, walmart.com, ebay.com, bestbuy.com, target.com), and Shopify stores that ship to you.

**Will it buy something by mistake?**
It cannot place an order without an approval for the exact total. The bench and the tests never place orders.

**Can I use my own AI model key?**
Yes. By default the AI fallback uses Browsa's hosted model. You can pass your own model key instead.

**Where is my data?**
Run history and watches are files in `.osa/` on your machine. See [docs/SAFETY.md](docs/SAFETY.md).

## Contributing

Store adapters break when stores change their pages, so fixes and new stores are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Copyright (c) 2026 Browsa Technologies LLC.
