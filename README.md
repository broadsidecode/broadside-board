# Broadside Board

A task board for one person and their AI agent. It runs on your own Cloudflare account, has a hosted page for you, and an MCP connector so Claude, ChatGPT, Cursor, Grok or any MCP capable agent can read and write the same cards.

You keep the record of the work and the approvals only you can give. The agent keeps the cards up to date. Both of you see the same board, and every change carries the name of who made it.

## What you get

* A board page with columns of cards, a strip of things that need you, a comment thread on every card, and an activity feed.
* An MCP connector at `/mcp`, with tools to add and update cards, comment, ask you for a decision, and read what is waiting.
* Approvals: an agent can ask you for a go, and only you can give it. Rollback and history are built in.
* A handbook the agent reads at the start of a session, so it knows the rules.
* A small API under `/api/v1/` and a command line client in `cli/`.
* An installer, `setup.js`, that creates the database, deploys the Worker, makes the secrets and seeds a first card.
* Tests that run with Node alone.

## Install in about five minutes

You need Node 22.5 or newer, a Cloudflare account, and an API token you create yourself. Then:

```
npm install --ignore-scripts
node setup.js
```

The installer asks a few questions, each with a default. Everything else is in [SETUP.md](SETUP.md), which is written so an AI agent can run the install for you. Your Cloudflare token is read from the environment (`CLOUDFLARE_API_TOKEN`) and is never asked for or stored.

## Modules

Every module is off by default. A module that is off is hidden from the page and from the connector's tool list.

| Module | What it adds |
| --- | --- |
| `start` | A Start button and @mentions that call a webhook you provide, so an agent runner can be woken. Without it, agents poll for new work. |
| `github` | Pull request links on cards, and checks against the organizations you list. |
| `production` | Cards for deploys, with risk tiers and a go that only you can give. |
| `generate` | Turns one sentence into a full card draft. Needs Workers AI on your account. |
| `tabs` | More than one board in tabs. |

Turn one on in `board.config.json`, run `node setup.js --apply-config`, then deploy again.

## Security notes

* The owner password is long and random. Only its SHA-256 hash is stored in the Worker. The page signs you in with an HttpOnly, Secure, SameSite Strict cookie, and writes from the cookie also check the Origin header.
* Agent tokens made with `add-agent` are stored only as hashes, and can be bound to one board.
* The MCP connector uses OAuth. A bootstrap code that you type on the consent page is the gate. Only its hash is stored, and OAuth codes and tokens are stored as keyed hashes.
* Every API route except health, config and login needs a sign in, and so do the handbook and the agent text feed. The config answer holds names and switches, no addresses or secrets.
* You can use Cloudflare Access instead of the owner password if you already have it.
* There is no telemetry. Nothing in this code calls home. The only outside calls are the ones you configure: Cloudflare, and the webhook or GitHub address if you turn those modules on.

## Run the tests

```
npm test
```

No network and no Cloudflare account are needed.

## License

MIT. See [LICENSE](LICENSE).

Built by Broadside Code.
