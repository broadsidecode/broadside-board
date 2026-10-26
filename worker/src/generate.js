// Plain words to a full board card, on Workers AI. The one copy of the generator prompt lives here;
// the page only calls POST /api/v1/generate and keeps its own normalize step before saving.
import { HttpError, getBoard } from './store.js';
import { priorityNumber } from './lib.js';

export const WORK_TYPES = ['newPage', 'copyChange', 'deploy', 'review', 'microEdit', 'infra'];
export const MAX_TEXT = 4000;
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
import { DEFAULT_LANE } from './config.js';
const DEFAULT_ROLES = { coordinator: DEFAULT_LANE, builder: 'builder', reviewer: 'reviewer', deployer: 'deployer' };
// No skill defaults in the kit: a work type carries no required skills until you add some.
const SKILLS_BY_WORK_TYPE = { newPage: [], copyChange: [], deploy: [], review: [], microEdit: [], infra: [] };

export function buildPrompt(text, kind, boardName, prefix) {
  const kindWords = kind === 'production'
    ? 'Production: it touches something live and starts only after the owner gives the go.'
    : kind === 'agent'
      ? 'Agent: released to the agent, who builds it.'
      : 'Human: the owner keeps it until the owner releases it.';
  return [
    'You write task cards for the Board, the task board an owner and an AI agent use to run their work. This card is for the board tab named "' + boardName + '" (card keys start with ' + prefix + '). Card kind: ' + kindWords,
    '',
    'Owner described the task like this:',
    '"""', text, '"""',
    '',
    'Reply with only one JSON object in exactly this shape, no explanation and no code fence:',
    '{"title": string, "brief": {"objective": string, "spec": string, "scope": string, "outOfScope": string, "requirements": [string], "files": [string], "constraints": [string], "context": [{"label": string, "url": string}]}, "workType": string, "doneCriteria": [{"text": string}], "testSteps": [string], "expected": string, "priority": string, "roles": {"coordinator": "lane1", "builder": "builder", "reviewer": "reviewer", "deployer": "deployer"}}',
    '',
    'Rules:',
    '1. Use only what the description says or clearly implies. Do not invent scope, pages, features, files, links, prices or customer details. When the description does not support a field, use "" or [].',
    '2. title: plain words, under 80 characters.',
    '3. objective: one sentence on the result. spec: a few short paragraphs on what to build or change. scope and outOfScope: one or two sentences each.',
    '4. doneCriteria: 3 to 6 items. Each is concrete and testable by looking at the site, the preview or the repository.',
    '5. testSteps: short steps a reviewer follows. expected: what the reviewer should see when it works.',
    '6. files: only paths named in the description. context: only links present in the description.',
    '7. priority: one of the words urgent, normal or low. Use normal unless the description says otherwise.',
    '8. roles: keep coordinator ' + DEFAULT_ROLES.coordinator + ', builder ' + DEFAULT_ROLES.builder + ', reviewer ' + DEFAULT_ROLES.reviewer + ', deployer ' + DEFAULT_ROLES.deployer + ' unless the description names someone else.',
    '9. Write plain words a small business owner would understand. Never use dashes of any kind in visible text; use commas or separate sentences instead.',
    '10. workType: exactly one of ' + WORK_TYPES.join(', ') + '. newPage is a new page or section (the default for site work). copyChange is wording only with no layout change. deploy is readying or checking a deploy. review is a review verdict. microEdit is a tiny fix such as a typo, a phone number or one word. infra is repository, tooling, rules or workflow work. Pick the best fit.',
  ].join('\n');
}

