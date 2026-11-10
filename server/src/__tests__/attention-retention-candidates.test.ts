import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, createDb } from "@paperclipai/db";
import { ATTENTION_RETENTION_KIND_ORDER, listAttentionRetentionCandidates } from "../services/attention-retention.js";
import { DEFAULT_DECISION_ARCHIVE_DAYS } from "../services/decision-retention.js";
import type { AttentionRetentionScope } from "../services/retention-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_RETENTION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
type Cursor = { sourceKind: string; sourceId: string };
type Db = ReturnType<typeof createDb>;

// The former single scan: every candidate of every kind, filtered and ordered
// after the union. It is the oracle for the per-kind branches.
function oracle(db: Db, scope: AttentionRetentionScope, cursor?: Cursor, sourceId?: string) {
  const issueIds = scope.issueIds ?? (scope.issueId ? [scope.issueId] : []);
  const kinds = ["decision", "issue_thread_interaction", "recovery_action", "blocker_attention", "review", "failed_run", "budget_alert", "agent_error_alert"]
    .filter(kind => (!scope.sourceKind || scope.sourceKind === kind) && (!issueIds.length || !["budget_alert", "agent_error_alert"].includes(kind)));
  if (!kinds.length) return Promise.resolve([]);
  const branches: Record<string, ReturnType<typeof sql>> = {
    decision: sql`select 'decision', d.id::text, d.company_id, d.updated_at, d.origin_issue_id::text from decisions d where d.status = 'open'`,
    issue_thread_interaction: sql`select 'issue_thread_interaction', i.id::text, i.company_id, i.updated_at, i.issue_id::text
      from issue_thread_interactions i where i.status = 'pending' and i.addressee_user_id is null`,
    recovery_action: sql`select 'recovery_action', r.id::text, r.company_id, r.updated_at, r.source_issue_id::text
      from issue_recovery_actions r where r.status in ('active', 'escalated') and r.owner_type in ('user', 'board')`,
    blocker_attention: sql`select 'blocker_attention', i.id::text, i.company_id, i.updated_at, i.id::text
      from issues i where i.status = 'blocked' and i.hidden_at is null and i.harness_kind is null`,
    review: sql`select 'review', i.id::text, i.company_id, i.updated_at, i.id::text
      from issues i where i.status = 'in_review' and i.hidden_at is null and i.harness_kind is null`,
    failed_run: sql`select 'failed_run', r.id::text, r.company_id, coalesce(r.finished_at, r.updated_at, r.created_at), coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId')
      from heartbeat_runs r where r.status in ('failed', 'timed_out') and exists (select 1 from heartbeat_run_events e where e.run_id = r.id
        and e.company_id = r.company_id and e.event_type = 'lifecycle' and e.message like 'Bounded retry exhausted%')`,
    budget_alert: sql`select 'budget_alert', b.id::text, b.company_id, b.updated_at, null::text from budget_incidents b where b.status = 'open'
      and (b.threshold_type = 'hard' or (b.amount_limit > 0 and round(b.amount_observed::numeric / b.amount_limit * 10000) / 100 >= 85))`,
    agent_error_alert: sql`select 'agent_error_alert', a.id::text, a.company_id, a.updated_at, null::text from agents a where a.status = 'error'`,
  };
  const id = sourceId ?? scope.sourceId ?? null;
  return db.execute(sql`with source_candidates(source_kind, source_id, company_id, activity_at, issue_id) as (${sql.join(kinds.map(kind => branches[kind]), sql` union all `)})
    select s.source_kind as "sourceKind", s.source_id as "sourceId", s.company_id as "companyId", s.issue_id as "issueId",
      s.activity_at::text as "activityAt", ceil(extract(epoch from s.activity_at) * 1000 + ${DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000}) as "deadlineAt"
    from source_candidates s inner join companies c on c.id = s.company_id
    left join decision_retention r on r.company_id = s.company_id and r.source_kind = s.source_kind and r.source_id = s.source_id
    where c.status = 'active'
      ${issueIds.length ? sql`and s.issue_id in (${sql.join(issueIds.map(value => sql`${value}`), sql`, `)})` : sql``}
      and (${scope.companyId ?? null}::uuid is null or s.company_id = ${scope.companyId ?? null}::uuid)
      and (${id}::text is null or s.source_id = ${id})
      and (s.source_kind = 'blocker_attention' or ((r.id is null or r.keep = false) and r.archived_at is null))
      ${cursor ? sql`and (s.source_kind, s.source_id) > (${cursor.sourceKind}, ${cursor.sourceId})` : sql``}
    order by s.source_kind, s.source_id limit 100`)
    .then(rows => (rows as unknown as Array<Record<string, unknown>>).map(row => ({ ...row, deadlineAt: Number(row.deadlineAt) })));
}

