# Open Shopping Agent

An open-source shopping agent. One request searches Amazon, Walmart, eBay, Best Buy, Target and Shopify stores, compares the offers and fills the carts. It buys only after you approve the total.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![CI](https://github.com/browsa-io/open-shopping-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/browsa-io/open-shopping-agent/actions/workflows/ci.yml)
<!-- Add back after publishing: the npm badge once open-shopping-agent is on npm, and the bench badge once bench.yml has run in this repo. -->

![The finished comparison from a real run: six stores with their own icons, 16 offers each, the best pick for the hub at eBay, and the total of both picks with a Fill cart button](docs/screens/result.png)

A real run on 18 Nov 2026: one request, 6 stores on Phantom browsers, 96 offers compared, both best picks at eBay for $6.88. Nothing was bought.

## Quick start

```bash
export BROWSA_API_KEY=your_key   # optional: without a key the stores open in your own Chrome
npx open-shopping-agent web      # the web app on http://localhost:4319
```

Or from the terminal: `npx open-shopping-agent 'a usb-c hub with hdmi under $40'`. Node 20 or later. A free Browsa key comes with 100 credits: [browsa.io](https://browsa.io).

![The same run from start to finish: the request, six stores searched, the comparison, Fill cart at eBay, the cart read back, and checkout stopped at eBay's guest checkout (waiting parts are sped up and labelled)](docs/demo.gif)

The same run from start to finish, in its real order. Waiting parts are sped up and labelled in the frame: the search took 4 min 3 s with at most 2 browsers at a time (`OSA_MAX_BROWSERS=2`), filling the cart 2 min, checkout 50 s. eBay's guest checkout asks for an email and address before its order review, so the run stopped there and no Buy button appeared. 7 min 10 s and 11 Browsa credits in all. Screens: [request](docs/screens/home.png), [compare](docs/screens/compare.png), [cart read back](docs/screens/carts.png), [checkout stop](docs/screens/checkout-stop.png), [phone](docs/screens/phone.png), [history](docs/screens/history.png).

## Works with any browser, best on Browsa

Measured 18 Nov 2026, one run per browser from a home connection outside the US: "usb-c hub with hdmi and a 6 ft hdmi cable under $60", ZIP 10001, a cart at every store, stopped before buying ([numbers and timings](docs/RELEASE-CHECK.md)).

| Store | Phantom on Browsa | Your Chrome | Your Chrome, headless | Any CDP browser (a local Chrome) |
|---|---|---|---|---|
| Amazon | cart filled, checkout handed off (it said an item was out of stock) | cart filled, stopped at sign-in | blocked at the cart (bot check) | not run |
| Walmart | cart filled, stopped at sign-in | blocked at the cart (bot check) | blocked at search (bot check) | blocked at the cart (bot check) |
| eBay | cart filled, stopped at guest checkout | blocked at search (403) | blocked at search (403) | not run |
| Best Buy | cart 1 of 2 items, stopped at sign-in or guest | cart filled, stayed on the cart (no shipping to the ZIP Best Buy guessed) | blocked at the cart (product pages refused) | not run |
| Target | cart filled, stopped at the $35 minimum and sign-in | no pick (every offer shown out of stock) | cart 1 of 2 items, checkout did not open | not run |
| satechi.com (Shopify) | cart filled, stopped at guest checkout | cart filled, stopped at guest checkout | cart filled, stopped at guest checkout | cart filled, stopped at guest checkout |

Search, compare, carts, the approval gate, watches, the web app, CLI and MCP work on every browser. Full capabilities need Browsa: bot checks passed with Phantom, captchas solved in-session, a US home-internet exit per store and take-over from any device. A US home connection may get further on your Chrome; that was not measured. [Pick a browser](#pick-a-browser).

## What it does

- **Asks once, searches everywhere.** Type what you want in plain words. It searches every store you allow at the same time.
- **Compares the real total.** Price, shipping, delivery date, rating and seller, side by side, with a one-line reason for each pick.
- **Fills the carts.** It picks the right size or colour, chooses one-time purchase, and reads the cart back from the store to check it.
- **Stops before paying.** It goes to checkout and stops on the review page. Nothing is bought until you approve that exact total.
- **Hands you the browser when needed.** Sign-in, a code by text message or a card check opens in Phantom Live, so you do that step yourself.
- **Watches prices.** Set a target price or a back-in-stock alert and get an email, a Slack message or a webhook.

## More ways to run it

### Command line

```bash
export BROWSA_API_KEY=your_key
npx open-shopping-agent "a USB-C hub with HDMI under \$40 and a pack of AA batteries"
```

By default each item goes to the store with the best pick. `--every-store` fills a cart with every item at each store instead, so you can compare the real delivered totals the stores show. `OSA_MAX_BROWSERS=2` keeps at most two Phantom browsers open at once (stores take turns).

### Web app (Docker)

```bash
git clone https://github.com/browsa-io/open-shopping-agent
cd open-shopping-agent
docker build -t open-shopping-agent .
docker run --rm -p 8080:8080 -v osa-data:/data -e BROWSA_API_KEY=your_key open-shopping-agent
```

Then open the link it prints (http://localhost:8080/?token=...). The container listens on all addresses, so the web app asks for that token; set your own with `-e OSA_WEB_TOKEN=...`. Run history and settings stay in the `osa-data` volume.

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

Over MCP the agent searches, compares, fills carts and reviews checkout. It does not place orders unless you add `"OSA_MCP_ALLOW_ORDERS": "1"` to the server's `env`; even then each order needs the exact total you approved in the chat. Without it, finish the order in the web app or the CLI.

## Pick a browser

Open Shopping Agent runs on three kinds of browser. Pick one with `--browser`, `OSA_BROWSER` or Settings in the web app. Without a choice it uses Browsa when a Browsa key is set, else your own Chrome, so it works with no signup.

**1. Phantom on Browsa** (cloud browsers, Browsa key)

```bash
export BROWSA_API_KEY=your_key
npx open-shopping-agent "6 ft usb-c cable under \$15"
```

**2. Your own Chrome, no signup** (Chrome or Edge installed on this computer)

```bash
npx open-shopping-agent --browser local "6 ft usb-c cable under \$15"
```

A window opens so you can take over (sign-in, a code, a bot check). Add `--headless` (or `OSA_HEADLESS=1`) to hide it, and `OSA_CHROME_PATH` to pick a browser binary. Logins and carts stay in `.osa/browsers/<store>` on this computer.

**3. Any browser that speaks the DevTools protocol** (your remote Chrome, another cloud provider)

```bash
export OSA_CDP_URL=ws://my-host:9222/devtools/browser/...   # or http://my-host:9222
export OSA_CDP_HEADERS='{"X-API-Key":"..."}'                # optional
npx open-shopping-agent --browser cdp "6 ft usb-c cable under \$15"
```

| | Your Chrome | Any CDP browser | Phantom on Browsa |
|---|---|---|---|
| Request parsing, search, compare, carts | yes | yes | yes |
| Approval gate (never buys without your OK) | yes | yes | yes |
| Watches, web app, CLI, MCP | yes | yes | yes |
| Bot checks passed with Phantom | no, you solve them in the window | no | yes |
| Captchas solved in-session | no | no | yes |
| US home-internet exit per store | your own proxy only | your provider's proxy | yes |
| Take over from any device (Phantom Live) | no, the window on this computer | no | yes |
| AI fallback | with your own model key | with your own model key | yes (hosted model or your key) |
| Saved profiles in the cloud | no, a folder on this computer | no | yes |
| Measured store results | not measured | not measured | yes, [the bench](bench/) |

On Browsa, when a store shows a captcha or a press-and-hold check, the agent asks Browsa to solve it in the same browser session (the `Browsa.solveCaptcha` command on the browser's CDP socket). The run notes say which check it was and how long Browsa took. If Browsa cannot solve it, you get a Phantom Live link to finish it yourself. Captchas solved in-session need Browsa.

A blocked store ends with one line, for example "Walmart blocked this browser. Browsa's Phantom passes it: browsa.io". On your Chrome or a CDP browser, a store that shows a bot check stops with "This store showed a bot check. Solve it in the browser window, or run with Browsa to pass it automatically." Amazon, Target and Best Buy often block non-US or datacenter browsers; the agent warns once per run. Success rates in the bench table are measured on Browsa only.

## Bring your own keys

**Proxies.** Free on every browser. Browsa takes them as its own-proxy option (they replace the built-in exit), your Chrome gets them as its launch proxy, and a CDP browser uses the proxy set at your provider.

| Setting | What it does |
|---|---|
| `OSA_PROXY=http://user:pass@host:port` | one proxy for every store (`http`, `https` or `socks5`; `host:port` and `host:port:user:pass` work too) |
| `OSA_PROXY_AMAZON=socks5://host:1080` | one store's proxy (also `WALMART`, `EBAY`, `BESTBUY`, `TARGET`, `SHOPIFY`); wins over `OSA_PROXY` |
| `OSA_PROXIES=host1:8000,host2:8000` or `@proxies.txt` | a small pool, rotated per store and run; one that fails a quick check is skipped |

The exit order per store stays: your proxy, else Browsa's residential US exit for Amazon, Target and Best Buy, else the default exit with a warning. Logs and the UI show only `host:port`. Settings has a Test proxy button that shows the exit IP and country.

**Models.** Your own key for everything that uses a model: reading your request and the AI fallback.

```bash
export OSA_LLM=anthropic:claude-sonnet-5-5     # or openai:<model>, openrouter:<model>, google:<model>
export OSA_LLM_API_KEY=your_model_key
export OSA_LLM_BASE_URL=https://.../v1         # optional, any OpenAI-compatible API
```

On Browsa the AI fallback runs as a Browsa task with your key (no markup), or with a saved Browsa key (`OSA_AI_LLM_KEY_ID`); without a key it uses Browsa's hosted model. On your Chrome or a CDP browser the fallback is a small loop on the store's own page: it reads the page, asks your model for one action, does it, and stops after 8 steps. It never clicks a final order or pay button, never signs in and never types card details. Without any model key, requests are read by a rule parser and the AI fallback is off on non-Browsa browsers (the run says so once).

Keys stay on your machine: the environment, or `.osa/config.json` (mode 0600) when saved in Settings. The web app only ever gets masked values. Settings has a Test key button.

## Supported stores

What [the bench](bench/) did on each store: fixed shopping tasks on Phantom, 3 per store in the last run. "Reaches checkout" means it got to the sign-in, guest or order review page; nothing is ever bought. Amazon's checkout said an item was out of stock and handed the browser over.

<!-- bench:start -->
| Store | Search | Cart | Reaches checkout |
|---|---|---|---|
| Amazon | ✓ | ✓ | ✗ |
| Walmart | ✓ | ✓ | ✓ |
| eBay | ✓ | ✓ | ✓ |
| Best Buy | ✓ | ✓ | ✓ |
| Target | ✓ | ✓ | ✓ |
| Any Shopify store | ✓ | ✓ | ✓ |

Measured 18 Nov 2026 on Phantom (Browsa) by [the bench](bench/), stopped before buying ([results](bench/results/latest.json), 13 Browsa credits). Your own Chrome: see the browser table above.
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
- **Budget caps.** Set a total budget per run and a cap on Browsa credits per run (default 40, `OSA_MAX_CREDITS`). The cap and the credits a run prints count only that run's own browsers and AI tasks, read from Browsa's credit ledger, so other runs on the same account do not count. A fresh browser counts 1 credit per started 12 minutes it ran, plus residential exit data. If Browsa's figures cannot be read, the run estimates from browser time and says "about".
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
The code is free. Browsers run on Browsa: a free key has 100 credits. What one shopping run costs depends on the stores and on how often the AI fallback is needed. The [bench](bench/) records the credits of each of its runs, so see its latest results there.

**Does it work without Browsa?**
Yes. Run it on your own Chrome (`--browser local`) or any DevTools browser (`--browser cdp`). Browsa adds bot checks passed with Phantom, captchas solved in-session, a US home-internet exit per store and take-over from any device. See [Works with any browser, best on Browsa](#works-with-any-browser-best-on-browsa) and [Pick a browser](#pick-a-browser).

**Which countries?**
The US stores for now (amazon.com, walmart.com, ebay.com, bestbuy.com, target.com), and Shopify stores that ship to you. `--zip 10001` sets the delivery ZIP the way a guest can on each store, with no sign-in. Best Buy and Walmart guess a place from the browser's address; when one of them keeps its own ZIP, the run notes and the cart say which one.

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

---

Not affiliated with Amazon, Walmart, eBay, Best Buy, Target or Shopify. Store names and icons belong to their owners; icons are loaded from each store's own site at run time. You are responsible for following each store's terms.
