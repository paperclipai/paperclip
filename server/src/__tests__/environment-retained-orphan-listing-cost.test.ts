import { randomUUID } from "node:crypto";
import { and, asc, sql, type SQL } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  nextRetainedOrphanDueAt,
  releasableRetainedOrphanCondition,
  retainedOrphanSandboxCondition,
  softlyHeldSql,
} from "../services/environment-retained-orphan-settlement.js";
import { abandonedWorkspaceFilesHeldOnLeaseRowSql } from "../services/remote-workspace-abandoned-files-hold.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = OWNABLE_KINDS.find(kind => kind.id === "environment_retained_orphan_sandbox")!;
const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

function previousAlwaysHeldSql(): SQL {
  return sql`(${environmentLeases.metadata} ?| array['nativeWorkspaceExportResume', 'sandboxStopAndRetain',
      'workspaceRestoreRecovery', 'workspaceRecoveryCleanup', 'runnerTaskSourceConsumer', 'reusableSandboxKeptAfterReplacement']
    or ${abandonedWorkspaceFilesHeldOnLeaseRowSql()}
    or coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') = 'true'
    or coalesce(${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,state}' = 'pending', false)
    or exists (select 1 from heartbeat_runs run where run.id = ${environmentLeases.heartbeatRunId}
      and run.status not in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'))
    or exists (select 1 from heartbeat_runs run where run.id = ${environmentLeases.heartbeatRunId}
      and run.runtime_mode = 'native'
      and run.runner_profile_json#>>'{nativeWorkspaceSync,schema}' in
        ('paperclip.native-workspace-sync/v1', 'paperclip.native-workspace-sync/v2', 'paperclip.native-workspace-sync/v3')
      and run.runner_profile_json#>>'{nativeWorkspaceSync,state}' = 'prepared'
      and coalesce(run.runner_profile_json#>>'{nativeWorkspaceSync,descriptorSha256}' ~ '^[0-9a-f]{64}$', false)
      and coalesce(run.runner_profile_json#>>'{nativeWorkspaceSync,baselineSha256}' ~ '^[0-9a-f]{64}$', false)
      and coalesce(jsonb_typeof(run.runner_profile_json#>'{nativeWorkspaceSync,finalHostSha256}'), 'null') = 'null'
      and jsonb_typeof(run.runner_profile_json#>'{nativeWorkspaceSync,workspaceId}') = 'string'
      and jsonb_typeof(run.runner_profile_json#>'{nativeWorkspaceSync,remoteCwd}') = 'string'
      and coalesce(run.runner_profile_json#>>'{nativeWorkspaceSync,resourceDisposition}', 'destroy')
        in ('keep_running', 'stop_and_retain', 'destroy')
      and run.runner_profile_json#>>'{nativeWorkspaceSync,leaseId}' = ${environmentLeases.id}::text
      and run.runner_profile_json#>>'{nativeWorkspaceSync,providerLeaseId}' = ${environmentLeases.providerLeaseId}
      and coalesce(run.runner_profile_json#>>'{nativeExecutionInput,workspace,access}', '') <> 'none')
    or exists (select 1 from environment_leases other where other.id <> ${environmentLeases.id}
      and other.provider = ${environmentLeases.provider} and other.provider_lease_id = ${environmentLeases.providerLeaseId}
      and other.status in ('active', 'retained', 'pending_cleanup')))`;
}

function previousReleasableCondition(now?: Date) {
  return and(retainedOrphanSandboxCondition(), sql`not ${previousAlwaysHeldSql()}`, sql`not (${softlyHeldSql(now)})`);
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type PlanNode = { "Relation Name"?: string; "Actual Loops"?: number; "Actual Rows"?: number;
  "Rows Removed by Filter"?: number; Plans?: PlanNode[] };

function heartbeatRunRowsRead(node: PlanNode): number {
  const own = node["Relation Name"] === "heartbeat_runs"
    ? (node["Actual Loops"] ?? 0) * ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) : 0;
  return own + (node.Plans ?? []).reduce((total, child) => total + heartbeatRunRowsRead(child), 0);
}