(support.supported ? describe : describe.skip)("attention retention candidates", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const companyId = randomUUID(), otherCompanyId = randomUUID(), inactiveCompanyId = randomUUID();
  const fixture: Record<string, string> = {};

  async function seed(company: string, prefix: string, status: string, size: number) {
    await db.execute(sql`insert into companies (id, name, issue_prefix, status) values (${company}::uuid, ${prefix}, ${prefix}, ${status})`);
    await db.execute(sql`insert into agents (company_id, name, status)
      select ${company}::uuid, 'Agent ' || n, case when n % 3 = 0 then 'error' else 'idle' end from generate_series(1, 6) n`);
    // Issues: blocked, in review, hidden, harness-owned and ordinary ones.
    await db.execute(sql`insert into issues (company_id, title, status, hidden_at, harness_kind, updated_at)
      select ${company}::uuid, 'Issue ' || n,
        case n % 5 when 0 then 'blocked' when 1 then 'in_review' when 2 then 'blocked' else 'todo' end,
        case when n % 11 = 0 then now() end, case when n % 13 = 0 then 'eval' end, now() - n * interval '1 minute'
      from generate_series(1, ${size}::int) n`);
    const agent = sql`(select id from agents where company_id = ${company}::uuid order by name limit 1)`;
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, status, finished_at, context_snapshot)
      select ${company}::uuid, ${agent}, case when n % 4 = 0 then 'timed_out' when n % 2 = 0 then 'failed' else 'succeeded' end,
        case when n % 3 = 0 then now() end,
        case n % 3 when 0 then jsonb_build_object('issueId', (select id::text from issues where company_id = ${company}::uuid order by title limit 1 offset n % 5))
          when 1 then jsonb_build_object('taskId', 'task-' || n) else '{}'::jsonb end
      from generate_series(1, ${size}::int) n`);
    // A lifecycle receipt on most runs, an output decoy and a non-matching lifecycle event on others.
    await db.execute(sql`insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message)
      select r.company_id, r.id, r.agent_id, 1,
        case when row_number() over (order by r.id) % 5 = 0 then 'stdout' else 'lifecycle' end,
        case when row_number() over (order by r.id) % 7 = 0 then 'Run step' else 'Bounded retry exhausted after 3 attempts' end
      from heartbeat_runs r where r.company_id = ${company}::uuid`);
    await db.execute(sql`insert into decisions (company_id, origin_agent_id, origin_issue_id, origin_run_id, title, body, options, status, expires_at, signed_spec, target_snapshots)
      select r.company_id, r.agent_id, (select id from issues where company_id = r.company_id order by title limit 1), r.id, 'Decision', 'Choose', '[]'::jsonb,
        case when row_number() over (order by r.id) % 3 = 0 then 'resolved' else 'open' end, now() + interval '1 day', 'fixture', '{}'::jsonb
      from heartbeat_runs r where r.company_id = ${company}::uuid`);
    await db.execute(sql`insert into issue_thread_interactions (company_id, issue_id, kind, status, addressee_user_id, payload)
      select i.company_id, i.id, 'ask_user_questions', case when row_number() over (order by i.id) % 4 = 0 then 'answered' else 'pending' end,
        case when row_number() over (order by i.id) % 5 = 0 then 'board' end, '{"version":1,"questions":[]}'::jsonb
      from issues i where i.company_id = ${company}::uuid`);
    await db.execute(sql`insert into issue_recovery_actions (company_id, source_issue_id, kind, status, owner_type, cause, fingerprint, next_action)
      select i.company_id, i.id, 'execution', case when n % 4 = 0 then 'resolved' when n % 4 = 1 then 'escalated' else 'active' end,
        case when n % 3 = 0 then 'agent' when n % 3 = 1 then 'user' else 'board' end, 'fixture', 'fp-' || n, 'Choose'
      from (select company_id, id, row_number() over (order by id) as n from issues where company_id = ${company}::uuid) i`);
    const [policy] = await db.execute<{ id: string }>(sql`insert into budget_policies (company_id, scope_type, scope_id, window_kind)
      values (${company}::uuid, 'company', ${company}::uuid, 'monthly') returning id::text`);
    await db.execute(sql`insert into budget_incidents (company_id, policy_id, scope_type, scope_id, metric, window_kind, window_start, window_end, threshold_type, amount_limit, amount_observed, status)
      select ${company}::uuid, ${policy.id}::uuid, 'company', ${company}::uuid, 'billed_cents', 'monthly', now() - w * interval '1 day', now(), t, l, o, s
      from (values (1, 'hard', 100, 1, 'open'), (2, 'soft', 100, 85, 'open'), (3, 'soft', 100, 84.99, 'open'), (4, 'soft', 0, 99, 'open'), (5, 'hard', 100, 100, 'resolved')) v(w, t, l, o, s)`);
    // Retention: kept, archived and plain rows across kinds, including blocked issues.
    await db.execute(sql`insert into decision_retention (company_id, source_kind, source_id, source_activity_at, keep, archived_at)
      select company_id, kind, id, now(), n % 3 = 0, case when n % 3 = 1 then now() end from (
        select company_id, case when status = 'blocked' then 'blocker_attention' else 'review' end as kind, id::text as id, row_number() over (order by id) as n
          from issues where company_id = ${company}::uuid and status in ('blocked', 'in_review')
        union all select company_id, 'failed_run', id::text, row_number() over (order by id) from heartbeat_runs where company_id = ${company}::uuid
        union all select company_id, 'decision', id::text, row_number() over (order by id) from decisions where company_id = ${company}::uuid
        union all select company_id, 'agent_error_alert', id::text, row_number() over (order by id) from agents where company_id = ${company}::uuid
      ) x where n % 2 = 0`);
  }

  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else temporary = await startEmbeddedPostgresTestDatabase("attention-retention-candidates-");
    db = createDb(externalUrl ?? temporary!.connectionString, { maxConnections: 2, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await seed(companyId, `C${companyId.slice(0, 5)}`, "active", 90);
    await seed(otherCompanyId, `O${otherCompanyId.slice(0, 5)}`, "active", 40);
    await seed(inactiveCompanyId, `I${inactiveCompanyId.slice(0, 5)}`, "archived", 20);
    const [run] = await db.execute<{ id: string }>(sql`select r.id::text from heartbeat_runs r where r.company_id = ${companyId}::uuid
      and r.status = 'failed' and exists (select 1 from heartbeat_run_events e where e.run_id = r.id and e.event_type = 'lifecycle'
        and e.message like 'Bounded retry exhausted%') and not exists (select 1 from decision_retention d where d.source_id = r.id::text)
      order by r.id limit 1`);
    fixture.failedRun = run.id;
    const blocked = await db.execute<{ id: string }>(sql`select id::text from issues where company_id = ${companyId}::uuid
      and status = 'blocked' and hidden_at is null and harness_kind is null order by id limit 2`);
    fixture.blocked = blocked[0].id; fixture.blocked2 = blocked[1].id;
  }, 60_000);
  afterAll(async () => {
    // An external test database is not reset between runs; remove this suite's fixtures.
    if (externalUrl && db) await db.transaction(async tx => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate companies cascade`);
    });
    await db?.$client.end({ timeout: 1 }); await temporary?.cleanup();
  });

  async function pages(read: (cursor?: Cursor) => Promise<Array<Record<string, unknown>>>) {
    const pages: Array<Array<Record<string, unknown>>> = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await read(cursor);
      pages.push(page);
      if (page.length < 100) return pages;
      const last = page[page.length - 1]!;
      cursor = { sourceKind: last.sourceKind as string, sourceId: last.sourceId as string };
    }
  }

  it("orders source kinds the same way as the database", async () => {
    const rows = await db.execute<{ kind: string }>(sql`select kind from unnest(array[${sql.join(
      [...ATTENTION_RETENTION_KIND_ORDER].reverse().map(kind => sql`${kind}::text`), sql`, `)}]) kind order by kind`);
    expect(rows.map(row => row.kind)).toEqual([...ATTENTION_RETENTION_KIND_ORDER]);
  });

  it.each([
    ["one company", { companyId }],
    ["every company", {}],
    ["one kind", { companyId, sourceKind: "failed_run" as const }],
    ["the blocker kind, which ignores retention", { companyId, sourceKind: "blocker_attention" as const }],
    ["an unknown kind", { companyId, sourceKind: "approval" as const }],
  ])("returns the former pages, rows and cursors for %s", async (_name, scope: AttentionRetentionScope) => {
    const expected = await pages(cursor => oracle(db, scope, cursor));
    const actual = await pages(cursor => listAttentionRetentionCandidates(db as never, scope, cursor as never));
    expect(actual).toEqual(expected);
    if (!scope.sourceKind?.startsWith("approval")) expect(expected.flat().length).toBeGreaterThan(0);
  });

  it("pages across kind boundaries without skipping or repeating a candidate", async () => {
    const all = (await pages(cursor => listAttentionRetentionCandidates(db as never, {}, cursor as never))).flat();
    expect(all.length).toBeGreaterThan(200);
    expect(new Set(all.map(row => `${row.sourceKind}:${row.sourceId}`)).size).toBe(all.length);
    expect(new Set(all.map(row => row.sourceKind))).toEqual(new Set(ATTENTION_RETENTION_KIND_ORDER));
    expect(all.some(row => row.companyId === inactiveCompanyId)).toBe(false);
    // Start a page at every kind boundary and in the middle of a kind.
    for (const cursor of [{ sourceKind: "blocker_attention", sourceId: "" }, { sourceKind: "decision", sourceId: "8" },
      { sourceKind: "failed_run", sourceId: "ffffffff" }, { sourceKind: "zzz", sourceId: "" }, { sourceKind: "a", sourceId: "z" }]) {
      expect(await listAttentionRetentionCandidates(db as never, { companyId }, cursor as never)).toEqual(await oracle(db, { companyId }, cursor));
    }
  });

  it("filters by issue and leaves company-wide kinds out of an issue scope", async () => {
    for (const scope of [{ companyId, issueId: fixture.blocked }, { companyId, issueIds: [fixture.blocked, fixture.blocked2, "not-a-uuid"] },
      { companyId, issueIds: [fixture.blocked.toUpperCase()] }, { issueIds: [] }] as AttentionRetentionScope[]) {
      const actual = await listAttentionRetentionCandidates(db as never, scope);
      expect(actual).toEqual(await oracle(db, scope));
      if (scope.issueIds?.length || scope.issueId) {
        expect(actual.some(row => ["budget_alert", "agent_error_alert"].includes(row.sourceKind))).toBe(false);
      }
    }
    expect((await listAttentionRetentionCandidates(db as never, { companyId, issueId: fixture.blocked })).length).toBeGreaterThan(0);
  });

  it("matches one source only by its exact text id", async () => {
    const run = fixture.failedRun;
    const exact = await listAttentionRetentionCandidates(db as never, { companyId, sourceKind: "failed_run" }, undefined, run);
    expect(exact.map(row => row.sourceId)).toEqual([run]);
    expect(exact).toEqual(await oracle(db, { companyId, sourceKind: "failed_run" }, undefined, run));
    expect(await listAttentionRetentionCandidates(db as never, { companyId, sourceId: run })).toEqual(exact);
    // Text that casts to the same uuid but is not its printed form never matched.
    for (const other of [run.toUpperCase(), `{${run}}`, run.replaceAll("-", ""), "", "not-a-uuid"]) {
      expect(await listAttentionRetentionCandidates(db as never, { companyId, sourceKind: "failed_run" }, undefined, other)).toEqual([]);
      expect(await oracle(db, { companyId, sourceKind: "failed_run" }, undefined, other)).toEqual([]);
    }
    // Company isolation: the same id in another company scope is not a candidate.
    expect(await listAttentionRetentionCandidates(db as never, { companyId: otherCompanyId, sourceKind: "failed_run" }, undefined, run)).toEqual([]);
    // A decoded scope can carry null; it means no source filter.
    const nullScope = { companyId, sourceKind: "failed_run", sourceId: null } as unknown as AttentionRetentionScope;
    expect(await listAttentionRetentionCandidates(db as never, nullScope)).toEqual(await oracle(db, { companyId, sourceKind: "failed_run" }));
  });

  it("excludes kept and archived sources and failed runs without a retry receipt", async () => {
    const rows = (await pages(cursor => listAttentionRetentionCandidates(db as never, { companyId }, cursor as never))).flat();
    const retained = await db.execute<{ kind: string; id: string }>(sql`select source_kind as kind, source_id as id from decision_retention
      where company_id = ${companyId}::uuid and (keep or archived_at is not null) and source_kind <> 'blocker_attention'`);
    const returned = new Set(rows.map(row => `${row.sourceKind}:${row.sourceId}`));
    expect(retained.length).toBeGreaterThan(0);
    for (const row of retained) expect(returned.has(`${row.kind}:${row.id}`)).toBe(false);
    const keptBlocked = await db.execute<{ id: string }>(sql`select r.source_id as id from decision_retention r join issues i on i.id::text = r.source_id
      where r.company_id = ${companyId}::uuid and r.source_kind = 'blocker_attention' and r.keep and i.hidden_at is null and i.harness_kind is null`);
    expect(keptBlocked.length).toBeGreaterThan(0);
    for (const row of keptBlocked) expect(returned.has(`blocker_attention:${row.id}`)).toBe(true);
    const unreceipted = await db.execute<{ id: string }>(sql`select r.id::text from heartbeat_runs r where r.company_id = ${companyId}::uuid
      and r.status in ('failed', 'timed_out') and not exists (select 1 from heartbeat_run_events e where e.run_id = r.id
        and e.event_type = 'lifecycle' and e.message like 'Bounded retry exhausted%')`);
    expect(unreceipted.length).toBeGreaterThan(0);
    for (const row of unreceipted) expect(returned.has(`failed_run:${row.id}`)).toBe(false);
  });
});
