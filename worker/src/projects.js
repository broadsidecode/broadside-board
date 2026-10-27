// Projects, milestones and the portfolio. Pure helpers shared by the API, the MCP endpoint and the snapshot; no I/O.
// A tab (board) is a project. It may carry kind, start, target and an ordered list of milestones. A card may name one
// milestone of its own tab. A milestone's status and the project percent are always derived from the cards, never
// stored, so they cannot drift from the work.

export const PROJECT_KINDS = ['website', 'product', 'internal'];
export const PROJECT_FIELDS = ['kind', 'start', 'target', 'milestones'];
export const MILESTONES_MAX = 30;
export const MILESTONE_NAME_MAX = 60;
export const MILESTONE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function milestoneSlug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'milestone';
}

// The standard milestones of a kind. Only websites have a template today; product and internal tabs are free form.
export const WEBSITE_MILESTONE_NAMES = ['Intake', 'Design chosen', 'Content in', 'Build', 'Preview approved', 'Live', 'Handoff'];
export function templateFor(kind) {
  return kind === 'website' ? WEBSITE_MILESTONE_NAMES.map((name) => ({ id: milestoneSlug(name), name, start: '', end: '' })) : [];
}

// The project fields a new customer tab starts with: a website, started today, no target, the standard milestones.
export function newProjectFields(today, kind = 'website') {
  return { kind, start: today, target: '', milestones: templateFor(kind) };
}

export function validDate(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// null when the project fields on a board record are fine, else the reason. Absent fields are fine.
export function projectProblem(board) {
  if (board.kind !== undefined && !PROJECT_KINDS.includes(board.kind)) return `board kind must be one of ${PROJECT_KINDS.join('|')}`;
  for (const f of ['start', 'target']) {
    if (board[f] !== undefined && board[f] !== '' && board[f] !== null && !validDate(board[f])) return `board ${f} must be a date such as 2026-11-03, or empty`;
  }
  if (board.milestones === undefined) return null;
  if (!Array.isArray(board.milestones)) return 'board milestones must be a list';
  if (board.milestones.length > MILESTONES_MAX) return `a board holds at most ${MILESTONES_MAX} milestones`;
  const seen = new Set();
  for (const m of board.milestones) {
    if (!isObj(m)) return 'each milestone is {id, name, start, end}';
    if (!MILESTONE_ID.test(String(m.id || ''))) return 'a milestone id is lowercase letters, digits and dashes, such as preview-approved';
    if (seen.has(m.id)) return `milestone id ${m.id} appears twice`;
    seen.add(m.id);
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > MILESTONE_NAME_MAX) return `milestone ${m.id} needs a name of 1 to ${MILESTONE_NAME_MAX} characters`;
    for (const f of ['start', 'end']) {
      if (m[f] !== undefined && m[f] !== '' && m[f] !== null && !validDate(m[f])) return `milestone ${m.id} ${f} must be a date such as 2026-11-03, or empty`;
    }
    if (m.start && m.end && m.end < m.start) return `milestone ${m.id} ends before it starts`;
  }
  return null;
}

export const milestonesOf = (board) => (board && Array.isArray(board.milestones) ? board.milestones.filter((m) => isObj(m) && m.id) : []);
export const milestoneIds = (board) => milestonesOf(board).map((m) => m.id);

// A board record is tracked as a project when it names a kind, a date or a milestone.
export const isTracked = (board) => !!board && (!!board.kind || !!board.start || !!board.target || milestonesOf(board).length > 0);

// True when the two board records differ only in the project fields (and the pause switch, which the store keeps).
const IGNORED = [...PROJECT_FIELDS, 'paused', 'pauseSetBy', 'pauseSetAt', 'pauseReason'];
export function onlyProjectFieldsChanged(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})].filter((k) => !IGNORED.includes(k)));
  for (const k of keys) if (JSON.stringify((before || {})[k]) !== JSON.stringify((after || {})[k])) return false;
  return true;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(s) {
  return validDate(s) ? `${MONTHS[Number(s.slice(5, 7)) - 1]} ${Number(s.slice(8, 10))}` : '';
}
export const todayOf = (now = new Date()) => new Date(now).toISOString().slice(0, 10);
// Today as YYYY-MM-DD in one fixed zone (the BOARD_TZ variable), so the Worker and the page agree on late. An unknown
// or missing zone falls back to UTC.
export function todayIn(tz, now = new Date()) {
  try {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    return DATE.test(day) ? day : todayOf(now);
  } catch { return todayOf(now); }
}

