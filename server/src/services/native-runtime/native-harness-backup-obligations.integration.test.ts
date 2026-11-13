import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentTaskSessions, agents, companies, createDb, environmentLeases, heartbeatRuns, issues, nativeHarnessBackups, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { hasLocalNativeHarnessObligations } from "./native-harness-backup-migration.js";
import { hasValidNativeHarnessFilesystemIndependence } from "./native-harness-filesystem-independence.js";

vi.mock("./native-harness-filesystem-independence.js", () => ({ hasValidNativeHarnessFilesystemIndependence: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport(), dialect = new PgDialect();
const baseline = dialect.sqlToQuery(sql`select distinct
  s.company_id, s.id::text as selected_session_id, coalesce(e.metadata->'nativeHarnessBackup'->>'sessionScopeSha256', '') as scope_digest,
  r.runner_profile_json ? 'nativeHarnessFilesystemIndependence' as has_receipt from agent_task_sessions s
  join heartbeat_runs r on r.id = s.last_run_id and r.company_id = s.company_id and r.agent_id = s.agent_id
  join environment_leases e on e.company_id = r.company_id and e.issue_id = r.native_issue_id
    and e.metadata->'nativeHarnessBackup'->>'normalizedSessionId' = r.native_session_id::text
  where s.adapter_type = 'paperclip_runner'
    and e.metadata->'nativeHarnessBackup'->>'schema' = 'paperclip.native-harness-backup-stamp.v2'
    and not exists (select 1 from native_harness_backups b where b.company_id = r.company_id
      and b.scope_digest = e.metadata->'nativeHarnessBackup'->>'sessionScopeSha256' and b.status = 'current')
    and (s.id::text, coalesce(e.metadata->'nativeHarnessBackup'->>'sessionScopeSha256', '')) > (${""}, ${""})
  order by selected_session_id, scope_digest limit 100`);

describe.skipIf(!support.supported)("native harness backup obligation selection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-obligation-query-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  }, 90_000);
  beforeEach(() => { vi.mocked(hasValidNativeHarnessFilesystemIndependence).mockReset().mockResolvedValue(true); });
  afterEach(async () => { await db.execute(sql`truncate native_harness_backups, agent_task_sessions, environment_leases, heartbeat_runs, issues, agents, companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), foreignCompanyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
    const foreignAgentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.insert(companies).values([{ id: companyId, name: "Selected", issuePrefix: "SEL" },
      { id: foreignCompanyId, name: "Foreign", issuePrefix: "FOR" }]);
    await db.insert(agents).values([{ id: agentId, companyId, name: "Selected" }, { id: otherAgentId, companyId, name: "Other" },
      { id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign" }]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Retained" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerProfileJson: { nativeHarnessFilesystemIndependence: {} } });
    const [selected] = await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner",
      taskKey: randomUUID(), lastRunId: runId }).returning();
    return { companyId, foreignCompanyId, agentId, otherAgentId, foreignAgentId, issueId, runId, sessionId, selected };
  }
  async function stamp(f: Awaited<ReturnType<typeof fixture>>, scope: unknown, extra: Record<string, unknown> = {}, companyId = f.companyId) {
    await db.insert(environmentLeases).values({ companyId, issueId: f.issueId, status: "expired", metadata: {
      nativeHarnessBackup: { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: f.sessionId,
        sessionScopeSha256: scope, ...extra },
    } });
  }
  async function query() {
    let captured!: ReturnType<PgDialect["sqlToQuery"]>;
    await hasLocalNativeHarnessObligations({ execute: async (statement: Parameters<Db["execute"]>[0]) => {
      captured = dialect.sqlToQuery(statement as Parameters<PgDialect["sqlToQuery"]>[0]); return [];
    } } as unknown as Db);
    return captured;
  }
  async function pages(statement: ReturnType<PgDialect["sqlToQuery"]>) {
    const all: unknown[][] = []; let cursor = ["", ""];
    for (;;) {
      const rows = await db.$client.unsafe(statement.sql, cursor).values();
      all.push(...rows);
      if (rows.length < 100) return all;
      cursor = [String(rows.at(-1)![1]), String(rows.at(-1)![2])];
    }
  }

  it("preserves complete rows, tenant and agent bindings, JSON semantics, deduplication and pagination", async () => {
    const f = await fixture();
    await db.insert(agentTaskSessions).values(Array.from({ length: 105 }, () => ({ companyId: f.companyId, agentId: f.agentId,
      adapterType: "paperclip_runner", taskKey: randomUUID(), lastRunId: f.runId })));
    await db.insert(agentTaskSessions).values([
      { companyId: f.companyId, agentId: f.otherAgentId, adapterType: "paperclip_runner", taskKey: randomUUID(), lastRunId: f.runId },
      { companyId: f.foreignCompanyId, agentId: f.foreignAgentId, adapterType: "paperclip_runner", taskKey: randomUUID(), lastRunId: f.runId },
      { companyId: f.companyId, agentId: f.agentId, adapterType: "codex_local", taskKey: randomUUID(), lastRunId: f.runId },
      { companyId: f.companyId, agentId: f.agentId, adapterType: "paperclip_runner", taskKey: randomUUID() },
    ]);
    const flags: Array<[Record<string, unknown> | null, boolean | null]> = [[{}, false], [null, null]];
    const flagSessions: Array<{ id: string; flag: boolean | null }> = [];
    for (const [profile, flag] of flags) {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
        nativeSessionId: f.sessionId, runnerProfileJson: profile }).returning();
      const [selected] = await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId,
        adapterType: "paperclip_runner", taskKey: randomUUID(), lastRunId: run.id }).returning();
      flagSessions.push({ id: selected.id, flag });
    }
    for (const scope of ["covered", "foreign-only", "pending-only", null, 7, { retained: true }]) await stamp(f, scope);
    await stamp(f, "foreign-only");
    for (const extra of [{ normalizedSessionId: f.sessionId.toUpperCase() }, { normalizedSessionId: "malformed" },
      { normalizedSessionId: null }, { normalizedSessionId: 7 }, { schema: "old" }]) await stamp(f, "excluded", extra);
    await stamp(f, "foreign-lease", {}, f.foreignCompanyId);
    await db.insert(nativeHarnessBackups).values([
      { companyId: f.companyId, issueId: f.issueId, runId: f.runId, scopeDigest: "covered", status: "current", manifestSha256: "m", reference: {} },
      { companyId: f.foreignCompanyId, issueId: f.issueId, runId: f.runId, scopeDigest: "foreign-only", status: "current", manifestSha256: "m", reference: {} },
      { companyId: f.companyId, issueId: f.issueId, runId: f.runId, scopeDigest: "pending-only", status: "pending", manifestSha256: "m", reference: {} },
      { companyId: f.companyId, issueId: f.issueId, runId: f.runId, scopeDigest: "", status: "current", manifestSha256: "m", reference: {} },
    ]);
    const candidate = await query(), before = await pages(baseline), after = await pages(candidate);
    expect(after).toEqual(before);
    expect(after).toHaveLength(108 * 5);
    expect(new Set(after.map(row => row[2]))).toEqual(new Set(["", "7", "{\"retained\": true}", "foreign-only", "pending-only"]));
    expect(after.every(row => row[0] === f.companyId)).toBe(true);
    expect(after.filter(row => row[1] === f.selected.id).every(row => row[3] === true)).toBe(true);
    for (const { id, flag } of flagSessions) expect(after.filter(row => row[1] === id).map(row => row[3])).toEqual(Array(5).fill(flag));
  });

  it("validates each uncovered scope across pages and still refuses invalid or absent receipts", async () => {
    const f = await fixture(), scopes = Array.from({ length: 105 }, (_, index) => index.toString().padStart(64, "0"));
    await db.insert(environmentLeases).values(scopes.map(scope => ({ companyId: f.companyId, issueId: f.issueId,
      metadata: { nativeHarnessBackup: { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: f.sessionId, sessionScopeSha256: scope } } })));
    await expect(hasLocalNativeHarnessObligations(db)).resolves.toBe(false);
    expect(vi.mocked(hasValidNativeHarnessFilesystemIndependence).mock.calls.map(([, input]) => input.scopeDigest)).toEqual(scopes);
    expect(vi.mocked(hasValidNativeHarnessFilesystemIndependence).mock.calls.every(([, input]) =>
      input.companyId === f.companyId && input.selectedSessionId === f.selected.id)).toBe(true);
    vi.mocked(hasValidNativeHarnessFilesystemIndependence).mockClear().mockImplementation(async (_db, input) => input.scopeDigest !== scopes[104]);
    await expect(hasLocalNativeHarnessObligations(db)).resolves.toBe(true);
    expect(hasValidNativeHarnessFilesystemIndependence).toHaveBeenCalledTimes(105);
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} });
    vi.mocked(hasValidNativeHarnessFilesystemIndependence).mockClear();
    await expect(hasLocalNativeHarnessObligations(db)).resolves.toBe(true);
    expect(hasValidNativeHarnessFilesystemIndependence).not.toHaveBeenCalled();
  });
});
