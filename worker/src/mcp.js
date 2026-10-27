// Remote MCP (Streamable HTTP, plain JSON responses) for the Board. Every tool writes
// through the same store as the REST API, so versions, validation and history_log behave the same.
import { CLERK, clerkRefusal, RISK_TIERS, riskOf, compactCard, isPlainObject, readOnlyRefusal, isWaiting, waitingLine, mcpPatchProblem, slug, WRITERS, OWNER_PROXIES, isOwnerProxy, actorLabel, isStale, STATUSES, ASK_KINDS, priorityNumber, COMMENT_MAX, openMention, mentionQuestionId, canAnswerMention } from './lib.js';
import { rollbackCard } from './rollback.js';
import { isTracked, milestoneLines, newProjectFields, PROJECT_KINDS, projectLine, todayIn } from './projects.js';
import { startRun, mentionRun } from './run.js';
import { listBoards, getBoard, listTasks, getTaskByKey, writeTask, nextNumber, listActivity, HttpError, isBoardPaused, setBoardPaused, createBoard } from './store.js';

const PROXY_LIST = OWNER_PROXIES.join(', ');
import { generateCard } from './generate.js';
import { buildSnapshot } from './snapshot.js';
import { approveCard } from './approve.js';
import { syncBoard, syncText } from './sync.js';
import { logCall } from './pulse.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
import * as CFG from './config.js';
import { BOARD_INSTRUCTIONS } from './instructions.js';
export { BOARD_INSTRUCTIONS };
const SERVER_INFO = { name: 'board-kit', version: '1.0.0' };

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS = [
  {
    name: 'how_it_works',
    description: 'Call this once at the start of every session. Returns the Board Handbook: how the whole system works (who does what, cards, how work flows, asks, Start and rollback, comments, reading the board, Git, secrets, and how to correct the owner when a request conflicts with it). Optional section: a heading number or words from a heading (for example 6 or secrets) to return only that section.',
    inputSchema: obj({ section: { type: 'string', description: 'Heading number or words from a heading, such as 6, git, or secrets. Omit for the whole handbook.' } }),
  },
  {
    name: 'list_boards',
    description: 'List the Board tabs (id, name, ticket prefix, order, and projects: the Claude project that works each lane, "*" for every lane).',
    inputSchema: obj({}),
  },
  {
    name: 'list_cards',
    description: 'List cards in compact form (key, title, status, kind, lane, owner, note, needsOwner, ask, waitingOn, link, createdBy, touchedBy). All filters optional.',
    inputSchema: obj({
      board: { type: 'string', description: 'Board id such as main, acme-plumbing, riverside-bakery.' },
      status: { type: 'string', enum: STATUSES },
      kind: { type: 'string', enum: ['human', 'agent', 'production'] },
      lane: { type: 'string' },
      needsOwner: { type: 'boolean' },
    }),
  },
  {
    name: 'get_card',
    description: 'Get one full card by its ticket key (for example TDN-5), with its version for update_card. The card includes createdBy and touchedBy.',
    inputSchema: obj({ key: { type: 'string' } }, ['key']),
  },
  {
    name: 'add_comment',
    description: 'Add a comment to a card: the thread Owner, Agent and the agents talk in. Read the comments on get_card before working a card, and answer a question left there with a comment. A configured @name in a comment from Owner or a connector that speaks for him opens a mention on the card and wakes the project of that agent (@agent shows in whats_waiting instead). To answer a new question, pass answers true and answerId from open_mentions or get_card, even for the first answer. A stale or ambiguous answer is rejected; reread the active question before replying. ID-free answers work only for a sole, unambiguous legacy question. The board stamps who wrote it and when; comments are never changed or removed. Plain text, up to 2000 characters. Owner and Agent, the board\'s clerk; read only for every other agent (). Agent never writes an @name, because a mention wakes a run.',
    inputSchema: obj({ key: { type: 'string' }, text: { type: 'string' }, answers: { type: 'boolean', description: 'true when this comment answers the open @mention on the card.' }, answerId: { type: 'string', description: 'Question ID from open_mentions or get_card. Required for every new question, including the first; an ID-free answer works only for a sole, unambiguous legacy question.' } }, ['key', 'text']),
  },
  {
    name: 'open_mentions',
    description: 'Cards with an open @mention (asked in a comment, not yet answered), oldest first, one line each with the board, question and its answerId. board narrows it to one board; leave it out to search every board. lane narrows it to one mention name; without lane the mentions for the main agent are left out, because that agent answers those itself. A Board run checks this first and answers the oldest with add_comment, answers true and that answerId.',
    inputSchema: obj({ board: { type: 'string' }, lane: { type: 'string' } }),
  },
  {
    name: 'generate_card',
    description: 'Turn one plain sentence into a full card draft (title, note, brief, done criteria, test steps, expected, workType, skillsRequired) with the same generator Owner uses on the board page. It writes nothing: read the draft, fix anything wrong, then pass its fields to add_card. kind is human, agent or production (production only describes; the server still refuses to create it). Writers only; about 12 a minute.',
    inputSchema: obj({
      board: { type: 'string', description: 'Board id such as main or acme-plumbing; it only colors the prompt.' },
      text: { type: 'string', description: 'The task in plain words, up to 4000 characters.' },
      kind: { type: 'string', enum: ['human', 'agent', 'production'], description: 'Card kind for the draft. Default agent.' },
    }, ['text']),
  },
  {
    name: 'add_card',
    description: 'The board is read only for agents (): Owner adds any card; Agent, the board\'s clerk, adds any card but a production one, so work she finds untracked gets a card; every other name adds a card only to carry an approval request, so it must pass ask (the same {kind, text, pr, by, gates, sha} as ask_owner) and may pass only board, title, kind human or agent, lane, and the merge record (evidence.pr, evidence.rollback, evidence.reviewedHead, gates.reviewer). A merge ask needs evidence.rollback on the card, so pass it here. Add a card to a board. Takes the next ticket number from the board counter and returns the key. kind is human (default), agent, or production (a deploy or a change to a live site; only Owner or a connector that speaks for him may create one; anyone but Owner passes risk and riskWhy with it, plus ask {kind: go, text} for tier 2 or 3, so Owner is handed the card with a Go button, or, for tier 1, nothing to press at all). The server stamps createdBy and touchedBy from the connector name, so do not set them.',
    inputSchema: obj({
      board: { type: 'string' },
      title: { type: 'string' },
      kind: { type: 'string', enum: ['human', 'agent', 'production'] },
      lane: { type: 'string', enum: CFG.LANES, description: 'Which lane works an agent card. The first configured lane is the default.' },
      brief: { type: 'object' },
      doneCriteria: { type: 'array', items: { type: 'object' }, description: 'Each item is {text}. An item {text, heading: true} is a section title: the items after it show under it, and it never counts as a step.' },
      workType: { type: 'string' },
      skillsRequired: { type: 'array', items: { type: 'string' } },
      priority: { type: ['string', 'number'], description: 'urgent, normal or low (the default is normal). A number is kept as is; lower is more urgent.' },
      ask: { type: 'object', description: 'The approval request the card carries, shaped as in ask_owner: {kind, text, pr, by, gates, sha}. Required for every name but Owner, except a tier 1 production card, which carries risk and riskWhy instead.' },
      risk: { type: 'integer', enum: [1, 2, 3], description: 'Production cards: the risk tier from what the change touches (see the handbook). 1 flows with no press (internal tools, previews, docs); 2 is the agent\'s press; 3 is the owner\'s (money, legal, wide secrets, deletes, a first launch, a production host). Highest wins; unknown is 3. Required with riskWhy for a production card from anyone but Owner.' },
      riskWhy: { type: 'string', description: 'One line naming the item from the handbook risk list that puts the card in its tier.' },
      evidence: { type: 'object', description: 'For an approval card only pr, rollback {to, how, cannot} and reviewedHead. A tier 1 production card needs rollback before it can deploy.' },
      gates: { type: 'object', description: 'For an approval card only reviewer {verdict, sha, notes, at}.' },
    }, ['board', 'title']),
  },
  {
    name: 'update_card',
    description: 'Owner writes any field. Agent, the board\'s clerk (), writes the record: status (done included), note, link, owner, lane, waitingOn, priority, title, brief, evidence and history lines, but never gates, hold, nudgedAt, pokedAt, a card\'s kind, or evidence.start, run, relay, reviewedHead or mergeAttempt; those stay Owner\'s or the reviewer\'s. Every other name may patch only ask and the record a merge ask needs (evidence.pr, evidence.rollback, evidence.reviewedHead, gates.reviewer), because the board is read only for agents (). To ask Owner for something, set ask {kind, text, pr}: kind merge (pr is the pull request URL, text like "Merge pull request 11"), go (production go), design (approve the design on evidence.design), answer (a question answered in words) or decide (anything else, with text). A merge ask goes to Agent (ask.to agent, waitingOn agent): she approves merges now, not Owner (). An answer or decide ask from a bot goes to Agent too (the card waits on her); from Owner\'s connectors it is a recommendation for Owner. The other kinds set needsOwner and give the card a red Approve button; Owner presses it and the board does the thing. Never ask him in chat alone. A merge ask and a move to done are refused until evidence.rollback {to, how, cannot} is on the card. priority takes the words urgent, normal or low. Merge fields into a card: objects merge at every depth; arrays replace. ifVersion must be the version from get_card. Cannot change key, num or history, and gates.ownerGo is only ever set through approve_card with a go. kind production may be set by Owner or a connector that speaks for him. The server adds this connector to touchedBy and never changes createdBy, so do not set either. milestone (Owner, Agent and Worker) is the id of one of the card\'s own tab milestones, such as build; list_boards shows them, and an id the tab does not have is refused. Milestone dates and project dates are never set here; Owner changes them on the tab header.',
    inputSchema: obj({ key: { type: 'string' }, patch: { type: 'object' }, ifVersion: { type: 'integer' } }, ['key', 'patch', 'ifVersion']),
  },
  {
    name: 'release_card',
    description: 'Owner only, Agent included: the board is read only for agents (). Release a card to the agents: kind agent, lane lane1 (or the lane given), status todo, needsOwner false. Production cards cannot be released this way. The server adds this connector to touchedBy.',
    inputSchema: obj({ key: { type: 'string' },
      lane: { type: 'string', enum: CFG.LANES, description: 'Which lane works an agent card. The first configured lane is the default.' },
    }, ['key']),
  },
  {
    name: 'ask_owner',
    description: 'Raise an ask on a card: the way a bot says what only Owner or Agent can do. kind merge (pr is the pull request URL in a configured GitHub organization; text like "Merge pull request 11") goes to Agent, who approves merges; go (production go, or the go for a live run: add gates, the task file owner gate ids, with pr and sha, the full head SHA being tested, and Owner\'s press posts "Gate <id>: PASS" pinned to that head on the pull request) is Owner\'s; answer (a question answered in words) or decide (anything else) from a bot goes to Agent. by is the role raising it, for example reviewer. It goes through the same write as update_card, so the ask rule and stamps apply: an ask for Owner sets needsOwner and the red Approve button on the board, an ask for Agent sets waitingOn agent. Returns the key, the ask as stored and needsOwner. The one write open to every name: the board is read only for agents otherwise ().',
    inputSchema: obj({
      key: { type: 'string', description: 'Ticket key such as TDN-14.' },
      kind: { type: 'string', enum: ASK_KINDS },
      text: { type: 'string', description: 'What Owner must do or answer, in plain words.' },
      pr: { type: 'string', description: 'Pull request URL; required for kind merge, and for a go with gates.' },
      by: { type: 'string', description: 'The role raising the ask, for example reviewer, builder, lane1.' },
      gates: { type: 'array', items: { type: 'string' }, description: 'kind go only: owner gate ids from the pull request task file that this go satisfies.' },
      sha: { type: 'string', description: 'kind go with gates: the full 40 character pull request head SHA the live run tests.' },
    }, ['key', 'kind', 'text']),
  },
  {
    name: 'approve_card',
    description: 'Press Owner\'s button on a card: approve or decline its ask, the same as the red button on the board page. Owner\'s own connector and the connectors that speak for him (' + PROXY_LIST + ') may call it; press it only when Owner tells you to in this conversation. Agent\'s press counts as Owner\'s own (\"her typing is my typing now\"): she approves, declines, answers, decides, merges and gives the production go on his word, and presses a merge ask addressed to her under her own merge rule. The board records every press as done by you for Owner. It does the thing the ask says: a merge ask squash merges the pull request on GitHub, a go ask records gates.ownerGo (and, when it carries gates, posts "Gate <id>: PASS" pinned to its head on the pull request and re-runs its checks), a design ask records gates.design and moves the card to doing, an answer or decide ask records the note (required when the question is still Agent\'s; a recommendation sent to Owner is taken as the decision when no note is given). For a production card that has no ask yet, pass as go to give the production go. Returns the history line written.',
    inputSchema: obj({
      key: { type: 'string' },
      decision: { type: 'string', enum: ['approve', 'decline'] },
      note: { type: 'string', description: 'Required to answer a question that is still Agent\'s; optional otherwise (a recommendation to Owner stands as the decision without one).' },
      as: { type: 'string', enum: ['go'], description: 'go: give the production go on a production card that has no ask yet.' },
    }, ['key', 'decision']),
  },
  {
    name: 'rollback_card',
    description: 'Undo a card: writes a new urgent card on the same board from the card\'s evidence.rollback (to, how, cannot), titled "Roll back <KEY>: <title>", depending on the source card; nudged and ready to start when the source card has a lane, otherwise left for Owner to place and start. A production source makes a production rollback card that still needs Owner\'s go. Owner only: the board is read only for agents (). Press it when Owner says roll it back. Refused when the card has no evidence.rollback. Returns the new key.',
    inputSchema: obj({ key: { type: 'string' } }, ['key']),
  },
  {
    name: 'nudge_card',
    description: 'Press Nudge on an agent card (the same button Owner has): action start sets nudgedAt so the runners may pick it up; action withdraw clears it. Start again after a cloud run requires its acknowledged Start, a worker run link, and evidence.result with startId equal to evidence.start.id and completedAt at or after the claim, with the card back in todo. A bare result or uncertain Start cannot be restarted. Only an agent card in todo that is not on hold can be nudged. Owner only: the board is read only for agents (). Press it when Owner tells you to start a card. The board records who pressed it.',
    inputSchema: obj({
      key: { type: 'string' },
      action: { type: 'string', enum: ['start', 'withdraw'], description: 'start (default) or withdraw.' },
    }, ['key']),
  },
  {
    name: 'pause_board',
    description: 'Pause or resume one board tab (rare; for testing one lane at a time). While a tab is paused the board starts no new work there: Start and @mention wakes for that tab\'s project are not fired, stay queued on their cards, and a Board run that starts anyway reads the pause and works only what the board fired before it (or exits without project work). Work fired before the pause still finishes. It does not stop a run already working and does not disable the agent jobs themselves. Resume fires nothing on its own; it lists what is queued and what was fired before the pause and is not finished, and the next Start or comment on each card fires it as usual. The board records who paused or resumed and when. Owner only: the board is read only for agents (). Press it when Owner says to.',
    inputSchema: obj({
      board: { type: 'string', description: 'Board id such as acme-plumbing or main.' },
      paused: { type: 'boolean', description: 'true pauses the tab, false resumes it.' },
      reason: { type: 'string', description: 'One line on why, written to the board and the history log.' },
    }, ['board', 'paused']),
  },
  {
    name: 'add_board',
    description: 'Make a new board tab with its ticket counter (): id, name, ticket prefix and the agent project that works its cards. The counter starts at 1, so the first card on the tab is <prefix>-1. It never changes an existing tab: an id or prefix already in use is refused. Owner and Agent only; every other name is refused because the board is read only for agents. Returns the new tab.',
    inputSchema: obj({
      id: { type: 'string', description: 'Tab id, lowercase letters, digits and dashes, such as acme-plumbing.' },
      name: { type: 'string', description: 'The tab name Owner sees, such as Acme Plumbing.' },
      prefix: { type: 'string', description: 'Ticket prefix, 2 to 10 capital letters or digits starting with a letter, such as ACM. Must not be used by another tab.' },
      project: obj({
        name: { type: 'string', description: 'The Claude project name.' },
        url: { type: 'string', description: 'The project link, https://claude.ai/code/project/<id>.' },
      }, ['name', 'url']),
      lane: { type: 'string', description: 'Which lane that project works, or * for every lane (the default).' },
      kind: { type: 'string', enum: PROJECT_KINDS, description: 'What the tab is: website (the default, with the standard seven milestones from Intake to Handoff), product or internal (no milestones until Owner adds them).' },
    }, ['id', 'name', 'prefix', 'project']),
  },
  {
    name: 'delete_card',
    description: 'Delete a card for good, the same as Delete on the board page. Owner only: the board is read only for agents (). Only when he means to delete it; the normal rule is to mark a finished card done. Returns the key removed.',
    inputSchema: obj({
      key: { type: 'string' },
      reason: { type: 'string', description: 'One line on why, written to the history log.' },
    }, ['key']),
  },
  {
    name: 'sync_github',
    description: 'The Sync button: make every card that names a pull request agree with GitHub (merged becomes done with the merge sha, an open pull request moves a todo or doing card to review, checks and the Reviewer comment are recorded). A fallback for when a thread or the repo workflow missed an update; the board cannot read the Claude projects, GitHub is its one source. A production card whose deploy is not recorded (no evidence.deployedSha) keeps its status when its pull request merges. key syncs one card only and writes only its checks line and the Reviewer comment claim, never status, ask or needsOwner. dry true previews without writing. Optional board id. Writers only; every change gets a history line naming you.',
    inputSchema: obj({
      board: { type: 'string', description: 'Board id such as acme-plumbing. Omit for every board.' },
      key: { type: 'string', description: 'One card key such as TASK-74: refresh only its exact head checks and reviewer comment evidence.' },
      dry: { type: 'boolean', description: 'true: report what would change and write nothing.' },
    }),
  },
  {
    name: 'snapshot',
    description: 'The whole state of the work in one plain text read: asks for Owner, every open card with its evidence, gates and last history lines, the latest done cards, and a GitHub cross check that puts each pull request next to what its card claims, with MISMATCH lines where they differ. Read only. Optional board id to limit it; github false skips the GitHub cross check.',
    inputSchema: obj({
      board: { type: 'string', description: 'Board id such as main or acme-plumbing. Omit for every board.' },
      github: { type: 'boolean', description: 'false skips the GitHub cross check. Default true.' },
    }),
  },
  {
    name: 'whats_waiting',
    description: 'The red strip across every board, plus Agent\'s queue: cards that need Owner, are blocked, wait for approval, carry an ask addressed to Agent (a merge, or a bot\'s question), have an open @mention, or have gone stale (In progress with nothing written for 6 hours or more), and are not done. One plain line each.',
    inputSchema: obj({}),
  },
  {
    name: 'project_status',
    description: 'How far along a project is, in words, without reading its cards: percent complete (cards done over cards on the tab), the milestone moving now with its done count and blocked count, the next one not started, the target date, whether it is late, and how many cards name no milestone. One line per project, then one line per milestone for a single board. Omit board for every tracked project. Read only.',
    inputSchema: obj({ board: { type: 'string', description: 'Board id such as riverside-bakery. Omit for every tab that has a kind, dates or milestones.' } }),
  },
  {
    name: 'activity',
    description: 'The activity feed: every write the board took, newest first, across every board, one plain line each (time, who, card key, what). Use since (an ISO time, for example the time of the last read) to get only what changed since Owner or you last looked; board limits it to one tab; limit caps the lines (default 50, max 500). Read only.',
    inputSchema: obj({
      since: { type: 'string', description: 'ISO time; only entries after it. Omit for the latest.' },
      board: { type: 'string', description: 'Board id such as main or acme-plumbing.' },
      limit: { type: 'integer', description: 'Max lines, default 50, max 500.' },
    }),
  },
];