// Derived numbers for one tab. board is the board record (data), cards the card records (data) of that tab.
// Statuses: done (every card done, at least one), late (end date passed with open cards), notstarted (no card past
// todo), inprogress. A milestone with no cards is notstarted: with no open cards it can never read late or done.
export function projectStats(board, cards, today) {
  const live = (cards || []).filter((c) => c && c.deleted !== true);
  const ms = milestonesOf(board);
  const known = new Set(ms.map((m) => m.id));
  const rows = ms.map((m) => {
    const mine = live.filter((c) => c.milestone === m.id);
    const done = mine.filter((c) => c.status === 'done').length;
    const blocked = mine.filter((c) => c.status === 'blocked').length;
    const open = mine.length - done;
    const started = mine.some((c) => (c.status || 'todo') !== 'todo');
    let status;
    if (mine.length > 0 && open === 0) status = 'done';
    else if (m.end && m.end < today && open > 0) status = 'late';
    else if (!started) status = 'notstarted';
    else status = 'inprogress';
    return { id: m.id, name: m.name, start: m.start || '', end: m.end || '', total: mine.length, done, blocked, status };
  });
  const total = live.length;
  const done = live.filter((c) => c.status === 'done').length;
  const blocked = live.filter((c) => c.status === 'blocked').length;
  const percent = total ? Math.round((100 * done) / total) : 0;
  const noMilestone = live.filter((c) => !c.milestone || !known.has(c.milestone)).length;
  const next = rows.find((r) => r.status !== 'done') || null;
  const target = board && validDate(board.target) ? board.target : '';
  const late = !!target && target < today && total > done;
  return { milestones: rows, total, done, blocked, open: total - done, percent, noMilestone, next, target, start: board && validDate(board.start) ? board.start : '', late };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The project in words, one line: "Acme Plumbing: 62 percent, Build 9 of 11 (1 blocked), Preview approved not started,
// target Nov 3, 3 cards with no milestone".
export function projectLine(name, board, cards, today) {
  const s = projectStats(board, cards, today);
  const bits = [`${s.percent} percent`];
  if (!s.milestones.length) {
    bits.push(`${s.done} of ${plural(s.total, 'card')} done${s.blocked ? ` (${s.blocked} blocked)` : ''}`);
  } else {
    const moving = s.milestones.filter((m) => m.status === 'inprogress' || m.status === 'late');
    for (const m of moving) bits.push(`${m.name} ${m.done} of ${m.total}${m.blocked ? ` (${m.blocked} blocked)` : ''}${m.status === 'late' ? ' late' : ''}`);
    const idle = s.milestones.find((m) => m.status === 'notstarted');
    if (idle) bits.push(`${idle.name} not started`);
    if (!moving.length && !idle) bits.push('every milestone done');
  }
  if (s.target) bits.push(`target ${shortDate(s.target)}${s.late ? ' (late)' : ''}`);
  if (s.noMilestone > 0 && s.milestones.length) bits.push(`${plural(s.noMilestone, 'card')} with no milestone`);
  return `${name}: ${bits.join(', ')}`;
}

// One line per milestone for project_status.
export function milestoneLines(board, cards, today) {
  return projectStats(board, cards, today).milestones.map((m) => {
    const word = { done: 'done', late: 'late', notstarted: 'not started', inprogress: 'in progress' }[m.status];
    const dates = m.start || m.end ? `, ${m.start ? shortDate(m.start) : 'no start'} to ${m.end ? shortDate(m.end) : 'no end'}` : '';
    return `  ${m.name}: ${word}, ${m.done} of ${plural(m.total, 'card')} done${m.blocked ? `, ${m.blocked} blocked` : ''}${dates}`;
  });
}

// The portfolio: one row per tab, in tab order. boards are board documents ({id, data}); cards are card records.
export function portfolioRows(boards, cards, today) {
  return [...boards].sort((a, b) => (a.data.order ?? 99) - (b.data.order ?? 99)).map((b) => {
    const mine = cards.filter((c) => c.board === b.id);
    const s = projectStats(b.data, mine, today);
    return {
      board: b.id, name: b.data.name || b.id, kind: b.data.kind || '', tracked: isTracked(b.data),
      percent: s.percent, cards: { total: s.total, done: s.done, open: s.open, blocked: s.blocked },
      start: s.start, target: s.target, late: s.late,
      milestones: s.milestones.map((m) => ({ id: m.id, name: m.name, status: m.status, done: m.done, total: m.total, blocked: m.blocked, start: m.start, end: m.end })),
      next: s.next ? { id: s.next.id, name: s.next.name, status: s.next.status } : null,
      noMilestone: s.noMilestone,
      line: projectLine(b.data.name || b.id, b.data, mine, today),
    };
  });
}
