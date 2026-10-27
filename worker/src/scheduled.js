// The scheduled handler body (every ten minutes, the cron in wrangler.toml). Two jobs, each in its own try so one
// failing never stops the other: Board Pulse (claims, retention), then the GitHub sync as principal cron,
// and nothing else. The cron run is logged as one board_mcp_calls row (principal cron,
// tool cron.sync) so it shows in the Pulse stream and connections, and a dead cron is visible.
import { runPulseCron, logCall } from './pulse.js';
import { runSyncCron, syncCronEnabled, CRON } from './sync.js';

// The free plan allows 50 subrequests per invocation, and D1 queries count toward them. Checked against
// https://developers.cloudflare.com/workers/platform/limits/ : it lists 50 subrequests per invocation on Free, and
// defines a subrequest as any request a Worker makes "using the Fetch API or to Cloudflare services like R2, KV,
// or D1". It makes no exception for bindings. So the one run is sized in calls, fetches and D1 queries together:
//   pulse           what its report counts (select, real fetches, one update per verdict, retention delete)
//   sync fixed (4)  cards, stamps read, one batched write of stamps and prune, one slack
//   line fixed (5)  boards, state, messages, cards, one batched state write
//   log row (1)     the cron's board_mcp_calls insert
//   safety (2)      slack
//   card writes     up to 3 for the line facts and 3 for the sync, 3 calls each: a refused write still costs the
//                   read, the batch and the version re-read (runBatch)
//   pull requests   four fetches each, hard capped at SYNC_CAP
// Priority: the sync with one pull request, then the line facts, then card writes, then more pull requests. When
// fewer than 8 calls are left the sync does not run at all (pr 0), and the line facts need 5 more on top of that.
// Cut to fit: the old fixed 11 pull requests per run (now at most 8, and fewer when Pulse is busy), card writes
// per run (a change past the cap waits for the next run), and the per card rotation stamp, now one batched state
// write instead of one card write per read. If Pulse's count is unknown (it threw), the sync takes the worst case:
// one pull request, no card writes.
const LIMIT = 50;
const SAFETY = 2;
const LOG_ROW = 1;
const SYNC_FIXED = 4;
const LINE_FIXED = 5;
const WRITE_COST = 3;
const LINE_WRITES = 3;
const SYNC_WRITES = 3;
const SYNC_CAP = 8;
export function budgetFor(pulseCalls) {
  if (typeof pulseCalls !== 'number' || !Number.isFinite(pulseCalls)) return { pr: 1, syncWrites: 0, lineWrites: 0, line: true };
  const out = { pr: 0, syncWrites: 0, lineWrites: 0, line: false };
  let left = LIMIT - SAFETY - LOG_ROW - pulseCalls;
  if (left < SYNC_FIXED + 4) return out;
  left -= SYNC_FIXED + 4;
  out.pr = 1;
  if (left >= LINE_FIXED) {
    out.line = true;
    left -= LINE_FIXED;
    out.lineWrites = Math.min(LINE_WRITES, Math.floor(left / WRITE_COST));
    left -= WRITE_COST * out.lineWrites;
  }
  out.syncWrites = Math.min(SYNC_WRITES, Math.floor(left / WRITE_COST));
  left -= WRITE_COST * out.syncWrites;
  out.pr += Math.min(SYNC_CAP - 1, Math.floor(left / 4));
  return out;
}
export const syncBudgetFor = (pulseCalls) => budgetFor(pulseCalls).pr;

const say = (log, line) => { try { log(line); } catch { /* logging never breaks the run */ } };
const why = (err) => (err && err.message ? err.message : String(err));

export async function runScheduled(env, opts = {}) {
  const log = opts.log || ((line) => console.log(line));
  const out = { pulse: null, sync: null, line: null, errors: [] };

  // Calls the Pulse job used: 0 when it is off, its own count when it ran, unknown (undefined) when it threw.
  let pulseCalls;
  try {
    out.pulse = await runPulseCron(env, opts);
    pulseCalls = out.pulse.skipped ? 0 : (out.pulse.calls === null ? undefined : out.pulse.calls);
    say(log, `board cron pulse: ${out.pulse.skipped ? 'skipped' : `claims looked ${out.pulse.claims.looked}, written ${out.pulse.claims.written}, deleted ${out.pulse.deleted}`}`);
  } catch (err) {
    say(log, `board cron pulse failed: ${why(err)}`);
  }
  const budget = budgetFor(pulseCalls);

  const startedMs = Date.now();
  let ranSync = false;
  if (syncCronEnabled(env)) {
    ranSync = true;
    try {
      out.sync = budget.pr > 0 ? await runSyncCron(env, { ...opts, max: budget.pr, maxWrites: budget.syncWrites }) : { skipped: true };
      say(log, out.sync.skipped === true ? 'board cron sync: skipped' : `board cron sync: ${out.sync.checked} read, ${out.sync.changed.length} changed, ${out.sync.unchanged} matched, ${out.sync.unreadable.length} unreadable, ${out.sync.skipped || 0} cut by the cap`);
      if (out.sync.stateError) out.errors.push(`sync: ${out.sync.stateError}`);
    } catch (err) {
      out.errors.push(`sync: ${why(err)}`);
      say(log, `board cron sync failed: ${why(err)}`);
    }
  }
  if (ranSync) {
    await logCall(env, { worker: 'board', principal: CRON, tool: 'cron.sync', args: {}, outcome: out.errors.length ? 'error' : 'ok', error: out.errors.join('; '), startedMs });
  }
  return out;
}
