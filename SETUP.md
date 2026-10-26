# Setup guide for an AI agent

This guide is written for an AI agent that is installing the board for a person, on the person's own Cloudflare account. Follow the steps in order. Do not skip the checks. Never ask the person to paste a secret into chat.

## What you need

1. Node 22.5 or newer (`node --version`). npm comes with it.
2. A Cloudflare account that belongs to the person. The free plan is enough.
3. A Cloudflare API token, created by the person and put into the environment by the person as `CLOUDFLARE_API_TOKEN`. It must never be pasted into chat or saved in a file. Permissions:
   * Account, D1, Edit
   * Account, Workers Scripts, Edit
   * Account, Account Settings, Read
   * Only for a custom domain: Zone, Zone, Read and Zone, Workers Routes, Edit, on the zone that will hold the board
4. If the Cloudflare login can see more than one account, the person also sets `CLOUDFLARE_ACCOUNT_ID`.
5. A workers.dev address registered on the account if you choose the free address (Cloudflare dashboard, Workers and Pages, Account details, Subdomain). Cloudflare asks for this once per account.

The installer reads the token from the environment only and never asks for it. If it is missing it prints how to create one and exits with code 2.

## Steps

All commands run from the kit root, the folder that holds `setup.js`.

1. Look at the plan without changing anything.

   ```
   node setup.js --dry-run --yes
   ```

   It prints the ordered steps. No network call is made and no file is written. With no `board.config.json` yet, it uses the defaults.

2. Choose how to answer the settings. Either run the questions yourself and let the person answer, or write the answers into a file and run without questions.

   Interactive:

   ```
   node setup.js
   ```

   Without questions, for an agent:

   ```
   cp board.config.example.json board.config.json
   node setup.js --config board.config.json --yes
   ```

   Edit `board.config.json` first. The fields are in the table below.

3. Wait for the run. It prints one line per step:

   * `Step 1` writes `board.config.json`.
   * `Step 3` writes `worker/src/config.js` (only its CONFIG block) and `worker/wrangler.toml`.
   * `Step 4` installs the pinned wrangler with npm (scripts off), only when `node_modules` is missing.
   * `Step 5` creates the D1 database and records its id in `board.config.json`.
   * `Step 6` applies `worker/schema.sql`. It is safe to repeat.
   * `Step 7` deploys the Worker.
   * `Step 8` stores three secrets in the Worker, each on stdin, never on a command line.
   * `Step 9` checks `/api/v1/health` and `/api/v1/config`, signs in, and (first run only) creates the first board, its counter and a welcome card.

4. Read the closing output and hand it to the person (see "What to hand the person").

5. Verify (see "How to verify").

## The settings

| Field | Meaning | Default |
| --- | --- | --- |
| `ownerName` | The person's name, shown on the board | Owner |
| `agentLabel` | What the person calls the main agent | Agent |
| `workerName` | Name of the Worker, unique in the account | board |
| `databaseName` | Name of the D1 database | board-db |
| `databaseId` | Filled in by setup. Leave empty | empty |
| `domain.mode` | `workers-dev` for a free address, or `custom` | workers-dev |
| `domain.hostname` | For `custom`: a host name on a zone in the account, such as `board.example.com` | empty |
| `auth.mode` | `owner-password` (the default, simplest) or `access` (Cloudflare Access) | owner-password |
| `auth.accessTeamDomain`, `auth.accessAud`, `auth.ownerEmail` | Only for `access` | empty |
| `agents` | Extra connector names, each a lower case id. `agent` and `owner` always exist | none |
| `workers` | Writers that are not connectors, such as a script runner. They need a token | none |
| `lanes` | Lanes an agent card can sit in. The first is the default | main |
| `mentionNames` | Names an @mention can address | agent |
| `githubOrgs` | GitHub organizations or users whose pull requests the board accepts | none |
| `modules` | `start`, `github`, `production`, `generate`, `tabs`, each true or false | all false |
| `runUrl` | Address the Start module posts to. May contain `{id}` | empty |

Advanced, optional: `roles` (names an ask may be signed with, default `reviewer`), `admins` (extra principals that may delete cards) and `scopedWorkers` (writers that must carry a board scope).

For a custom domain the zone must already be on the person's Cloudflare account. Cloudflare creates the DNS record and certificate when the Worker deploys, which can take a few minutes.

## What to hand the person

The closing output of a first run prints these. They are shown once and are not stored anywhere readable, so hand them over right away.

