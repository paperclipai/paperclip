/**
 * Local red/green proof for two recovery checks:
 *
 * - `workspace-recovery`: `nextWorkspaceRecoveryAt` (the workspace recovery
 *   worker's next deadline) and the fallback/stop-proof conditions it shares
 *   with worker discovery (`workspace-recovery-fallback-discovery.ts`).
 * - `dropped-comments`: `checkStaleDroppedComments` in the ownership
 *   invariant report.
 *
 * Loads the changed files from an explicit pre-change revision and from the
 * working tree, runs both against the same synthetic PostgreSQL fixture, and
 * asserts that the complete results are equal before timing anything. The
 * workspace recovery proof also compares every condition the change touched,
 * for every recovery action of the fixture.
 *
 *   pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-recovery-status-checks.ts --baseline-ref=<commit>
 *
 * Options: --fixture=<name> (repeatable), --samples=<n>, --skip-hash-plan, --out=<file>.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createDb, issueRecoveryActions, startEmbeddedPostgresTestDatabase, type Db } from "../packages/db/src/index.js";
import * as schema from "../packages/db/src/schema/index.js";

// Resolve database drivers through the db package; the scripts folder has no own dependencies.
const dbRequire = createRequire(new URL("../packages/db/package.json", import.meta.url));
const postgres = (await import(pathToFileURL(dbRequire.resolve("postgres")).href)).default as typeof import("postgres").default;
const { drizzle } = await import(pathToFileURL(dbRequire.resolve("drizzle-orm/postgres-js")).href) as typeof import("drizzle-orm/postgres-js");
const { sql } = await import(pathToFileURL(dbRequire.resolve("drizzle-orm")).href) as typeof import("drizzle-orm");

const baselineRef = process.argv.find(value => value.startsWith("--baseline-ref="))?.slice(15);
assert.ok(baselineRef, "Pass an explicit pre-change --baseline-ref=<commit>");
// Run every git command from the repository root: the documented command runs from server/.
const root = fileURLToPath(new URL("../", import.meta.url));
const baselineRevision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding: "utf8", cwd: root }).trim();
const samplesPerArm = Number(process.argv.find(value => value.startsWith("--samples="))?.slice(10) ?? 5);
const changedSources = [
  "server/src/services/recovery/ownership-invariant-report.ts",
  "server/src/services/workspace-recovery-fallback-discovery.ts",
];
// Every other helper the checks import must be unchanged, or the baseline is contaminated.
const changedRuntime = execFileSync("git", ["diff", "--name-only", baselineRevision, "--",
  "server/src/services", "packages/db/src", "packages/shared/src", "pnpm-lock.yaml"], { encoding: "utf8", cwd: root })
  .trim().split("\n").filter(Boolean);
assert.deepEqual(changedRuntime.filter(file => !changedSources.includes(file) && !file.endsWith(".test.ts")), [],
  "The baseline must not import changed runtime helpers");

// Copy the baseline version of each changed file. A relative import of another
// changed file points at its baseline copy; every other import points at the
// working tree, which the check above proves unchanged.
const baselineDir = await fs.mkdtemp(path.join(root, "server/scripts/.recovery-status-baseline-"));
const copyName = (source: string) => source.replaceAll("/", "__");
for (const source of changedSources) {
  const text = execFileSync("git", ["show", `${baselineRevision}:${source}`], { encoding: "utf8", cwd: root });
  const original = new URL(`../${source}`, import.meta.url);
  const rewritten = text.replace(/from "(\.{1,2}\/[^"]+)"/g, (_match, specifier: string) => {
    const target = fileURLToPath(new URL(specifier, original));
    const relative = path.relative(root, target).replace(/\.js$/, ".ts");
    return `from ${JSON.stringify(changedSources.includes(relative) ? path.join(baselineDir, copyName(relative)) : target)}`;
  });
  await fs.writeFile(path.join(baselineDir, copyName(source)), rewritten);
}
type Report = typeof import("../server/src/services/recovery/ownership-invariant-report.js");
type Discovery = typeof import("../server/src/services/workspace-recovery-fallback-discovery.js");
type DroppedCheck = (db: Db, now: Date, limit: number) => Promise<unknown>;
const load = async <T>(source: string) => await import(pathToFileURL(path.join(baselineDir, copyName(source))).href) as T;
// The baseline did not export the dropped-comment check; expose it for the benchmark only.
const reportCopy = path.join(baselineDir, copyName(changedSources[0]!));
const reportText = await fs.readFile(reportCopy, "utf8");
if (!/export async function checkStaleDroppedComments/.test(reportText)) {
  await fs.writeFile(reportCopy, `${reportText}\nexport { checkStaleDroppedComments };\n`);
}
const baselineReport = await load<Report>(changedSources[0]!);
const baselineDiscovery = await load<Discovery>(changedSources[1]!);
const treatmentReport = await import("../server/src/services/recovery/ownership-invariant-report.js") as Report;
const treatmentDiscovery = await import("../server/src/services/workspace-recovery-fallback-discovery.js") as Discovery;
const { nextWorkspaceRecoveryAt: treatmentNext } = await import("../server/src/services/system-recovery.js");

// nextWorkspaceRecoveryAt builds its statement from the discovery module. The
// baseline arm is the same statement built from the baseline discovery copy:
// load a copy of system-recovery.ts whose discovery import is the baseline.
const systemSource = "server/src/services/system-recovery.ts";
assert.ok(!changedRuntime.includes(systemSource));
{
  const text = await fs.readFile(path.join(root, systemSource), "utf8");
  const original = new URL(`../${systemSource}`, import.meta.url);
  const rewritten = text.replace(/from "(\.{1,2}\/[^"]+)"/g, (_match, specifier: string) => {
    const target = fileURLToPath(new URL(specifier, original));
    const relative = path.relative(root, target).replace(/\.js$/, ".ts");
    return `from ${JSON.stringify(changedSources.includes(relative) ? path.join(baselineDir, copyName(relative)) : target)}`;
  });
  await fs.writeFile(path.join(baselineDir, copyName(systemSource)), rewritten);
}
const { nextWorkspaceRecoveryAt: baselineNext } = await load<typeof import("../server/src/services/system-recovery.js")>(systemSource);

type Fixture = { name: string; check: "workspace-recovery" | "dropped-comments"; [key: string]: number | string };
const fixtures: Fixture[] = [
  // Workspace recovery: actions per company (most complete), runs per company, finalizers and leases.
  { name: "recovery-small", check: "workspace-recovery", actions: 200, runs: 5_000, contextBytes: 1_024, evidenceBytes: 512 },
  // A busy instance after restart waves: a few thousand recovery actions, most
  // complete, a few hundred exhausted holds that stay active, deep run history.
  { name: "recovery-representative", check: "workspace-recovery", actions: 3_000, runs: 60_000, contextBytes: 2_048, evidenceBytes: 1_024 },
  // The same actions over a deeper run history. The baseline grows with holds times runs per company.
  { name: "recovery-deep-history", check: "workspace-recovery", actions: 3_000, runs: 150_000, contextBytes: 2_048, evidenceBytes: 1_024 },
  // Dropped comments: recent user comments on done tasks over a deep run history.
  { name: "dropped-small", check: "dropped-comments", issues: 300, runs: 3_000, hotIssues: 30, commentsPerHotIssue: 2, contextBytes: 1_024 },
  { name: "dropped-representative", check: "dropped-comments", issues: 4_000, runs: 60_000, hotIssues: 300, commentsPerHotIssue: 3, contextBytes: 4_096 },
  { name: "dropped-busy-hour", check: "dropped-comments", issues: 6_000, runs: 120_000, hotIssues: 1_500, commentsPerHotIssue: 3, contextBytes: 2_048 },
];

const keepAlive = setInterval(() => {}, 1000);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const spread = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) });
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: Db | undefined;
let captureClient: import("postgres").Sql | undefined;

/** Synthetic, incompressible text of about `bytes` characters (md5 hex chain). */
const filler = (bytes: number, seed: string) =>
  `(select string_agg(md5(${seed}::text || ':' || g::text), '') from generate_series(1, ${Math.max(1, Math.ceil(bytes / 32))}) g)`;

