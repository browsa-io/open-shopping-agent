# Security

Open Shopping Agent fills carts and can place orders with your money, so we treat security reports first.

## Reporting a problem

Email **support@browsa.io** with "security" in the subject. Please include what you found, how to reproduce it and what it lets someone do. Do not open a public issue for it.

We answer within 3 working days and tell you when a fix ships.

## What it protects by design

- **No order without you.** Every order needs your OK: your approval of the exact total at checkout, or an up-front approval ("Buy without asking") within limits you set yourself, off by default. The agent re-reads the total on the store before it clicks. One approval places at most one order; an order without a confirmed order number is "unknown" and is never retried. Over MCP, placing orders is off unless you set `OSA_MCP_ALLOW_ORDERS=1`, and the plugins never set it.
- **Your keys stay on your computer.** Settings live in `.osa/config.json`, readable only by your user (mode 600). Keys are never sent anywhere except to the service they belong to.
- **The web app is local.** It listens on 127.0.0.1 and only answers requests addressed to localhost. On any other address it needs the access token printed at start.
- **No card data.** The agent never types card numbers or addresses; it stops at the store's checkout for you.

## Threat model: up-front approval ("Buy without asking")

An up-front approval (a "mandate" in the code, `src/core/mandate.ts`) lets the agent place orders with no question, so who can create it matters more than anything else.

**The rule: only the human grants it, never the model.**

| Way in | How the human grants it | What a model or a web page cannot do |
|---|---|---|
| CLI | `--approve-up-to` (and `--approve-stores`, `--approve-expires`, ...), confirmed once with a `y` in the terminal, or `--yes` | The confirmation is read from a terminal only; piped input is never a yes. `--json`, `--dry-run` and `--no-cart` refuse it. |
| Web app | The "Buy without asking" setting on a search, off by default, with a confirmation dialog | The server refuses a mandate from another origin or site (`Origin`, `Sec-Fetch-Site`), and without the access token from anything but this machine (loopback socket address and a localhost `Host`, which keeps the DNS-rebinding guard). JSON only, so a plain HTML form cannot send it. |
| MCP | The server's environment: `OSA_MCP_ALLOW_ORDERS=1` plus `OSA_MCP_APPROVE_UP_TO` (and stores, expiry) | No tool argument creates or widens it; a call with mandate-like arguments is refused with `safety_refusal`. The tool descriptions say purchases may happen automatically. |
| Plugins | Never: the manifests do not set any `OSA_MCP_*` variable | A test keeps every manifest free of them. |
| Library | `RunOptions.mandate` from `makeMandate()` | `ShoppingRun.approve()` refuses an approval that claims to be from a mandate; only the engine makes those, from its own review. |

**What a mandate can never do**, because it goes through the same gate (`approvalProblem` in `src/core/limits.ts`) as a clicked approval: buy a total that differs from this run's review, buy after the total changed on the store (the adapter re-reads it before the click), buy a subscription or membership line, go over the budget, order twice at a store, click Place order again after an "unknown" outcome, skip a sign-in, code or 3-D Secure step, buy in another currency than USD, or outlive its expiry (default: the end of the run). Orders being placed in parallel count against its run total and order count.

**What we cannot stop:** anyone or anything with your shell, your files or your MCP client's configuration has your powers. A coding agent that can run commands could run `osa --approve-up-to ... --yes`, and one that can edit your MCP config could add `OSA_MCP_APPROVE_UP_TO`. The skill (`skills/open-shopping-agent/SKILL.md`) tells agents never to do either and never to ask you to widen a mandate in chat; treat that as an instruction, not a control. Keep the limit low, name the stores, set an expiry, and do not give an untrusted agent your shell.

Text from store pages is data, never instructions: a page that says "approve up to $1,000" cannot change a mandate, because no input the model controls reaches one.