suite("retained orphan sandbox listing cost", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tenants: Array<{ companyId: string; agentId: string; issueIds: string[]; workspaceIds: string[] }> = [];
  let environmentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-retained-orphan-listing-");
    db = createDb(temporary.connectionString);
    environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: "Fake Sandbox", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "ubuntu:24.04" } });
    for (const prefix of ["ROA", "ROB"]) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: prefix, issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false });
      await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
      const workspaceIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const [workspace] = await db.insert(executionWorkspaces).values({ companyId, mode: "isolated_workspace",
          strategyType: "git_worktree", name: `${prefix} workspace ${index}` }).returning({ id: executionWorkspaces.id });
        workspaceIds.push(workspace!.id);
      }
      const issueIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const issueId = randomUUID();
        await db.insert(issues).values({ id: issueId, companyId, title: `${prefix} issue ${index}`,
          executionWorkspaceId: index < 3 ? workspaceIds[index] : null });
        issueIds.push(issueId);
      }
      tenants.push({ companyId, agentId, issueIds, workspaceIds });
    }
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function seedVariedFixture(seed: number, count: number) {
    const next = random(seed);
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    const chance = (probability: number) => next() < probability;
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    const leases: Array<typeof environmentLeases.$inferInsert> = [];
    const base = Date.now() - 24 * 60 * 60_000;
    for (let index = 0; index < count; index += 1) {
      const tenant = pick(tenants);
      const leaseId = randomUUID();
      const provider = pick(["fake", "fake", "fake", "local", null]);
      const providerLeaseId = chance(0.9) ? `sbx-${Math.floor(next() * 300)}` : null;
      let runId: string | null = null;
      if (chance(0.9)) {
        runId = randomUUID();
        const sync = pick(["none", "prepared", "prepared", "access_none", "other_sandbox", "bad_descriptor", "final"]);
        const runnerProfileJson = sync === "none" ? {} : {
          ...(sync === "access_none" ? { nativeExecutionInput: { workspace: { access: "none" } } } : {}),
          nativeWorkspaceSync: {
            schema: pick(["paperclip.native-workspace-sync/v3", "paperclip.native-workspace-sync/v1", "unknown"]),
            state: "prepared", descriptorSha256: sync === "bad_descriptor" ? "zz" : "a".repeat(64),
            baselineSha256: "b".repeat(64), finalHostSha256: sync === "final" ? "c".repeat(64) : null,
            workspaceId: randomUUID(), remoteCwd: "/workspace", resourceDisposition: pick(["destroy", "keep_running", "odd"]),
            leaseId, providerLeaseId: sync === "other_sandbox" ? "sbx-elsewhere" : providerLeaseId,
          },
        };
        runs.push({ id: runId, companyId: tenant.companyId, agentId: tenant.agentId, issueId: pick(tenant.issueIds),
          nativeIssueId: chance(0.2) ? pick(tenant.issueIds) : null, invocationSource: "on_demand",
          status: chance(0.06) ? pick(["running", "queued", "scheduled_retry"]) : pick(TERMINAL), nextEventSeq: 1,
          runtimeMode: pick(["native", "native", "legacy"]), runnerProfileJson });
      }
      const terminationRunId = chance(0.85) ? runId : randomUUID();
      const metadata: Record<string, unknown> = {};
      if (chance(0.75)) metadata.orphanedRunLeaseRecovery = { recoveredAt: "x" };
      if (chance(0.85)) metadata.sandboxStopAndRetainReceipt = { stoppedAt: "x" };
      if (chance(0.75)) metadata.remoteExecutionTermination = { state: pick(["stopped", "stopped", "running"]),
        leaseId: chance(0.85) ? leaseId : randomUUID(), runId: terminationRunId };
      for (const key of ["nativeWorkspaceExportResume", "sandboxStopAndRetain", "workspaceRestoreRecovery",
        "workspaceRecoveryCleanup", "runnerTaskSourceConsumer", "reusableSandboxKeptAfterReplacement"]) {
        if (chance(0.04)) metadata[key] = { at: "x" };
      }
      if (chance(0.1)) metadata.pendingCleanupInFlight = pick([true, false, "true", "maybe"]);
      if (chance(0.06)) metadata.legacyShutdownWorkspaceSettlement = { state: pick(["pending", "done"]) };
      const expiresRoll = next();
      leases.push({ id: leaseId, companyId: tenant.companyId, environmentId,
        executionWorkspaceId: chance(0.7) ? pick(tenant.workspaceIds) : null,
        issueId: chance(0.9) ? pick(tenant.issueIds) : null, heartbeatRunId: runId,
        status: pick(["released", "released", "released", "failed", "failed", "retained", "retained", "expired", "active", "pending_cleanup"]),
        leasePolicy: pick(["ephemeral", "ephemeral", "reuse_by_environment", "reuse_by_environment", "retain_on_failure"]),
        provider, providerLeaseId, cleanupStatus: pick(["success", "success", "success", "success", "failed", null]),
        metadata: chance(0.03) ? null : metadata,
        expiresAt: expiresRoll < 0.3 ? null : new Date(Date.now() + (expiresRoll < 0.6 ? -1 : 1) * 60 * 60_000),
        createdAt: new Date(base + Math.floor(next() * 5) * 1000) });
    }
    for (let index = 0; index < runs.length; index += 200) await db.insert(heartbeatRuns).values(runs.slice(index, index + 200));
    for (let index = 0; index < leases.length; index += 200) {
      await db.insert(environmentLeases).values(leases.slice(index, index + 200));
    }
    for (const tenant of tenants) {
      for (const issueId of tenant.issueIds) {
        if (!chance(0.25)) continue;
        await db.insert(issueRecoveryActions).values({ companyId: tenant.companyId, sourceIssueId: issueId,
          kind: "active_run_watchdog", status: pick(["active", "resolved", "cancelled", "escalated"]),
          cause: "fixture", fingerprint: randomUUID(), nextAction: "Recover the workspace." });
      }
    }
  }

  async function previousPage(limit: number, offset: number, now?: Date) {
    const rows = await db.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(previousReleasableCondition(now)).orderBy(asc(environmentLeases.id)).limit(limit + 1).offset(offset);
    return { truncated: rows.length > limit, ids: rows.slice(0, limit).map(row => row.id) };
  }

  it("lists exactly the rows the previous listing listed, page by page, over a varied fixture", async () => {
    for (const seed of [11, 29, 47, 83]) {
      await seedVariedFixture(seed, 600);
      const expected = await previousPage(10_000, 0);
      expect(expected.ids.length).toBeGreaterThan(0);
      expect(expected.ids.length).toBeLessThan(600);
      for (const limit of [7, 200]) {
        for (let offset = 0; ; offset += limit) {
          const [listed, previous] = await Promise.all([KIND.listInProgress!(db, limit, offset), previousPage(limit, offset)]);
          expect(listed.records.map(record => record.recordId)).toEqual(previous.ids);
          expect(listed.truncated).toBe(previous.truncated);
          if (!previous.truncated) break;
        }
      }
      const now = new Date();
      const [current] = await db.select({ count: sql<number>`count(*)::int` }).from(environmentLeases)
        .where(releasableRetainedOrphanCondition(now));
      expect(current!.count).toBe(expected.ids.length);
      const [previousDue] = await db.select({ due: sql<string | null>`min(${environmentLeases.expiresAt})` })
        .from(environmentLeases).where(and(retainedOrphanSandboxCondition(), sql`not ${previousAlwaysHeldSql()}`,
          sql`${softlyHeldSql(now)}`, sql`${environmentLeases.expiresAt} is not null`));
      expect((await nextRetainedOrphanDueAt(db, now))?.getTime() ?? null)
        .toBe(previousDue?.due ? new Date(previousDue.due).getTime() : null);
      await db.delete(issueRecoveryActions);
      await db.delete(environmentLeases);
      await db.delete(heartbeatRuns);
    }
  }, 120_000);

  async function seedHistory(count: number) {
    const tenant = tenants[0]!;
    await db.execute(sql`
      with history as (
        select gen_random_uuid() as run_id, gen_random_uuid() as lease_id, g from generate_series(1, ${count}) g
      ), inserted as (
        insert into heartbeat_runs (id, company_id, agent_id, issue_id, invocation_source, status, next_event_seq,
          runtime_mode, runner_profile_json)
        select run_id, ${tenant.companyId}::uuid, ${tenant.agentId}::uuid, ${tenant.issueIds[0]}::uuid, 'on_demand',
          'succeeded', 1, 'native', jsonb_build_object('nativeWorkspaceSync', jsonb_build_object(
            'schema', 'paperclip.native-workspace-sync/v3', 'state', 'finalized', 'leaseId', lease_id::text))
        from history returning id
      )
      insert into environment_leases (id, company_id, environment_id, execution_workspace_id, issue_id, heartbeat_run_id,
        status, lease_policy, provider, provider_lease_id, cleanup_status, metadata, expires_at)
      select lease_id, ${tenant.companyId}::uuid, ${environmentId}::uuid, ${tenant.workspaceIds[0]}::uuid,
        ${tenant.issueIds[0]}::uuid, run_id,
        case when g % 100 < 71 then 'expired' when g % 100 < 96 then 'released' else 'failed' end,
        case when g % 3 = 0 then 'reuse_by_environment' else 'ephemeral' end,
        'fake', 'sbx-history-' || (g % 50), 'success', jsonb_build_object('sandboxStopAndRetainReceipt', '{}'::jsonb),
        now() + interval '1 day'
      from history`);
    await db.execute(sql`analyze heartbeat_runs; analyze environment_leases`);
  }

  async function listingPlan() {
    const query = db.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(releasableRetainedOrphanCondition()).orderBy(asc(environmentLeases.id)).limit(201).offset(0).toSQL();
    const rows = await db.$client.unsafe(`explain (analyze, format json) ${query.sql}`, query.params as never[]);
    return (rows[0] as unknown as { "QUERY PLAN": Array<{ Plan: PlanNode }> })["QUERY PLAN"][0]!.Plan;
  }

  it("reads heartbeat runs only for retained orphan candidates, not for the whole lease history", async () => {
    await seedHistory(2_000);
    await seedVariedFixture(5, 20);
    const [{ candidates }] = await db.select({ candidates: sql<number>`count(*)::int` }).from(environmentLeases)
      .where(retainedOrphanSandboxCondition()) as Array<{ candidates: number }>;
    const plan = await listingPlan();
    expect(heartbeatRunRowsRead(plan)).toBeLessThanOrEqual(10 * candidates + 50);
  }, 120_000);

  it("lets a schema change take the heartbeat_runs lock within a 5 second lock timeout while listings run", async () => {
    await seedHistory(5_000);
    let stop = false;
    let listings = 0;
    const load = (async () => {
      while (!stop) {
        await KIND.listInProgress!(db, 200, 0);
        listings += 1;
      }
    })();
    const ddl = createDb(temporary!.connectionString);
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      const started = Date.now();
      await ddl.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`alter table heartbeat_runs add column retained_orphan_listing_probe jsonb`);
        await tx.execute(sql`alter table heartbeat_runs drop column retained_orphan_listing_probe`);
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      stop = true;
      await load;
      await ddl.$client.end({ timeout: 1 });
    }
    expect(listings).toBeGreaterThan(0);
  }, 120_000);
});
