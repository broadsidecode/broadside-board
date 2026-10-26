// Board kit configuration, compiled into the Worker. `node setup.js` rewrites CONFIG below from
// board.config.json; edit board.config.json and run `node setup.js --apply-config` to change it later.
// Secrets never live here. Tests may replace the whole object through globalThis.__BOARD_CONFIG__.
const CONFIG = {
  // Who the board is for. The human is always the principal `owner`; the main AI agent is always `agent`.
  owner: { name: 'Owner' },
  agent: { label: 'Agent' },
  // Extra connectors that speak for the owner, each with its own principal id and label.
  agents: [],
  // Writer principals that are not connectors, such as a workflow or a runner. They need a token.
  workers: [],
  // Writers that must carry a board scope (name@board) to be accepted.
  scopedWorkers: [],
  // Principals besides the owner that may delete cards and seed versions.
  admins: [],
  // Names an @mention can address. Mentions only wake an agent when the Start module is wired.
  mentionNames: ['agent'],
  // The lanes an agent card can sit in. The first one is the default.
  lanes: ['main'],
  // Names an ask may be signed with (the role that raised it), besides the connectors.
  roles: ['reviewer'],
  // GitHub organizations or users whose pull requests the board accepts. Empty turns the GitHub module off.
  githubOrgs: [],
  // Modules the page and the tool list show. Each is off until the owner turns it on.
  modules: { start: false, github: false, production: false, generate: false, tabs: false },
};

export const cfg = { ...CONFIG, ...(globalThis.__BOARD_CONFIG__ || {}) };

const uniq = (list) => [...new Set(list)];
const ids = (list) => (Array.isArray(list) ? list : []).map((a) => (typeof a === 'string' ? a : a && a.id)).filter(Boolean);

export const OWNER_ID = 'owner';
export const CLERK_ID = 'agent';
// The names the owner speaks through: the owner, the main agent and any extra connector.
export const PROXIES = uniq([OWNER_ID, CLERK_ID, ...ids(cfg.agents)]);
export const WRITERS = uniq([...PROXIES, ...ids(cfg.workers)]);
export const ADMINS = uniq([OWNER_ID, ...ids(cfg.admins)]);
export const SCOPED_WORKERS = uniq(ids(cfg.scopedWorkers));
export const MENTION_NAMES = uniq(ids(cfg.mentionNames));
export const LANES = uniq(ids(cfg.lanes));
export const ROLE_BY = uniq([...ids(cfg.roles), ...PROXIES]);
export const GITHUB_ORGS = uniq(ids(cfg.githubOrgs));
// The consent page offers these connector names. The owner is last so an agent is the first choice.
export const MCP_PRINCIPALS = uniq([CLERK_ID, ...ids(cfg.agents), OWNER_ID]);
export const MODULES = cfg.modules || {};
export const DEFAULT_LANE = LANES[0] || 'main';

// Tools that belong to a module. They stay callable, but are left out of tools/list while the module is off.
// env.BOARD_MODULES (a JSON var) overrides the compiled setting; an env without it shows every tool (tests).
export const MODULE_TOOLS = {
  start: ['nudge_card', 'pause_board'],
  github: ['sync_github'],
  generate: ['generate_card'],
  tabs: ['add_board'],
};
export function hiddenTools(env) {
  let mods = null;
  try { mods = env && env.BOARD_MODULES ? JSON.parse(env.BOARD_MODULES) : null; } catch { mods = null; }
  if (!mods) return [];
  return Object.entries(MODULE_TOOLS).filter(([m]) => !mods[m]).flatMap(([, tools]) => tools);
}
// What the page may know before anyone signs in: labels and flags only, no addresses or secrets.
export function publicConfig(env) {
  let mods = MODULES;
  try { if (env && env.BOARD_MODULES) mods = JSON.parse(env.BOARD_MODULES); } catch { /* compiled modules stay */ }
  return {
    owner: { name: String((cfg.owner && cfg.owner.name) || 'Owner') },
    agent: { label: String((cfg.agent && cfg.agent.label) || 'Agent') },
    agents: (Array.isArray(cfg.agents) ? cfg.agents : []).map((a) => ({ id: typeof a === 'string' ? a : a.id, label: typeof a === 'string' ? a : a.label || a.id })),
    lanes: LANES,
    mentionNames: MENTION_NAMES,
    modules: mods,
  };
}