async function seedCompany(db: Db, scale: number, prefixSeed: string, issueCount: number) {
  const run = (text: string, params: unknown[] = []) => db.$client.unsafe(text, params as never[]);
  const company = randomUUID();
  const prefix = `B${prefixSeed}${company.slice(0, 5).toUpperCase()}`;
  await run(`insert into companies (id, name, issue_prefix) values ($1::uuid, 'Synthetic', $2)`, [company, prefix]);
  await run(`insert into agents (company_id, name, adapter_type) select $1::uuid, 'agent-' || n, 'codex_local' from generate_series(1, 20) n`, [company]);
  await run(`create temp table if not exists bench_agents (company_id uuid, n int, id uuid)`);
  await run(`insert into bench_agents select company_id, row_number() over (order by id), id from agents where company_id = $1::uuid`, [company]);
  await run(`insert into issues (company_id, title, status, assignee_agent_id, identifier, issue_number)
    select $1::uuid, 'I-' || s.num, (array['done','done','todo','in_progress','done','cancelled','todo','in_progress','done','todo'])[1 + s.num % 10],
      (select a.id from bench_agents a where a.company_id = $1::uuid and a.n = 1 + s.num % 20), $2 || '-' || s.num, s.num
    from generate_series(1, $3::int) s(num)`, [company, prefix, Math.ceil(issueCount * scale)]);
  await run(`create temp table if not exists bench_issues (company_id uuid, n int, id uuid, agent_id uuid)`);
  await run(`insert into bench_issues select company_id, issue_number, id, assignee_agent_id from issues where company_id = $1::uuid`, [company]);
  return company;
}

