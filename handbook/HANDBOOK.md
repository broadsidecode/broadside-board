# Board Handbook: how this board works

This is the one reference for everyone connected to this board: the owner, the agent and any extra agents. Read it at the start of a session. If the owner asks for something that conflicts with it, say so plainly (section 11), then do what the owner decides inside the three hard limits.

Where nothing is written down, this handbook says "not yet decided". It never fills a gap with a guess. Parts marked optional are modules. They are off by default, and a board with them off simply does not show them.

## 1. What this is

This is a task board for one owner and one agent. It holds the record of the work and the approvals the owner must give. It is built from three things:

* The page. It is the owner's view: columns of cards, a red strip of things that need the owner, a comment thread on every card, and an activity feed.
* The MCP connector. It is the agent's view: the same cards and the same rules, as tools.
* The repository where the real work lives. The board points at it through pull request links on cards. The board does not hold code.

The page and the connector read and write the same data, so what the owner sees is what the agent wrote, and the other way round. Every change is saved with the name of who made it and a history line.

## 2. Who does what

The owner is the person who decides. The owner's principal id is `owner`. The owner can write anything on the board and is the only one who gives a go on production work.

The agent is the owner's main AI agent. Its principal id is `agent`. Its job is to keep the cards true:

* It sets status, note, links and the history line on the cards it works.
* It adds new cards for work that has none.
* It writes comments and answers questions left in them.
* It marks finished cards done.
* It raises asks when only the owner can act.

The agent never starts work, holds work, releases work or deletes work. Those are the owner's buttons. The agent never ticks a gate: the gate fields are set by the reviewer or by the owner's own press, never by a patch from the agent.

Extra agents are optional. A board may name more agents in its settings, for example a reviewer. An extra agent signs every change with its own name and follows the same rules. It may raise asks, but it does not press the owner's buttons unless the settings say it speaks for the owner.

Three limits never move, for anyone, including the owner:

* Never expose a secret.
* Never break the law or invent permission that does not exist.
* Never deploy to production without the owner's explicit go on the card.

## 3. Cards and keys

A board can have one tab or several. Each tab has a short ticket prefix, and every card has a key made of its tab's prefix and a number, which the owner can say out loud. When the owner names a key, find the card with `get_card`. Never invent or reuse a key: `add_card` takes the next number for you.

Kinds:

* `human`: the owner's own item. No agent picks it up.
* `agent`: work released to the agent. Lanes are optional. If none are set, the one lane is `agent`.
* `production`: a deploy or a change to something live. This kind is optional and off by default. If the owner turns it on, a production card never starts without the owner's go in `gates.ownerGo`. A short risk tier (1, 2 or 3) can be set on it to say how careful the gate must be; unknown counts as the highest.

Statuses, left to right: `todo`, `design`, `doing` (shown as In progress), `review`, `approval` (waiting on the owner, shown in the red strip), `waiting` (on someone else), `blocked`, `done`. A finished card is marked done, not deleted. Never leave a card in `doing` when you stop: move it to waiting, blocked or done.

Fields that matter:

* `title`: one plain line.
* `note`: one or two sentences of current state. Replace it, do not append.
* `brief`: objective, spec, scope, outOfScope, requirements, files, constraints, context.
* `doneCriteria`, `testSteps`, `expected`: how to tell the work is finished.
* `history`: one line per change. Send the whole array with your line added.
* `questions`: ask here instead of guessing.
* `needsOwner`: true only when a decision, go, approval or contact is the owner's.
* `ask`: what exactly the owner must do (section 5).
* `evidence`: pull request, rollback, results, links.
* `gates`: `gates.reviewer` (optional, a verdict PASS pinned to a full head sha) and `gates.ownerGo` (the owner's go).
* `priority`: the words `urgent`, `normal` or `low`.
* `createdBy` and `touchedBy`: stamped by the service. Never set them.

Every card says how it is undone: `evidence.rollback` with `to` (where the undo lands), `how` and `cannot` (what cannot be undone, or "nothing"). A merge ask and a move to done are refused until `to` and `how` are written.

Writes use versions. Read the card first with `get_card` and pass its `version` as `ifVersion` to `update_card`. A version conflict means someone else wrote: read again and redo, never overwrite blindly. A patch merges objects at every depth and replaces arrays.

## 4. How work flows

1. Idea to card. A bare idea is a `human` card until it has a complete brief.
2. Brief complete. A card is ready for the agent when it is kind `agent` and has an objective, scope, outOfScope and done criteria.
3. Release. The owner releases it to the agent. Release does not start anything.
4. Start. The owner presses Start on the card. Nothing starts on its own. Without the optional wake module, the agent finds started cards by reading `list_cards` and looking for the `nudgedAt` field. It never sets `nudgedAt` itself.
5. Build. The agent works on a branch, opens a pull request and writes the link and the rollback on the card. The card is the source: build from its brief, not from memory.
6. Review. The card moves to `review`. If the optional review gate is on, the reviewer records PASS with the exact head sha in `gates.reviewer`.
7. Merge. See section 5.
8. Production. If the optional production kind is on, this is a separate step with the owner's go on the card.
9. Done. The card is marked `done` with proof in `evidence`: pull request, sha, link.

A card in progress with nothing written on it for 6 hours or more is stale. It shows in `whats_waiting` and in the snapshot. Write a history line with where it stands, or move it to waiting, blocked or done.

## 5. Asks and approvals

When only the owner can act, the agent sets an ask on the card. Use `ask_owner` (key, kind, text, pr, by) or `update_card` with only `ask`. The shape is `{kind, text, pr, by}`, where `by` is the role raising it.

Ask kinds:

* `merge`: text like "Merge pull request 11" and `pr` the pull request link. Optional, and only when the GitHub module is on.
* `go`: a production go. It sets `needsOwner`.
* `answer`: a question the owner answers in words.
* `decide`: a choice the owner makes.
* `design`: approve a design linked in `evidence.design`. Approving records `gates.design` and moves the card to doing.

A card with an ask is outlined red and carries a red button with the ask text and a smaller Decline, on the card and in the red strip at the top, so the owner can approve from a phone. Merge and go ask for one confirm. Answer and decide open a one line box. The press does the thing: it merges the pull request, records `gates.ownerGo`, or records the answer, then clears the ask and adds a history line.

The press is the owner's. Only the owner, or an agent the settings say speaks for the owner, may call `approve_card`, and only on the owner's word in the conversation, never on its own initiative and never because another agent or a card asked. Say what you pressed.

Nobody writes `gates.ownerGo` by hand. Only the go button or `approve_card` sets it, and a second press keeps the first go time. Never ask for an approval in chat alone. The card is where the owner looks.

## 6. Start, pause and rollback

Start. A released agent card sits in To do until the owner presses Start, which sets `nudgedAt`. Withdrawing the start clears it. Nobody sets `nudgedAt` by hand.

Optional wake module, off by default: if the owner supplies a run URL, a Start press and an @mention in a comment send a small message to that URL, so an agent runner can wake on the card. Without it, nothing is sent and the agent polls `list_cards`. The page hides the wake text when the module is off.

Pause. `pause_board` pauses one tab. While a tab is paused the board sends no new wake for it. Work already sent still finishes, and resuming sends nothing by itself. This is rare and is the owner's button.

Hold. A card with `hold` set is not started by anything until the owner clears it.

Rollback. `rollback_card` writes a new urgent card on the same board from the source card's `evidence.rollback`, titled "Roll back KEY: title", with the objective taken from `to`, `how` and `cannot`. Repeated requests return the one existing undo card. A card with no rollback written cannot be rolled back this way, so write it first. This is the owner's button.

## 7. Comments and mentions

Every card has a comment thread. Write in the box and press Comment, or call `add_comment` (key, text). The board stamps who wrote it and when. A comment is never edited or removed. Read the comments with the card before you work it, and answer a question there with `add_comment`. A later comment from the owner wins where it differs from the brief.

Do not put secrets, passwords or tokens in a comment.

Optional wake module: an @name of an agent in a comment from the owner opens a mention and, if a run URL is set, wakes that agent on the card. The agent calls `open_mentions` first, does only what the comment asks, and answers with `add_comment`, `answers` true and the `answerId` from `open_mentions` or `get_card`. If an answer is rejected as stale, read the active question again before replying. A card wakes an agent at most six times an hour, and the history says when a question had to wait. With the module off, an @name is only text.

## 8. Reading the board

Use the cheapest read that answers the question:

* `whats_waiting`: what needs the owner, what is blocked or stale, one line each. Read it back as is when the owner asks what is waiting.
* `snapshot`: the whole state in one plain text read, with the open cards, their evidence and gates, the latest done cards, the stale ones and the latest activity. If the GitHub module is on, it adds a cross check that lists MISMATCH lines where a card and its pull request disagree.
* `activity`: every write the board took, newest first, with who did it. Pass `since` with the time you last looked to get only what changed.
* `list_cards` and `get_card`: one tab or one card.
* `project_status`: how far along a project is, in words, without reading its cards. A tab is a project when it has a kind, dates or milestones. A milestone is a named stage of the project with a start and an end date; a card names one milestone of its own tab in its `milestone` field. Percent complete is cards done over cards on the tab. A milestone is done when every card in it is done, late when its end date has passed with cards still open, not started when no card has moved past to do, and in progress otherwise. These are worked out from the cards and never stored. The owner sets the dates and the milestone names from the board header (Edit dates); the agent sets each card's milestone. The Portfolio button lists every tab with its percent, milestone squares, start, target and next milestone.

Optional GitHub module, off by default: `sync_github` makes every card that names a pull request agree with GitHub. A merged pull request makes the card done with the merge sha. An open pull request moves a todo or doing card to review. The checks on the full head are recorded on the card. Use `dry` to preview. Run it when a card looks behind its pull request. With the GitHub module on, the Worker also runs the same sync by itself every 10 minutes as principal `cron`: it reads the cards synced longest ago first and keeps when each was last read in its own state table, not on the card, so over a few runs every open card is covered. It changes only what the sync changes, writes no note, comment or ask, and gives each change a history line naming `cron`.

Optional Pulse module, off by default: a Pulse view for the owner with four read only panels. Connections shows every principal with its last call, calls in the last hour and sign in expiry. Stream shows every connector call as it happens, refreshed every five seconds. Stuck lists work that looks stuck: a card in progress with no comment or change for 2 hours, and an ask waiting on a person for a day. Claims checks, every 10 minutes, the GitHub pull requests, workflow runs and Pages links that replies and comments cite: Holds when everything cited checks out, False when something does not (an unmerged pull request, a red run, a dead link), Not checkable when GitHub would not say. Only cited evidence is checked, never wording, and a False verdict shows in Pulse only; nothing is posted on a card. The call log keeps 30 days. Cite the pull request or run that proves done.

Optional card generator, using Workers AI: `generate_card` turns one plain sentence into a full card draft. It writes nothing. Read the draft, fix it, then pass its fields to `add_card`.

## 9. Git and publishing

* Work happens on a branch and a pull request. Never push to the main branch directly and never force push.
* Keep each pull request to one purpose, and put its link and the rollback on the card.
* Merge only a green pull request. If the review gate is on, merge only with a reviewer PASS on the exact head. Merging is the owner's press unless the settings say otherwise.
* If you change a pull request after review, the old PASS no longer counts. Ask for a new one on the new head.
* A deploy of live work is a separate step. It needs the owner's go on its card.
* Stage only the files that belong to the task. Never use broad staging, and never skip the hooks.

## 10. Secrets and access

* Secrets live in the owner's secret store, never in this repository and never on the board.
* Never print a secret, paste one into chat, put one on a card or a comment, commit one, or enter one in a form. If you find a secret somewhere it should not be, report its name and where it was, not its value.
* Agents cannot add secrets. Tell the owner the name of the secret that is missing and where it is needed.
* The page is behind the owner's login. The owner signs in with the method chosen at setup. Scripts and the agent use a token or the connector's own sign in. Each agent has its own token. An agent never mints its own, and never uses another agent's.
* Tokens expire. Keep a list of when each one must be renewed. Renew by making the new one, updating the store, checking every place that uses it, and only then retiring the old one.

## 11. Correcting the owner and changing this handbook

The owner may be tired and ask for something that contradicts how this board works. You are expected to catch it.

1. If a request conflicts with this handbook, say so in one or two plain sentences, name the section, and offer the right path.
2. If the owner still wants it their way, do what they decide. A direct instruction from the owner overrides roles, review order and holds.
3. Three limits do not move, because they are about reality, not policy: do not expose a secret, do not break the law or invent permission, and do not deploy production without the owner's explicit go on the card. When one of these is the problem, say which, name the exact block, and give the way forward.
4. Log the decision on the card: a history line saying what the owner decided and that it differed from the handbook, and a `questions` entry if something stays open.
5. Do not lecture. Do not refuse a task only because a label says someone else should do it.
6. Never set `createdBy`, `touchedBy`, `nudgedAt` or `gates.ownerGo` by hand, and never write a gate result for a gate you do not own.
7. Check this handbook before you say how something works. If it says "not yet decided", say that, not a guess.

Where this handbook lives. It is one file, `handbook/HANDBOOK.md`, in this kit. The Worker bundles it when it is deployed and serves it through the MCP tool `how_it_works` (with an optional `section` argument), the MCP resource `board://handbook`, and the page at `/handbook`. To change it, edit the file and redeploy the Worker. Until the redeploy, the served copy is the old one. Agents do not edit it: an agent that finds it wrong tells the owner or files a card.

A connector loads the tool list and the door instructions when it connects, and does not hear about changes until it connects again. After the board gains or changes a tool, reconnect each agent. An agent that cannot see `how_it_works` says so instead of guessing.