// Model reply to a JS object. Tolerates code fences and a leading or trailing explanation.
export function parseCard(reply) {
  if (reply && typeof reply === 'object') return reply;
  let s = String(reply == null ? '' : reply).trim();
  s = s.replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const strList = (v) => (Array.isArray(v) ? v : [])
  .map((x) => (x && typeof x === 'object' ? x.text || x.label || '' : x))
  .map((x) => String(x == null ? '' : x).trim()).filter(Boolean);

// Checks and tidies the shape the page expects. Returns null when it is not a usable card.
export function validateCard(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const b = o.brief && typeof o.brief === 'object' && !Array.isArray(o.brief) ? o.brief : {};
  const doneCriteria = strList(o.doneCriteria).slice(0, 6).map((text) => ({ text }));
  if (!title || !doneCriteria.length) return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const wt = String(o.workType || '').trim();
  const roles = o.roles && typeof o.roles === 'object' && !Array.isArray(o.roles) ? o.roles : {};
  // The model answers with a word (urgent, normal, low); an older number still reads as itself.
  const pr = priorityNumber(o.priority);
  const role = (k) => {
    const r = roles[k];
    const name = typeof r === 'string' ? r : (r && r.name) || '';
    return name || DEFAULT_ROLES[k];
  };
  const workType = WORK_TYPES.find((k) => k.toLowerCase() === wt.toLowerCase()) || 'newPage';
  return {
    title: title.slice(0, 160),
    note: str(b.objective).slice(0, 240),
    brief: {
      objective: str(b.objective), spec: str(b.spec), scope: str(b.scope), outOfScope: str(b.outOfScope),
      requirements: strList(b.requirements), files: strList(b.files), constraints: strList(b.constraints),
      context: (Array.isArray(b.context) ? b.context : []).filter((c) => c && typeof c === 'object')
        .map((c) => ({ label: str(c.label), url: str(c.url) })).filter((c) => c.label || c.url),
    },
    workType,
    skillsRequired: [...SKILLS_BY_WORK_TYPE[workType]],
    doneCriteria,
    testSteps: strList(o.testSteps),
    expected: str(o.expected),
    priority: pr > 0 ? Math.round(pr) : 100,
    roles: Object.fromEntries(Object.keys(DEFAULT_ROLES).map((k) => [k, role(k)])),
  };
}

// Best effort per isolate limit: 12 generations per principal per minute. Not a hard guarantee.
const hits = new Map();
export function rateLimited(principal, now = Date.now()) {
  const recent = (hits.get(principal) || []).filter((t) => now - t < 60000);
  if (recent.length >= 12) { hits.set(principal, recent); return true; }
  recent.push(now); hits.set(principal, recent);
  return false;
}

export async function generateCard(env, principal, body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new HttpError(400, 'text is required');
  if (text.length > MAX_TEXT) throw new HttpError(413, `text is over ${MAX_TEXT} characters`);
  const kind = ['human', 'agent', 'production'].includes(body.kind) ? body.kind : 'agent';
  if (!env.AI) throw new HttpError(502, 'the generator is not available');
  if (rateLimited(principal)) throw new HttpError(429, 'too many requests, try again in a minute');
  let boardName = String(body.board || 'Board');
  let prefix = 'KIT';
  try {
    const b = body.board ? await getBoard(env.DB, String(body.board)) : null;
    if (b && b.data) { boardName = b.data.name || boardName; prefix = b.data.prefix || prefix; }
  } catch { /* the board lookup only colors the prompt */ }
  let out;
  try {
    out = await env.AI.run(env.GENERATOR_MODEL || DEFAULT_MODEL, {
      messages: [
        { role: 'system', content: 'You turn plain task descriptions into JSON task cards. Reply with one JSON object only.' },
        { role: 'user', content: buildPrompt(text, kind, boardName, prefix) },
      ],
      max_tokens: 2200,
      temperature: 0.2,
    });
  } catch (err) {
    console.error('generate error', err && err.message ? err.message : String(err));
    throw new HttpError(502, 'the generator failed, try again');
  }
  const raw = out && typeof out === 'object' && 'response' in out ? out.response : out;
  const card = validateCard(parseCard(raw));
  if (!card) throw new HttpError(502, 'the generator returned an unusable card, try again');
  return { card };
}