/** Run history over 14 days: legacy runs bind by context, native runs by column, some by both. */
async function seedRunHistory(db: Db, company: string, now: Date, runCount: number, issueCount: number, contextBytes: number) {
  await db.$client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, invocation_source, native_issue_id, context_snapshot,
      runner_profile_json, created_at, started_at, finished_at)
    select $1::uuid, i.agent_id, (array['succeeded','failed','cancelled','succeeded','timed_out'])[1 + r % 5], 'assignment',
      case when r % 3 <> 0 then i.id end,
      case when r % 3 = 1 then '{}'::jsonb else jsonb_build_object('issueId', i.id::text, 'prompt', ${filler(contextBytes, "r")}) end,
      jsonb_build_object('remoteWorkspace', jsonb_build_object('state', case when r % 4 = 0 then 'prepared' else 'released' end)),
      $2::timestamptz - interval '2 hours' - (r * interval '14 days' / $3::int), $2::timestamptz - interval '2 hours' - (r * interval '14 days' / $3::int),
      $2::timestamptz - interval '2 hours' - (r * interval '14 days' / $3::int) + interval '20 minutes'
    from generate_series(1, $3::int) r join bench_issues i on i.company_id = $1::uuid and i.n = 1 + (r * 7919) % $4::int`,
    [company, now.toISOString(), runCount, issueCount] as never[]);
}

async function seedWorkspaceRecovery(db: Db, fixture: Fixture, now: Date) {
  const run = (text: string, params: unknown[] = []) => db.$client.unsafe(text, params as never[]);
  const actionsTotal = Number(fixture.actions), runsTotal = Number(fixture.runs);
  for (const [scale, tag] of [[1, "A"], [0.25, "B"]] as const) {
    const actionCount = Math.ceil(actionsTotal * scale), runCount = Math.ceil(runsTotal * scale);
    // Each recovery action has its own task; ordinary tasks carry the run history.
    const issueCount = actionCount + Math.ceil(runCount / 15);
    const company = await seedCompany(db, 1, tag, issueCount);
    await seedRunHistory(db, company, now, runCount, issueCount, Number(fixture.contextBytes));
    // Finalizers for a third of the history, some still leased.
    await run(`insert into native_run_finalizations (run_id, company_id, issue_id, phase, lease_owner, lease_expires_at)
      select r.id, r.company_id, coalesce(r.native_issue_id, (r.context_snapshot->>'issueId')::uuid), 'completed',
        case when row_number() over () % 7 = 0 then 'owner' end, $2::timestamptz + interval '10 minutes'
      from heartbeat_runs r where r.company_id = $1::uuid and r.native_issue_id is not null and r.created_at::text like '%3%'`,
      [company, now.toISOString()]);
    await run(`insert into environment_leases (company_id, heartbeat_run_id, issue_id, lease_policy, updated_at)
      select r.company_id, r.id, r.native_issue_id, 'retain_on_failure',
        r.finished_at from heartbeat_runs r where r.company_id = $1::uuid and r.native_issue_id is not null and r.created_at::text like '%7%'`,
      [company]);
    // Source runs of the recovery actions: one failed native run per action task.
    await run(`insert into heartbeat_runs (company_id, agent_id, status, invocation_source, native_issue_id, context_snapshot,
        runner_profile_json, created_at, started_at, finished_at)
      select i.company_id, i.agent_id, 'failed', 'assignment', i.id, jsonb_build_object('issueId', i.id::text),
        jsonb_build_object('remoteWorkspace', jsonb_build_object('state', case when i.n % 3 = 0 then 'released' else 'prepared' end)),
        $2::timestamptz - (i.n * interval '1 minute'), $2::timestamptz - (i.n * interval '1 minute'), $2::timestamptz - (i.n * interval '1 minute') + interval '5 minutes'
      from bench_issues i where i.company_id = $1::uuid and i.n <= $3::int`, [company, now.toISOString(), actionCount]);
    // Stop-proof holds whose source finalizer is still leased (n % 40 = 15) or has an expired lease (n % 40 = 35).
    await run(`insert into native_run_finalizations (run_id, company_id, issue_id, phase, lease_owner, lease_expires_at)
      select r.id, r.company_id, r.native_issue_id, 'finalizing', 'owner',
        case when i.n % 40 = 15 then $2::timestamptz + interval '20 minutes' else $2::timestamptz - interval '20 minutes' end
      from heartbeat_runs r join bench_issues i on i.id = r.native_issue_id
      where r.company_id = $1::uuid and r.status = 'failed' and i.n <= $3::int and i.n % 40 in (15, 35)
        and r.created_at = $2::timestamptz - (i.n * interval '1 minute')`, [company, now.toISOString(), actionCount]);
    // A late provider stop receipt after a deferred check (n % 20 = 16 with n % 40 = 36).
    await run(`insert into environment_leases (company_id, heartbeat_run_id, issue_id, lease_policy, updated_at)
      select r.company_id, r.id, r.native_issue_id, 'retain_on_failure',
        $2::timestamptz - interval '1 minute'
      from heartbeat_runs r join bench_issues i on i.id = r.native_issue_id
      where r.company_id = $1::uuid and r.status = 'failed' and i.n <= $3::int and i.n % 40 = 36
        and r.created_at = $2::timestamptz - (i.n * interval '1 minute')`, [company, now.toISOString(), actionCount]);
    // Recovery actions by n % 20:
    //   0-11 complete and resolved (most history); 12-13 exhausted with a permanently refused source;
    //   14-15 exhausted unproven-stop holds with re-arms left; 16 the same with every re-arm spent;
    //   17 scheduled; 18 cancelled with export requests; 19 complete with a pending bootstrap continuation.
    // Exhausted holds alternate between a spent deferred check of this generation, a deferred check
    // with a future time, an older generation's check, and no check. Every due time is in the future.
    await run(`insert into issue_recovery_actions (company_id, source_issue_id, kind, status, owner_type, cause, fingerprint, next_action, evidence,
        created_at, updated_at)
      select i.company_id, i.id, 'workspace_recovery',
        case when k < 12 or k = 19 then 'resolved' when k = 18 then 'cancelled' when k in (13, 15) then 'escalated' else 'active' end,
        'system', case when i.n % 50 = 7 then 'workspace_restore_failed' else (array['native_workspace_sync_out_unrecoverable','native_workspace_sync_out_retry_exhausted'])[1 + i.n % 2] end,
        'fp-' || i.n, 'next',
        jsonb_strip_nulls(jsonb_build_object(
          'runId', case when i.n % 97 = 5 then upper(r.id::text) else r.id::text end,
          'filler', ${filler(Number(fixture.evidenceBytes), "i.n")},
          'workspaceRestoreRecovery', case when i.n % 50 = 7 then jsonb_build_object('schema', 'paperclip.workspace-restore-recovery.v1') end,
          'bootstrapPreparationSettledAt', case when k = 19 then '2026-01-01T00:00:00Z' end,
          'bootstrapPreparationContinuation', case when k = 19 then 'pending' end,
          'systemRecovery', jsonb_build_object('schema', 'paperclip.system-recovery.v1', 'policyVersion', 1, 'sourceRunId', r.id::text,
            'generationId', 'gen-' || i.n, 'revision', 2,
            'state', case when k < 12 or k = 19 then 'complete' when k = 17 then 'scheduled' else 'exhausted' end,
            'nextAttemptAt', case when k = 17 then $3::bigint + 60000 * (1 + i.n % 30) end,
            'failure', case when k in (12, 13) then jsonb_build_object('code', (array['source_unavailable','historical_source_missing','source_binding_invalid'])[1 + i.n % 3],
                'retryClass', case when i.n % 11 = 0 then 'recheck_evidence' else 'service_required' end)
              when k in (14, 15, 16, 18) then jsonb_build_object('code', 'agent_stop_unconfirmed', 'retryClass', 'recheck_evidence') end),
          'workspaceRecovery', jsonb_build_object('schema', 'paperclip.workspace-recovery.v1', 'runId', r.id::text,
            'status', case when k < 12 then 'recovered' else 'blocked' end,
            'requestIds', case when k = 18 then jsonb_build_array('req-' || i.n) else '[]'::jsonb end),
          'stopProofRecovery', case when k in (14, 15, 16) then jsonb_build_object('schema', 'paperclip.stop-proof-recovery.v1',
            'rearms', case when k = 16 then 4 else i.n % 4 end, 'nextRearmAt', $3::bigint + 60000 * (5 + i.n % 50)) end,
          'retainedSourceFallbackCheck', case when k in (12, 13, 16) then (array[
              jsonb_build_object('generationId', 'gen-' || i.n, 'checkedAt', $3::bigint - 600000),
              jsonb_build_object('generationId', 'gen-' || i.n, 'checkedAt', $3::bigint - 600000, 'nextCheckAt', $3::bigint + 60000 * (3 + i.n % 40)),
              jsonb_build_object('generationId', 'gen-old', 'checkedAt', $3::bigint - 600000, 'nextCheckAt', $3::bigint + 60000 * (3 + i.n % 40)),
              jsonb_build_object('generationId', 'gen-' || i.n, 'nextCheckAt', $3::bigint + 60000 * (7 + i.n % 40))])[1 + (i.n / 20) % 4] end)),
        $2::timestamptz, $2::timestamptz
      from (select i.*, i.n % 20 as k from bench_issues i where i.company_id = $1::uuid and i.n <= $4::int) i
      join heartbeat_runs r on r.company_id = i.company_id and r.native_issue_id = i.id and r.status = 'failed'
        and r.created_at = $2::timestamptz - (i.n * interval '1 minute')`,
      [company, now.toISOString(), now.getTime(), actionCount]);
    // Siblings: a completed recovery of the same run saved the files (n % 60 = 12).
    await run(`insert into issue_recovery_actions (company_id, source_issue_id, kind, status, owner_type, cause, fingerprint, next_action, evidence)
      select a.company_id, a.source_issue_id, 'workspace_recovery', 'resolved', 'system', a.cause, a.fingerprint || '-sibling', 'next',
        jsonb_build_object('runId', a.evidence->>'runId', 'systemRecovery', jsonb_build_object('state', 'complete'),
          'workspaceRecovery', jsonb_build_object('status', 'recovered'))
      from issue_recovery_actions a join bench_issues i on i.id = a.source_issue_id
      where a.company_id = $1::uuid and i.n % 60 = 12`, [company]);
  }
  await run("analyze");
}

async function seedDroppedComments(db: Db, fixture: Fixture, now: Date) {
  const run = (text: string, params: unknown[] = []) => db.$client.unsafe(text, params as never[]);
  for (const [scale, tag] of [[1, "A"], [0.25, "B"]] as const) {
    const issueCount = Math.ceil(Number(fixture.issues) * scale), runCount = Math.ceil(Number(fixture.runs) * scale);
    const hot = Math.ceil(Number(fixture.hotIssues) * scale), perIssue = Number(fixture.commentsPerHotIssue);
    const company = await seedCompany(db, scale, tag, Number(fixture.issues));
    await seedRunHistory(db, company, now, runCount, issueCount, Number(fixture.contextBytes));
    // Hot tasks are done; the agent closed even n, a person odd n (n % 12 = 9).
    await run(`update issues set status = 'done' where company_id = $1::uuid and issue_number <= $2::int`, [company, hot]);
    await run(`insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      select i.company_id, case when i.n % 12 = 9 then 'user' else 'agent' end, 'actor', 'issue.updated', 'issue', i.id::text,
        jsonb_build_object('toStatus', 'done'), $2::timestamptz - interval '50 minutes'
      from bench_issues i where i.company_id = $1::uuid and i.n <= $3::int`, [company, now.toISOString(), hot]);
    // The closing run: started before the comments and finished after them; bound by context (odd n) or column (even n).
    await run(`insert into heartbeat_runs (company_id, agent_id, status, invocation_source, native_issue_id, context_snapshot, created_at, started_at, finished_at)
      select i.company_id, case when i.n % 12 = 11 then (select a.id from bench_agents a where a.company_id = i.company_id and a.id <> i.agent_id limit 1) else i.agent_id end,
        case when i.n % 12 = 10 then 'failed' else 'succeeded' end, 'assignment',
        case when i.n % 2 = 0 then i.id end, case when i.n % 2 = 1 then jsonb_build_object('issueId', i.id::text, 'prompt', ${filler(Number(fixture.contextBytes), "i.n")}) else '{}'::jsonb end,
        $2::timestamptz - interval '58 minutes', $2::timestamptz - interval '58 minutes',
        case when i.n % 12 = 8 then $2::timestamptz - interval '56 minutes' else $2::timestamptz - interval '1 minute' end
      from bench_issues i where i.company_id = $1::uuid and i.n <= $3::int`, [company, now.toISOString(), hot]);
    // A live run on the task (n % 12 = 6), bound by the other binding.
    await run(`insert into heartbeat_runs (company_id, agent_id, status, invocation_source, native_issue_id, context_snapshot, created_at, started_at)
      select i.company_id, i.agent_id, (array['queued','running','scheduled_retry'])[1 + i.n % 3], 'assignment',
        case when i.n % 2 = 1 then i.id end, case when i.n % 2 = 0 then jsonb_build_object('issueId', i.id::text) else '{}'::jsonb end,
        $2::timestamptz - interval '2 minutes', $2::timestamptz - interval '2 minutes'
      from bench_issues i where i.company_id = $1::uuid and i.n <= $3::int and i.n % 12 = 6`, [company, now.toISOString(), hot]);
    await run(`insert into issue_comments (company_id, issue_id, author_user_id, body, created_at)
      select i.company_id, i.id, 'user-1', 'comment ' || k,
        $2::timestamptz - interval '55 minutes' + ((k - 1) * $3::int + i.n) * (interval '50 minutes' / ($3::int * $4::int)) + $5::int * interval '1 millisecond'
      from bench_issues i cross join generate_series(1, $4::int) k where i.company_id = $1::uuid and i.n <= $3::int`,
      [company, now.toISOString(), hot, perIssue, scale === 1 ? 0 : 500]);
    await run(`insert into issue_comments (company_id, issue_id, author_user_id, body, created_at)
      select i.company_id, i.id, 'user-1', 'old', $2::timestamptz - interval '2 hours' - (k * interval '3 hours')
      from bench_issues i cross join generate_series(1, 8) k where i.company_id = $1::uuid`, [company, now.toISOString()]);
    // Wakes by n % 12: 0-2 completed (normal delivery); 3-11 cancelled as stale continuations
    // (commentId, or a goal wake context list for n % 4 = 3); n % 12 = 7 also has an open wake.
    await run(`insert into agent_wakeup_requests (company_id, agent_id, source, status, error, payload, created_at, updated_at)
      select c.company_id, i.agent_id, 'automation', case when i.n % 12 < 3 then 'completed' else 'cancelled' end,
        case when i.n % 12 >= 3 then 'continuation_task_ownership_changed' end,
        case when i.n % 4 = 3 then jsonb_build_object('issueId', c.issue_id::text, '_paperclipWakeContext', jsonb_build_object('wakeCommentIds', jsonb_build_array(c.id::text)))
          else jsonb_build_object('issueId', c.issue_id::text, 'commentId', c.id::text) end, c.created_at, c.created_at
      from issue_comments c join bench_issues i on i.id = c.issue_id where c.company_id = $1::uuid`, [company]);
    await run(`insert into agent_wakeup_requests (company_id, agent_id, source, status, payload, created_at, updated_at)
      select c.company_id, i.agent_id, 'automation', 'deferred_issue_execution',
        jsonb_build_object('issueId', c.issue_id::text, 'commentId', c.id::text), c.created_at, c.created_at
      from issue_comments c join bench_issues i on i.id = c.issue_id
      where c.company_id = $1::uuid and i.n % 12 = 7 and c.created_at >= $2::timestamptz - interval '1 hour'`, [company, now.toISOString()]);
  }
  await run("analyze");
}

type Query = { sql: string; params: unknown[] };
let recorded: Query[] | null = null;
let captureDb: Db | undefined;
/** Runs `call` on a connection that records each statement it sends. */
async function capture(call: (db: Db) => Promise<unknown>): Promise<{ queries: Query[]; result: unknown }> {
  const queries: Query[] = [];
  recorded = queries;
  try { return { queries, result: await call(captureDb!) }; } finally { recorded = null; }
}

/** Every condition the change touched, for every recovery action, from one arm's discovery module. */
async function conditionRows(db: Db, discovery: Discovery, now: number) {
  return await db.select({
    id: issueRecoveryActions.id,
    fallbackPending: sql<boolean>`${discovery.retainedSourceFallbackPendingCondition()}`,
    fallbackDueAt: sql<string>`(${discovery.retainedSourceFallbackDueAt()})::text`,
    fallbackDue: sql<boolean>`${discovery.retainedSourceFallbackDueCondition(now)}`,
    rearmPending: sql<boolean>`${discovery.stopProofRearmPendingCondition()}`,
    rearmDueAt: sql<string>`(${discovery.stopProofRearmDueAt()})::text`,
    rearmDue: sql<boolean>`${discovery.stopProofRearmDueCondition(now)}`,
  }).from(issueRecoveryActions).orderBy(issueRecoveryActions.id);
}

try {
  database = await startEmbeddedPostgresTestDatabase("recovery-status-benchmark-");
  db = createDb(database.connectionString, { maxConnections: 1, idleTimeoutSeconds: 0 });
  captureClient = postgres(database.connectionString, { max: 1, onnotice: () => {}, fetch_types: false,
    debug: (_connection, query, params) => { recorded?.push({ sql: query, params }); } });
  captureDb = drizzle(captureClient, { schema }) as unknown as Db;
  await db.$client.unsafe("set client_min_messages = warning");
  const version = await db.$client.unsafe("select version()");
  const settings = await db.$client.unsafe("select name, setting from pg_settings where name in ('shared_buffers', 'work_mem', 'jit', 'random_page_cost') order by name");
  const selectors = process.argv.filter(value => value.startsWith("--fixture=")).map(value => value.slice(10));
  const results = [];
  for (const fixture of fixtures.filter(value => !selectors.length || selectors.includes(value.name))) {
    await db.$client.unsafe("TRUNCATE companies CASCADE");
    await db.$client.unsafe("drop table if exists bench_agents, bench_issues");
    const now = new Date(), limit = 200;
    const seedStart = performance.now();
    let arms: Record<"before" | "after", (db: Db) => Promise<unknown>>;
    let proof: Record<string, unknown>;
    if (fixture.check === "workspace-recovery") {
      await seedWorkspaceRecovery(db, fixture, now);
      arms = { before: baselineNext, after: treatmentNext };
      const [expected, actual] = [await conditionRows(db, baselineDiscovery, now.getTime()), await conditionRows(db, treatmentDiscovery, now.getTime())];
      assert.deepEqual(actual, expected, `${fixture.name}: a recovery condition differs for some action`);
      const count = (key: keyof typeof expected[number]) => expected.filter(row => row[key] === true).length;
      proof = { actionsCompared: expected.length, fallbackPending: count("fallbackPending"), fallbackDue: count("fallbackDue"),
        rearmPending: count("rearmPending"), rearmDue: count("rearmDue") };
      assert.ok(Number(proof.fallbackPending) > 0 && Number(proof.rearmPending) > 0, `${fixture.name}: the fixture must have pending holds`);
    } else {
      await seedDroppedComments(db, fixture, now);
      const check = (report: Report) => (input: Db) => (report as unknown as { checkStaleDroppedComments: DroppedCheck }).checkStaleDroppedComments(input, now, limit);
      arms = { before: check(baselineReport), after: check(treatmentReport) };
      proof = {};
    }
    const seedMs = performance.now() - seedStart;
    const counts = (await db.$client.unsafe(`select (select count(*) from heartbeat_runs) runs, (select count(*) from issue_recovery_actions) recovery_actions,
      (select count(*) from issue_comments where created_at >= now() - interval '1 hour') recent_comments,
      (select count(*) from native_run_finalizations) finalizers, (select count(*) from environment_leases) leases,
      (select pg_size_pretty(pg_total_relation_size('heartbeat_runs'))) runs_size`))[0];
    const before = await capture(arms.before);
    const after = await capture(arms.after);
    assert.deepEqual(after.result, before.result, `${fixture.name}: complete service result differs`);
    if (fixture.check === "workspace-recovery") assert.ok(before.result !== null, `${fixture.name}: the fixture must have a deadline`);
    else assert.ok((before.result as unknown[]).length > 0, `${fixture.name}: the fixture must report owed comments`);
    const statement = (captured: typeof before) => captured.queries[0]!;
    const rows = async (query: Query) => db!.$client.unsafe(query.sql, query.params as never[]).values();
    const expectedRows = await rows(statement(before)), actualRows = await rows(statement(after));
    assert.ok(expectedRows.length > 0);
    // Order is part of the contract: compare the statement's rows positionally.
    assert.deepEqual(actualRows, expectedRows, `${fixture.name}: complete positional SQL output differs`);
    const samples = { before: [] as number[], after: [] as number[] };
    for (let iteration = 0; iteration < samplesPerArm + 2; iteration++) {
      for (const arm of iteration % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
        const start = performance.now();
        const result = await arms[arm](db);
        const ms = performance.now() - start;
        assert.deepEqual(result, before.result);
        if (iteration >= 2) samples[arm].push(ms);
      }
    }
    const plans: Record<string, unknown> = {};
    const buffers: Record<string, number> = {};
    for (const [arm, captured] of [["before", before], ["after", after]] as const) {
      const query = statement(captured);
      const [row] = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`, query.params as never[]);
      plans[arm] = row["QUERY PLAN"];
      const plan = (row["QUERY PLAN"] as { Plan: Record<string, number> }[])[0]!.Plan;
      buffers[arm] = Number(plan["Shared Hit Blocks"]) + Number(plan["Shared Read Blocks"]);
    }
    const medians = { before: median(samples.before), after: median(samples.after) };
    // Hash-join plan: without nested loops, PostgreSQL can join an OR-bound or
    // text-cast run lookup only by company. One sample each, untimed loop, same result check.
    const hashPlan: Record<string, number | string> = {};
    if (!process.argv.includes("--skip-hash-plan")) {
      await db.$client.unsafe("set enable_nestloop = off");
      await db.$client.unsafe("set statement_timeout = '300s'");
      try {
        for (const [arm, captured] of [["before", before], ["after", after]] as const) {
          const start = performance.now();
          try {
            assert.deepEqual(await rows(statement(captured)), expectedRows, `${fixture.name}: hash-plan output differs`);
            hashPlan[arm] = performance.now() - start;
          } catch (error) {
            if ((error as { code?: string }).code !== "57014") throw error;
            hashPlan[arm] = "timeout after 300 s";
          }
        }
      } finally {
        await db.$client.unsafe("reset enable_nestloop");
        await db.$client.unsafe("reset statement_timeout");
      }
    }
    results.push({ fixture, counts, seedMs, proof, reportedRows: expectedRows.length, queries: { before: statement(before).sql, after: statement(after).sql },
      samples, medians, spread: { before: spread(samples.before), after: spread(samples.after) }, buffers, hashPlan, plans });
    process.stderr.write(`${fixture.name}: ${JSON.stringify(counts)} proof=${JSON.stringify(proof)} rows=${expectedRows.length}; `
      + `median ${medians.before.toFixed(1)} -> ${medians.after.toFixed(1)} ms (${(medians.before / medians.after).toFixed(1)}x); `
      + `buffers ${buffers.before} -> ${buffers.after}; hash plan ${JSON.stringify(hashPlan)}; `
      + `samples before=${samples.before.map(v => v.toFixed(0)).join(",")} after=${samples.after.map(v => v.toFixed(0)).join(",")}\n`);
  }
  const output = JSON.stringify({ baselineRevision, treatmentRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: root }).trim(),
    changedSources, version, settings, warmups: 2, timedSamplesPerArm: samplesPerArm, results }, null, 2);
  const out = process.argv.find(value => value.startsWith("--out="))?.slice(6);
  if (out) await fs.writeFile(out, output); else console.log(output);
} finally {
  try { await captureClient?.end({ timeout: 0 }); await db?.$client.end({ timeout: 0 }); await database?.cleanup(); await fs.rm(baselineDir, { recursive: true, force: true }); }
  finally { clearInterval(keepAlive); }
}
