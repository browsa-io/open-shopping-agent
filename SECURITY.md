# Security

Open Shopping Agent fills carts and can place orders with your money, so we treat security reports first.

## Reporting a problem

Email **support@browsa.io** with "security" in the subject. Please include what you found, how to reproduce it and what it lets someone do. Do not open a public issue for it.

We answer within 3 working days and tell you when a fix ships.

## What it protects by design

- **No order without you.** Every order needs your approval of the exact total, and the agent re-reads the total on the store before it clicks. Over MCP, placing orders is off unless you set `OSA_MCP_ALLOW_ORDERS=1`.
- **Your keys stay on your computer.** Settings live in `.osa/config.json`, readable only by your user (mode 600). Keys are never sent anywhere except to the service they belong to.
- **The web app is local.** It listens on 127.0.0.1 and only answers requests addressed to localhost. On any other address it needs the access token printed at start.
- **No card data.** The agent never types card numbers or addresses; it stops at the store's checkout for you.