1. The board address, for example `https://board.example.workers.dev`.
2. The owner password. It signs in to the page and works as a bearer token for scripts. Tell the person to put it in a password manager.
3. The MCP address, the board address followed by `/mcp`.
4. The bootstrap code. It is typed once on the consent page when an agent product connects.

Do not copy these into notes, commits or chat logs.

## Connect an agent product

On the consent page the person picks the connector name `agent` and types the bootstrap code. Every card change from that connector is then signed `agent`.

* Claude: Settings, Connectors, Add custom connector. Paste the MCP address.
* ChatGPT: Settings, Apps and Connectors, Advanced, turn on developer mode, Create. Paste the MCP address and choose OAuth.
* Cursor: add `{ "mcpServers": { "board": { "url": "<MCP address>" } } }` to `mcp.json`.
* Grok: Connectors, add a custom connector, paste the MCP address.

A script or a runner that cannot do OAuth uses a bearer token instead:

```
BOARD_OWNER_SECRET=<owner password> node setup.js add-agent agent --note "laptop runner"
```

It prints the token once. The principal must be `agent` or one of the configured `agents` or `workers`. Add `--board main` to bind a token to one board.

## How to verify

1. Health: `node setup.js status` prints `200` for `/api/v1/health` and `/api/v1/config`.
2. Sign in: open the board address in a browser and type the owner password. The welcome card is on the board.
3. Create a card through the MCP: in the connected product, ask the agent to call `how_it_works` first, then `add_card` with the board `main` and a title such as "Connector test". Reload the page and the card is there. If it is not, see the failure table.

## If something fails

| What you see | Likely cause | Fix |
| --- | --- | --- |
| Exit code 2 and the token guidance | `CLOUDFLARE_API_TOKEN` is not set in this shell | The person sets it in the environment and you run the command again |
| Authentication error, or "not authorized" from wrangler | The token lacks a permission | Edit the token to include D1 Edit, Workers Scripts Edit and Account Settings Read |
| "more than one Cloudflare account" | The token sees several accounts | Set `CLOUDFLARE_ACCOUNT_ID` and run again |
| Custom domain: zone not found, or a route error | The host name is not on a zone in this account, or the token lacks Zone Read and Workers Routes Edit | Use a host name on a zone the account owns, fix the token, run again |
| "A D1 database named ... already exists" | The name is taken in this account | Change `databaseName` in `board.config.json` and run again |
| "could not be read from the output" for the workers.dev address | No workers.dev subdomain is registered | Register one in the dashboard, or switch to a custom domain, then run again |
| wrangler not found, or npm fails | `node_modules` is missing and npm could not run | Run `npm install --ignore-scripts` in the kit root, then run setup again |
| Consent page says the bootstrap code is not right | Mistyped, or the secrets were rotated since | Run `node setup.js --yes --rotate` and use the new code |
| 401 on the page | Wrong owner password, or you are in `access` mode and not signed in to Access | Type the right password, or sign in through Access. To make a new password run with `--rotate` |
| `/api/v1/health` does not answer right after a custom domain deploy | The certificate and route are still being created | Wait a few minutes and run `node setup.js status` |

## Turn on a module

All modules are off by default. A module that is off is hidden from the page and from the connector's tool list.

1. Set it to true under `modules` in `board.config.json`. For `github` also set `githubOrgs`. For `start` also set `runUrl`.
2. Rewrite the generated files only:

   ```
   node setup.js --apply-config
   ```

3. Deploy again:

   ```
   cd worker
   ../node_modules/.bin/wrangler deploy
   ```

Extra notes. `generate` needs Workers AI, which `--apply-config` binds as `AI`. `start` also needs the secrets `START_WEBHOOK_URL` and `START_WEBHOOK_KEY` (or a routine address in `RUN_URL`) set with `wrangler secret put` from the `worker` folder. `github` needs the secret `GITHUB_MERGE_TOKEN` if the board should merge pull requests.

## Rotate secrets

```
node setup.js --yes --rotate
```

This makes a new owner password, signing key and bootstrap code, stores them, and prints the password and code once. Agent products that were connected must connect again. Bearer tokens made with `add-agent` keep working.

## Uninstall

From the `worker` folder:

```
../node_modules/.bin/wrangler delete
../node_modules/.bin/wrangler d1 delete <databaseName>
```

Both ask for confirmation. Deleting the database deletes every card. Remove the connector from each agent product too.