const nowIso = () => new Date().toISOString();

export const HANDBOOK_URI = 'board://handbook';

// The handbook is bundled into the Worker by index.js (HANDBOOK.md is the single source) and passed
// in as env.HANDBOOK. Tests pass the file text the same way.
function handbookText(env) {
  const text = env && env.HANDBOOK;
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(500, 'the handbook is not bundled into this deploy');
  return text;
}

// Split the markdown on its "## " headings. The text before the first "## " is the preamble.
export function handbookSections(text) {
  const parts = String(text).split(/^(?=## )/m);
  return parts.map((body, i) => {
    const m = body.match(/^## (.+)$/m);
    return { heading: i === 0 && !body.startsWith('## ') ? '' : (m ? m[1].trim() : ''), body: body.trimEnd() };
  }).filter((p) => p.body);
}

export function handbookSection(text, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return text;
  const sections = handbookSections(text).filter((s) => s.heading);
  const num = q.match(/^(?:section\s*)?(\d+)\.?$/);
  const hit = (num && sections.find((s) => s.heading.startsWith(`${num[1]}. `)))
    || sections.find((s) => s.heading.toLowerCase().includes(q));
  if (!hit) throw new HttpError(404, `no handbook section matches "${query}". Sections: ${sections.map((s) => s.heading).join(' | ')}`);
  return hit.body;
}

function requireWriter(principal) {
  if (!WRITERS.includes(principal)) throw new HttpError(403, `${principal} may read but not write`);
}

// The manager lanes an agent card can sit in; lane1 is the default, as before.
const LANES = CFG.LANES;
function laneOf(lane) {
  if (lane === undefined || lane === null || lane === '') return CFG.DEFAULT_LANE;
  if (!LANES.includes(String(lane))) throw new HttpError(400, `lane must be one of ${LANES.join('|')}`);
  return String(lane);
}

async function cardByKey(db, key) {
  const doc = await getTaskByKey(db, String(key || ''));
  if (!doc) throw new HttpError(404, `no card ${key}`);
  return doc;
}

async function callTool(env, principal, name, args = {}) {
  const db = env.DB;
  switch (name) {
    case 'how_it_works':
      return handbookSection(handbookText(env), args.section);
    case 'list_boards': {
      const boards = await listBoards(db);
      return boards.map((b) => ({ id: b.id, name: b.data.name, prefix: b.data.prefix, order: b.data.order, ...(b.data.projects ? { projects: b.data.projects } : {}),
        ...(b.data.kind ? { kind: b.data.kind } : {}), ...(b.data.start ? { start: b.data.start } : {}), ...(b.data.target ? { target: b.data.target } : {}), ...(Array.isArray(b.data.milestones) && b.data.milestones.length ? { milestones: b.data.milestones } : {}),
        paused: isBoardPaused(b), ...(b.data.pauseSetAt ? { pauseSetBy: b.data.pauseSetBy, pauseSetAt: b.data.pauseSetAt, pauseReason: b.data.pauseReason || '' } : {}) }))
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    }
    case 'list_cards': {
      let docs = await listTasks(db, { board: args.board, status: args.status, kind: args.kind, lane: args.lane });
      if (typeof args.needsOwner === 'boolean') docs = docs.filter((d) => Boolean(d.data.needsOwner) === args.needsOwner);
      return docs.map((d) => compactCard(d.data));
    }
    case 'get_card': {
      // Connectors that connected before the handbook existed still hold the old tool list, so the
      // handbook is also reachable through get_card with the key HANDBOOK (optionally HANDBOOK:<section>).
      if (/^HANDBOOK(:|$)/i.test(String(args.key || ''))) {
        const section = String(args.key).split(':').slice(1).join(':').trim();
        return { key: 'HANDBOOK', handbook: handbookSection(handbookText(env), section || undefined) };
      }
      const doc = await cardByKey(db, args.key);
      // a card on a paused tab says so, so a run reading its card knows to exit.
      const paused = isBoardPaused(await getBoard(db, String(doc.data.board || '')));
      return { id: doc.id, version: doc.version, updated_at: doc.updated_at, ...(paused ? { boardPaused: true } : {}), card: doc.data };
    }
    case 'generate_card': {
      requireWriter(principal);
      return generateCard(env, principal, { board: args.board, text: args.text, kind: args.kind });
    }
    case 'add_card': {
      requireWriter(principal);
      const kind = args.kind || 'human';
      if (!['human', 'agent', 'production'].includes(kind)) throw new HttpError(400, 'kind must be human, agent or production');
      if (kind === 'production' && !isOwnerProxy(principal)) throw new HttpError(403, `kind production is created only by Owner or a connector that speaks for him (${PROXY_LIST})`);
      if (!args.title || !String(args.title).trim()) throw new HttpError(400, 'title is required');
      // Read only (): every name but Owner's opens a card only to carry an ask. Agent, the
      // board's clerk, makes any card but a production one (lib.js clerkProblem).
      const clerk = principal === CLERK;
      // A production card from anyone but Owner names its tier (lib.js riskProblem) and is handed over with its
      // go ask, or with no ask at all when it is tier 1 (lib.js handedCard), so Owner is handed the button, or nothing.
      if (kind === 'production' && principal !== 'owner') {
        if (!RISK_TIERS.includes(Number(args.risk)) || typeof args.riskWhy !== 'string' || !args.riskWhy.trim()) throw new HttpError(400, 'a production card from anyone but Owner names its tier: pass risk 1, 2 or 3 and riskWhy, the item from the handbook risk list');
        if (Number(args.risk) !== 1 && !(isPlainObject(args.ask) && args.ask.kind === 'go')) throw new HttpError(403, 'a tier 2 or 3 production card from anyone but Owner carries its go ask: pass ask {kind: go, text}');
        if (Number(args.risk) === 1 && isPlainObject(args.ask)) throw new HttpError(400, 'a tier 1 production card carries no ask: it deploys on Reviewer\'s PASS, green checks and the rollback on the card');
      }
      const approvalCard = principal !== 'owner' && !clerk;
      if (approvalCard) {
        if (!isPlainObject(args.ask) && !(kind === 'production' && Number(args.risk) === 1)) throw new HttpError(403, readOnlyRefusal(principal));
        const extra = ['brief', 'doneCriteria', 'workType', 'skillsRequired', 'priority'].filter((k) => args[k] !== undefined);
        if (extra.length) throw new HttpError(403, `${extra.join(', ')} are Owner's to write: an approval card carries its ask and the merge record only`);
      }
      const board = await getBoard(db, String(args.board || ''));
      if (!board) throw new HttpError(404, `no board ${args.board}`);
      const prefix = board.data.prefix;
      if (!prefix) throw new HttpError(400, `board ${board.id} has no ticket prefix`);
      const { number } = await nextNumber(db, principal, prefix, { approvalCard, counter: clerk });
      const at = nowIso();
      const key = `${prefix}-${number}`;
      const id = `t-${at.slice(0, 10).replace(/-/g, '')}-${prefix.toLowerCase()}-${number}-${slug(args.title, 24)}`;
      const card = {
        board: board.id, key, num: number, title: String(args.title).trim(), status: 'todo', kind,
        lane: kind === 'human' ? '' : laneOf(args.lane), owner: kind === 'agent' ? '' : 'owner', note: '', link: '', needsOwner: kind === 'production' && Number(args.risk) !== 1, waitingOn: '',
        created: at, updated: at, updatedBy: principal,
        history: [{ at, by: principal, what: `created by ${principal} via mcp` }],
      };
      if (args.risk !== undefined) { card.risk = Number(args.risk); card.riskWhy = String(args.riskWhy || '').trim(); }
      if (args.brief && typeof args.brief === 'object') card.brief = args.brief;
      if (Array.isArray(args.doneCriteria)) card.doneCriteria = args.doneCriteria;
      if (args.workType) card.workType = String(args.workType);
      if (Array.isArray(args.skillsRequired)) card.skillsRequired = args.skillsRequired.map(String);
      if (args.priority !== undefined && args.priority !== null) card.priority = priorityNumber(args.priority);
      if (isPlainObject(args.ask)) {
        const a = args.ask;
        card.ask = { kind: a.kind, text: a.text, pr: a.pr || '', by: a.by || '', gates: Array.isArray(a.gates) ? a.gates : [], sha: a.sha || '' };
      }
      if (isPlainObject(args.evidence)) card.evidence = args.evidence;
      if (isPlainObject(args.gates)) card.gates = args.gates;
      const r = await writeTask(db, principal, { op: 'put', id, data: card, what: `created by ${principal} via mcp` }, { approvalCard });
      return { key, id, version: r.version };
    }
    case 'update_card': {
      requireWriter(principal);
      const doc = await cardByKey(db, args.key);
      const patch = args.patch || {};
      const problem = mcpPatchProblem(doc.data, patch, principal);
      if (problem) throw new HttpError(400, problem);
      const at = nowIso();
      const fields = Object.keys(patch).join(', ') || 'nothing';
      const history = [...(Array.isArray(doc.data.history) ? doc.data.history : []), { at, by: principal, what: `updated ${fields} via mcp` }];
      const r = await writeTask(db, principal, {
        op: 'patch', id: doc.id, ifVersion: args.ifVersion,
        data: { ...patch, history, updated: at, updatedBy: principal },
        what: `mcp update_card: ${fields}`,
      });
      return { key: doc.data.key, version: r.version };
    }
    case 'add_comment': {
      requireWriter(principal);
      const text = String(args.text || '').trim();
      if (!text) throw new HttpError(400, 'text is required');
      if (text.length > COMMENT_MAX) throw new HttpError(400, `a comment is at most ${COMMENT_MAX} characters`);
      // A busy card can move between the read and the write; one retry on a version clash.
      for (let attempt = 0; ; attempt++) {
        const doc = await cardByKey(db, args.key);
        if (args.answers === true && !canAnswerMention(doc.data, args.answerId)) {
          throw new HttpError(409, 'answerId does not identify the current open question');
        }
        const comments = [...(Array.isArray(doc.data.comments) ? doc.data.comments : []), { text, ...(args.answers === true ? { answers: true, ...(args.answerId !== undefined ? { answerId: args.answerId } : {}) } : {}) }];
        try {
          const r = await writeTask(db, principal, { op: 'patch', id: doc.id, ifVersion: doc.version, data: { comments }, what: args.answers === true ? 'mention answered via mcp' : 'comment added via mcp' });
          const woke = await mentionRun(env, db, principal, doc.id);
          return { key: doc.data.key, version: woke ? r.version + 1 : r.version, comments: comments.length, ...(woke ? { mention: woke } : {}) };
        } catch (e) {
          if (attempt === 0 && e && e.status === 409) continue;
          throw e;
        }
      }
    }
    case 'release_card': {
      requireWriter(principal);
      if (principal === CLERK) throw new HttpError(403, clerkRefusal('release'));
      const doc = await cardByKey(db, args.key);
      if (doc.data.kind === 'production') throw new HttpError(400, 'a production card starts only on Owner\'s go; it is not released through MCP');
      const at = nowIso();
      const lane = laneOf(args.lane);
      const history = [...(Array.isArray(doc.data.history) ? doc.data.history : []), { at, by: principal, what: `released to ${lane} by ${principal} via mcp` }];
      const r = await writeTask(db, principal, {
        op: 'patch', id: doc.id, ifVersion: doc.version,
        data: { kind: 'agent', lane, status: 'todo', needsOwner: false, ask: null, history, updated: at, updatedBy: principal },
        what: 'mcp release_card',
      });
      return { key: doc.data.key, version: r.version, kind: 'agent', lane, status: 'todo' };
    }
    case 'ask_owner': {
      requireWriter(principal);
      // Every field is set (blank when not given) so a new ask replaces the old one instead of merging into it.
      const ask = { kind: args.kind, text: args.text, pr: args.pr || "", by: args.by || "", gates: Array.isArray(args.gates) ? args.gates : [], sha: args.sha || "" };
      const r = await callTool(env, principal, 'update_card', { key: args.key, patch: { ask }, ifVersion: (await cardByKey(db, args.key)).version });
      const after = await cardByKey(db, args.key);
      return { key: r.key, ask: after.data.ask || null, needsOwner: after.data.needsOwner === true };
    }
    case 'approve_card': {
      if (!isOwnerProxy(principal)) throw new HttpError(403, `approve_card is for Owner and the connectors that speak for him (${PROXY_LIST}); ${principal} raises asks with ask_owner instead.`);
      const doc = await cardByKey(db, args.key);
      const res = await approveCard(env, db, principal, doc.id,
        { decision: args.decision, note: args.note, as: args.as }, env.fetchImpl || fetch);
      const after = await cardByKey(db, args.key);
      const hist = Array.isArray(after.data.history) ? after.data.history : [];
      const last = hist[hist.length - 1];
      return { key: args.key, decision: res.decision, kind: res.kind, ...(res.merged ? { merged: res.merged } : {}), history: last ? last.what : '' };
    }
    case 'rollback_card': {
      if (!isOwnerProxy(principal)) throw new HttpError(403, `rollback_card is for Owner and the connectors that speak for him (${PROXY_LIST})`);
      const doc = await cardByKey(db, args.key);
      const r = await rollbackCard(db, principal, doc.id);
      return { rollbackOf: doc.data.key, key: r.key, id: r.id, ...(r.note ? { note: r.note } : {}) };
    }
    case 'nudge_card': {
      if (!isOwnerProxy(principal)) throw new HttpError(403, `nudge_card is for Owner and the connectors that speak for him (${PROXY_LIST})`);
      const doc = await cardByKey(db, args.key);
      const c = doc.data;
      const action = args.action || 'start';
      if (!['start', 'withdraw'].includes(action)) throw new HttpError(400, 'action must be start or withdraw');
      if ((c.kind || 'human') !== 'agent') throw new HttpError(409, `${c.key} is a ${c.kind || 'human'} card; only agent cards are nudged (release_card first)`);
      if ((c.status || 'todo') !== 'todo') throw new HttpError(409, `${c.key} is ${c.status}; only a card in todo is nudged`);
      if (c.hold) throw new HttpError(409, `${c.key} is on hold`);
      // A card back in todo after a stopped run may be started again; the nudge clears pokedAt so the run fires anew.
      const at = nowIso();
      const who = actorLabel(principal);
      const line = action === 'start' ? `nudged by ${who}: start now` : `nudge withdrawn by ${who}`;
      const history = [...(Array.isArray(c.history) ? c.history : []), { at, by: principal, what: line }];
      const data = action === 'start' ? { nudgedAt: at, pokedAt: '' } : { nudgedAt: '' };
      const r = await writeTask(db, principal, { op: 'patch', id: doc.id, ifVersion: doc.version, data: { ...data, history, updated: at, updatedBy: principal }, what: `mcp nudge_card ${action}` });
      const started = action === 'start' ? await startRun(env, db, principal, doc.id) : null;
      return { key: c.key, version: r.version, nudgedAt: action === 'start' ? at : '', history: line, ...(started || {}) };
    }
    case 'pause_board': {
      if (!isOwnerProxy(principal)) throw new HttpError(403, `pause_board is for Owner and the connectors that speak for him (${PROXY_LIST})`);
      const board = String(args.board || '');
      const r = await setBoardPaused(db, principal, board, args.paused, args.reason);
      // Resume replays nothing: it lists the queued Starts and wakes so the caller decides what to fire.
      const docs = (await listTasks(db, {})).map((d) => d.data).filter((c) => c.status !== 'done');
      const queued = docs.filter((c) => c.board === board && c.nudgedAt && !c.pokedAt && (c.status || 'todo') === 'todo' && !c.hold)
        .map((c) => `${c.key} Start queued`)
        .concat(docs.map((c) => ({ c, m: openMention(c) }))
          .filter(({ c, m }) => m && !m.triedAt && m.to !== 'agent' && (m.to === 'worker' ? 'main' : c.board) === board)
          .map(({ c, m }) => `${c.key} @${m.to} question waiting`))
        // Fired before the pause and not finished yet: the Board run works these even while paused.
        .concat(docs.filter((c) => c.board === board && c.evidence && c.evidence.start && c.evidence.start.state === 'acknowledged' && !c.evidence.run)
          .map((c) => `${c.key} Start fired before the pause, run not yet claimed`))
        .concat(docs.map((c) => ({ c, m: openMention(c) }))
          .filter(({ c, m }) => m && m.triedAt && m.state === 'acknowledged' && (m.to === 'worker' ? 'main' : c.board) === board)
          .map(({ c, m }) => `${c.key} @${m.to} woken before the pause, not yet answered`));
      return { ...r, queued, note: r.paused
        ? 'Paused: new Starts and wakes on this tab are held on their cards. Runs already working go on, and the Claude project jobs are not disabled.'
        : 'Resumed: nothing was fired. The next Start or comment on each queued card fires it as usual.' };
    }
    case 'add_board': {
      if (principal !== 'owner' && principal !== CLERK) throw new HttpError(403, `add_board is for Owner and ${CLERK} only`);
      const id = String(args.id || '');
      if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new HttpError(400, 'id must be 2 to 40 lowercase letters, digits or dashes, starting with a letter');
      const name = String(args.name || '').trim();
      if (!name || name.length > 60) throw new HttpError(400, 'name must be 1 to 60 characters');
      const lane = args.lane === undefined || args.lane === '' ? '*' : String(args.lane);
      if (lane !== '*' && !LANES.includes(lane)) throw new HttpError(400, `lane must be * or one of ${LANES.join('|')}`);
      const p = isPlainObject(args.project) ? args.project : {};
      const project = { name: String(p.name || '').trim(), url: String(p.url || '') };
      const order = (await listBoards(db)).reduce((n, b) => Math.max(n, Number(b.data && b.data.order) || 0), 0) + 1;
      const kind = args.kind === undefined || args.kind === '' ? 'website' : String(args.kind);
      if (!PROJECT_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${PROJECT_KINDS.join('|')}`);
      // A new tab starts as a project: its kind, started today, no target, and the kind's standard milestones (projects.js).
      return createBoard(db, principal, id, { name, prefix: String(args.prefix || ''), order, projects: { [lane]: project }, ...newProjectFields(todayIn(env.BOARD_TZ), kind) });
    }
    case 'delete_card': {
      if (!isOwnerProxy(principal)) throw new HttpError(403, `delete_card is for Owner and the connectors that speak for him (${PROXY_LIST})`);
      const doc = await cardByKey(db, args.key);
      const reason = String(args.reason || '').trim().slice(0, 300);
      await writeTask(db, principal, { op: 'delete', id: doc.id, ifVersion: doc.version, what: `deleted by ${actorLabel(principal)} via mcp${reason ? ': ' + reason : ''}` });
      return { key: doc.data.key, deleted: true, by: principal };
    }
    case 'sync_github': {
      requireWriter(principal);
      return syncText(await syncBoard(env, db, principal, { board: args.board ? String(args.board) : '', key: args.key ? String(args.key) : '', dry: args.dry === true, fetchImpl: env.fetchImpl || fetch }));
    }
    case 'snapshot':
      return buildSnapshot(env, principal, { board: args.board ? String(args.board) : '', github: args.github !== false });
    case 'open_mentions': {
      const lane = args.lane ? String(args.lane).toLowerCase() : '';
      const board = args.board ? String(args.board) : '';
      const docs = await listTasks(db, board ? { board } : {});
      const open = docs.map((d) => d.data).filter((c) => c.status !== 'done')
        .map((c) => ({ c, m: openMention(c) })).filter(({ m }) => m && (lane ? m.to === lane : m.to !== 'agent' && m.to !== 'worker'))
        .sort((x, y) => String(x.m.at).localeCompare(String(y.m.at)));
      const queued = (m) => (Array.isArray(m.next) && m.next.length ? ` (${m.next.length} more waiting after this one)` : '');
      return open.length ? open.map(({ c, m }) => `${c.board} ${c.key} [${c.status}] ${c.title}: @${m.to} asked by ${m.by} at ${m.at} [answerId ${mentionQuestionId(m)}]: ${m.text}${queued(m)}`).join('\n') : `No open mentions${board ? ' on ' + board : ''}${lane ? ' for ' + lane : ''}.`;
    }
    case 'whats_waiting': {
      const docs = await listTasks(db, {});
      const lines = docs.map((d) => d.data).filter((c) => isWaiting(c) || isStale(c) || (c.status !== 'done' && (openMention(c) || (c.ask && c.ask.to === 'agent'))))
        .sort((a, b) => String(a.board).localeCompare(String(b.board)) || (a.num || 0) - (b.num || 0))
        .map((c) => `${c.board}: ${waitingLine(c)}`);
      // The project lines ride along, so "how far along are we" is answered by the same read.
      const projects = (await listBoards(db)).filter((b) => isTracked(b.data)).sort((a, b) => (a.data.order ?? 99) - (b.data.order ?? 99))
        .map((b) => projectLine(b.data.name || b.id, b.data, docs.map((d) => d.data).filter((c) => c.board === b.id), todayIn(env.BOARD_TZ)));
      const head = lines.length ? lines.join('\n') : 'Nothing is waiting.';
      return projects.length ? `${head}\n\nProjects:\n${projects.join('\n')}` : head;
    }
    case 'project_status': {
      const asked = args.board ? String(args.board) : '';
      const boards = await listBoards(db);
      const picked = asked ? boards.filter((b) => b.id === asked) : boards.filter((b) => isTracked(b.data));
      if (asked && !picked.length) throw new HttpError(404, `no board ${asked}`);
      if (!picked.length) return 'No project is tracked yet: a tab becomes a project when it has a kind, dates or milestones.';
      const docs = await listTasks(db, asked ? { board: asked } : {});
      const today = todayIn(env.BOARD_TZ);
      const out = [];
      for (const b of picked.sort((x, y) => (x.data.order ?? 99) - (y.data.order ?? 99))) {
        const cards = docs.map((d) => d.data).filter((c) => c.board === b.id);
        out.push(projectLine(b.data.name || b.id, b.data, cards, today));
        if (asked) out.push(...milestoneLines(b.data, cards, today));
      }
      return out.join('\n');
    }
    case 'activity': {
      const entries = await listActivity(db, { since: args.since ? String(args.since) : '', limit: args.limit || 50, board: args.board ? String(args.board) : '' });
      if (!entries.length) return args.since ? `Nothing changed since ${args.since}.` : 'No activity yet.';
      return entries.map((a) => `${a.at} ${a.who} ${a.key || '(no card)'}: ${a.what}`).join('\n');
    }
    default:
      throw new HttpError(404, `unknown tool ${name}`);
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// body: parsed JSON-RPC request; principal: from the OAuth token. Returns { status, json } or null
// for notifications (202, no body).
// Read by every connector at the start of every session (the MCP initialize result). This is the one
// place the board rules live for bots; keep it short and in plain words. .
export async function handleRpc(env, principal, body) {
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return { status: 400, json: rpcError(body && body.id, -32600, 'Invalid request') };
  }
  if (body.method.startsWith('notifications/')) return null;
  switch (body.method) {
    case 'initialize': {
      const asked = body.params && body.params.protocolVersion;
      return {
        status: 200,
        json: rpcResult(body.id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          serverInfo: SERVER_INFO,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
          instructions: BOARD_INSTRUCTIONS,
        }),
      };
    }
    case 'ping':
      return { status: 200, json: rpcResult(body.id, {}) };
    case 'tools/list':
      return { status: 200, json: rpcResult(body.id, { tools: TOOLS.filter((t) => !CFG.hiddenTools(env).includes(t.name)) }) };
    case 'resources/list':
      return {
        status: 200,
        json: rpcResult(body.id, { resources: [{ uri: HANDBOOK_URI, name: 'Board Handbook', description: 'How this board works. Read once at the start of a session.', mimeType: 'text/markdown' }] }),
      };
    case 'resources/templates/list':
      return { status: 200, json: rpcResult(body.id, { resourceTemplates: [] }) };
    case 'resources/read': {
      const uri = body.params && body.params.uri;
      if (uri !== HANDBOOK_URI) return { status: 200, json: rpcError(body.id, -32002, `Unknown resource ${uri}`) };
      try {
        return { status: 200, json: rpcResult(body.id, { contents: [{ uri: HANDBOOK_URI, mimeType: 'text/markdown', text: handbookText(env) }] }) };
      } catch (err) {
        return { status: 200, json: rpcError(body.id, -32603, err instanceof HttpError ? err.message : 'internal error') };
      }
    }
    case 'tools/call': {
      const name = body.params && body.params.name;
      const args = (body.params && body.params.arguments) || {};
      const startedMs = Date.now();
      // Board Pulse: one log row per call, written after it finishes (pulse.js logCall never throws).
      const record = (outcome, error) => logCall(env, { worker: 'board', principal, tool: name, args, startedMs, outcome, error, words: args.text });
      if (!TOOLS.some((t) => t.name === name)) { await record('error', 'unknown tool'); return { status: 200, json: rpcError(body.id, -32602, `Unknown tool ${name}`) }; }
      try {
        const result = await callTool(env, principal, name, args);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        await record('ok');
        return { status: 200, json: rpcResult(body.id, { content: [{ type: 'text', text }] }) };
      } catch (err) {
        const msg = err instanceof HttpError ? `${err.status}: ${err.message}${Object.keys(err.extra || {}).length ? ` ${JSON.stringify(err.extra)}` : ''}` : 'internal error';
        await record('error', msg);
        return { status: 200, json: rpcResult(body.id, { isError: true, content: [{ type: 'text', text: msg }] }) };
      }
    }
    default:
      return { status: 200, json: rpcError(body.id, -32601, 'Method not found') };
  }
}
