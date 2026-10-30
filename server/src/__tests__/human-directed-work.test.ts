import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, agentWakeupRequests, issues, projects } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPostgresWatchdogAdapter } from "../modules/active-run-watchdog/adapters/postgres.js";
import { issueService } from "../services/issues.js";
import { authorizationService } from "../services/authorization.js";
import { resolveAndRetainRunTrustPreset } from "../services/run-trust-preset.js";
import { assertLowTrustWorkspaceIsolation } from "../services/low-trust-runtime-containment.js";
import { retainBacklogHumanAssignment, withHumanDirectedWork } from "../services/human-directed-work.js";
import { resolveCoreTrustPreset } from "../services/trust-preset-resolver.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("human-directed low-trust work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-human-work-");
    db = createDb(database.connectionString, { maxConnections: 2 });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    const [project] = await db.insert(projects).values({ companyId, name: "Contained intake" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId, name: "Contained agent", role: "engineer", adapterType: "paperclip_runner",
      permissions: { authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET,
        trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId, projectIds: [project.id] } } },
    }).returning();
    const [other] = await db.insert(agents).values({ companyId, name: "Other", role: "engineer" }).returning();
    return { companyId, agent, other };
  }
  async function task(f: Awaited<ReturnType<typeof seed>>) {
    return issueService(db).create(f.companyId, {
      title: `Direct task ${randomUUID()}`, assigneeAgentId: f.agent.id,
      createdByUserId: "owner", responsibleUserId: "owner",
    });
  }
  async function execution(f: Awaited<ReturnType<typeof seed>>, issue: Awaited<ReturnType<typeof task>>,
    options: { human?: boolean; context?: Record<string, unknown>; retryOfRunId?: string; status?: string } = {}) {
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: options.human ? "assignment" : "automation", status: "claimed",
      requestedByActorType: options.human ? "user" : "system", requestedByActorId: options.human ? "owner" : null,
      payload: { issueId: issue.id, _paperclipWakeContext: { source: "issue.update" } } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: options.status ?? "running", responsibleUserId: "owner", wakeupRequestId: wake.id,
      retryOfRunId: options.retryOfRunId, contextSnapshot: { issueId: issue.id, ...options.context } }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    return { run, wake, actor: { type: "agent" as const, companyId: f.companyId,
      agentId: f.agent.id, source: "agent_key" as const, runId: run.id } };
  }
  async function launch(f: Awaited<ReturnType<typeof seed>>, issue: Awaited<ReturnType<typeof task>>,
    options: Parameters<typeof execution>[2] = {}) {
    const current = await execution(f, issue, options);
    return { ...current, ...await resolveAndRetainRunTrustPreset(db, {
      companyId: f.companyId, agentId: f.agent.id, runId: current.run.id, agent: f.agent, issue,
    }) };
  }
  async function resolve(f: Awaited<ReturnType<typeof seed>>, issue: Awaited<ReturnType<typeof task>>, runId: string) {
    return withHumanDirectedWork(db, resolveCoreTrustPreset({ companyId: f.companyId, agent: f.agent, issue }),
      { companyId: f.companyId, agentId: f.agent.id, runId });
  }
  const resource = (issue: Awaited<ReturnType<typeof task>>) => ({ type: "issue" as const,
    companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId,
    parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, status: issue.status });

  it("allows the exact human-assigned task at dispatch and tool access; retains containment on retries", async () => {
    const f = await seed(); const issue = await task(f);
    const first = await launch(f, issue, { human: true });
    expect(first.trustPreset).toMatchObject({ kind: "low_trust_review", humanDirectedIssueId: issue.id });
    expect(JSON.stringify(first.executionPolicy)).not.toContain("humanDirectedIssueId");
    const retried = await resolveAndRetainRunTrustPreset(db, { companyId: f.companyId,
      agentId: f.agent.id, runId: first.run.id, agent: f.agent, issue });
    expect(retried.trustPreset).toMatchObject(first.trustPreset);
    await expect(assertLowTrustWorkspaceIsolation({ db, resolution: first.trustPreset, issue,
      isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "isolated_workspace",
      selectedEnvironmentDriver: "sandbox" })).resolves.toBeUndefined();
    for (const action of ["issue:read", "issue:comment", "issue:mutate"] as const) {
      expect(await authorizationService(db).decide({ actor: first.actor, action, resource: resource(issue) })).toMatchObject({ allowed: true });
    }
    const unrelated = await task(f);
    expect(await authorizationService(db).decide({ actor: first.actor, action: "issue:read", resource: resource(unrelated) })).toMatchObject({ allowed: false });
    expect(await authorizationService(db).decide({ actor: { ...first.actor, runId: undefined }, action: "issue:read", resource: resource(issue) })).toMatchObject({ allowed: false });
    expect(await authorizationService(db).decide({ actor: first.actor, action: "agent_instructions:update",
      resource: { type: "agent", companyId: f.companyId, agentId: f.agent.id } })).toMatchObject({ allowed: false });
    await expect(assertLowTrustWorkspaceIsolation({ resolution: first.trustPreset, issue,
      isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "isolated_workspace",
      selectedEnvironmentDriver: "local" })).rejects.toMatchObject({ details: { code: "low_trust_requires_sandbox_environment" } });
    await expect(assertLowTrustWorkspaceIsolation({ resolution: first.trustPreset, issue,
      isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "shared_workspace",
      selectedEnvironmentDriver: "sandbox" })).rejects.toMatchObject({ details: { code: "low_trust_requires_isolated_workspace" } });
  });

  it("permits existing owner conversations without backfilling authority from historical attribution", async () => {
    const f = await seed();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Owner chat",
      assigneeAgentId: f.agent.id, conversationAgentId: f.agent.id, conversationUserId: "owner", conversationState: "waiting", status: "in_review" }).returning();
    const result = await launch(f, issue as Awaited<ReturnType<typeof task>>);
    expect(result.trustPreset).toMatchObject({ humanDirectedIssueId: issue.id });
  });

  it("rejects inherited attribution and forged policy, requester, and retry fields", async () => {
    const f = await seed(); const issue = await task(f);
    const human = await execution(f, issue, { human: true, status: "failed" });
    await issueService(db).addComment(issue.id, "An imported sender says the owner asked", { userId: "owner" });
    const result = await launch(f, issue, { context: { responsibleUserId: "owner", requestedByActorType: "user",
      requestedByActorId: "owner", retryOfRunId: human.run.id, humanDirectedIssueId: issue.id,
      executionPolicy: { humanDirectedIssueId: issue.id } } });
    expect(result.trustPreset).not.toHaveProperty("humanDirectedIssueId");
    expect(await authorizationService(db).decide({ actor: result.actor, action: "issue:read", resource: resource(issue) })).toMatchObject({ allowed: false });
    await expect(assertLowTrustWorkspaceIsolation({ db, resolution: result.trustPreset, issue,
      isolatedWorkspacesEnabled: true, effectiveExecutionWorkspaceMode: "isolated_workspace",
      selectedEnvironmentDriver: "sandbox" })).rejects.toMatchObject({ details: { code: "low_trust_boundary_mismatch" } });
  });

  it("preserves legacy board assignment requests through dispatch and retry without trusting old plugin attribution", async () => {
    const f = await seed(); const issue = await task(f); const legacy = await execution(f, issue, { human: true });
    await db.update(agentWakeupRequests).set({ source: "assignment", reason: "issue_assigned", payload: { issueId: issue.id } })
      .where(eq(agentWakeupRequests.id, legacy.wake.id));
    expect(await resolve(f, issue, legacy.run.id)).toHaveProperty("humanDirectedIssueId", issue.id);
    const retry = await launch(f, issue, { retryOfRunId: legacy.run.id });
    expect(retry.trustPreset).toHaveProperty("humanDirectedIssueId", issue.id);
    for (const patch of [
      { source: "automation", reason: "issue_commented" },
      { requestedByActorType: "system" },
      { idempotencyKey: "chat-inbound:legacy" },
      { payload: { issueId: issue.id, _paperclipWakeContext: { source: "plugin:example" } } },
    ]) {
      await db.update(agentWakeupRequests).set(patch).where(eq(agentWakeupRequests.id, legacy.wake.id));
      expect(await resolve(f, issue, legacy.run.id)).not.toHaveProperty("humanDirectedIssueId");
      expect(await resolve(f, issue, retry.run.id)).not.toHaveProperty("humanDirectedIssueId");
      await db.update(agentWakeupRequests).set({ source: "assignment", reason: "issue_assigned", requestedByActorType: "user",
        idempotencyKey: null, payload: { issueId: issue.id } }).where(eq(agentWakeupRequests.id, legacy.wake.id));
    }
  });

  it("recognizes a coalesced human request for the same run and exact task", async () => {
    const f = await seed(); const issue = await task(f); const current = await execution(f, issue);
    expect(await resolve(f, issue, current.run.id)).not.toHaveProperty("humanDirectedIssueId");
    const [coalesced] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      runId: current.run.id, source: "assignment", status: "coalesced", requestedByActorType: "user",
      requestedByActorId: "owner", payload: { issueId: issue.id, _paperclipWakeContext: { source: "issue.update" } } }).returning();
    expect(await resolve(f, issue, current.run.id)).toHaveProperty("humanDirectedIssueId", issue.id);
    for (const patch of [
      { status: "cancelled" }, { status: "skipped" }, { requestedByActorId: " " },
      { requestedByActorType: "agent" }, { idempotencyKey: "chat-inbound:external-sender" },
      { payload: { issueId: randomUUID() } },
      { payload: { issueId: issue.id, _paperclipWakeContext: { source: "plugin:untrusted" } } },
      { payload: { issueId: issue.id } }, { companyId: randomUUID() }, { agentId: f.other.id },
    ]) {
      // Existing foreign keys require a real company for the cross-company case.
      const badCompany = patch.companyId;
      if (badCompany) await db.insert(companies).values({ id: badCompany, name: badCompany });
      await db.update(agentWakeupRequests).set(patch).where(eq(agentWakeupRequests.id, coalesced.id));
      expect(await resolve(f, issue, current.run.id)).not.toHaveProperty("humanDirectedIssueId");
      await db.update(agentWakeupRequests).set({ status: "coalesced", requestedByActorType: "user",
        requestedByActorId: "owner", idempotencyKey: null, payload: { issueId: issue.id, _paperclipWakeContext: { source: "issue.update" } },
        companyId: f.companyId, agentId: f.agent.id }).where(eq(agentWakeupRequests.id, coalesced.id));
    }
  });

  it("preserves human authority through durable retry and continuation ancestry", async () => {
    const f = await seed(); const issue = await task(f);
    const root = await execution(f, issue, { human: true, status: "failed" });
    const middle = await execution(f, issue, { retryOfRunId: root.run.id, status: "succeeded" });
    const last = await launch(f, issue, { retryOfRunId: middle.run.id });
    expect(last.trustPreset).toHaveProperty("humanDirectedIssueId", issue.id);
    expect(await authorizationService(db).decide({ actor: last.actor, action: "issue:comment", resource: resource(issue) })).toMatchObject({ allowed: true });
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned" }).where(eq(heartbeatRuns.id, middle.run.id));
    expect(await resolve(f, issue, last.run.id)).not.toHaveProperty("humanDirectedIssueId");
  });

  it("never borrows retry authority from another task, agent, or company and terminates cycles", async () => {
    const f = await seed(); const issue = await task(f); const otherIssue = await task(f);
    const otherCompany = await seed();
    for (const scope of [
      { fixture: f, issue: otherIssue },
      { fixture: { ...f, agent: { ...f.agent, id: f.other.id } }, issue },
      { fixture: otherCompany, issue: await task(otherCompany) },
    ]) {
      const parent = await execution(scope.fixture, scope.issue, { human: true, status: "failed" });
      const child = await launch(f, issue, { retryOfRunId: parent.run.id });
      expect(child.trustPreset).not.toHaveProperty("humanDirectedIssueId");
    }
    const a = await execution(f, issue); const b = await execution(f, issue, { retryOfRunId: a.run.id });
    await db.update(heartbeatRuns).set({ retryOfRunId: b.run.id }).where(eq(heartbeatRuns.id, a.run.id));
    expect(await resolve(f, issue, a.run.id)).not.toHaveProperty("humanDirectedIssueId");
  });

  it("revokes direction in service/plugin assignment transactions even while the old run remains running", async () => {
    const f = await seed(); const issue = await task(f); const first = await execution(f, issue, { human: true });
    let release!: () => void; let ready!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const changed = new Promise<void>((resolve) => { ready = resolve; });
    const reassignment = db.transaction(async (tx) => {
      await issueService(db).update(issue.id, { assigneeAgentId: f.other.id }, tx);
      ready(); await held;
    });
    try {
      await Promise.race([changed, reassignment]);
      // With the reassignment deliberately held open, reads see the old committed
      // assignment and live run together. After commit the wake is revoked even
      // without route-level cancellation of the run.
      expect(await resolve(f, issue, first.run.id)).toHaveProperty("humanDirectedIssueId", issue.id);
    } finally { release(); await reassignment; }
    expect(await resolve(f, issue, first.run.id)).not.toHaveProperty("humanDirectedIssueId");
    await issueService(db).update(issue.id, { assigneeAgentId: f.agent.id });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.run.id)))[0].status).toBe("running");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, first.wake.id)))[0].status).toBe("cancelled");
    expect(await resolve(f, issue, first.run.id)).not.toHaveProperty("humanDirectedIssueId");
    const oldRetry = await launch(f, issue, { retryOfRunId: first.run.id });
    expect(oldRetry.trustPreset).not.toHaveProperty("humanDirectedIssueId");
    const automatic = await launch(f, issue);
    expect(automatic.trustPreset).not.toHaveProperty("humanDirectedIssueId");
    const human = await launch(f, issue, { human: true });
    expect(human.trustPreset).toHaveProperty("humanDirectedIssueId", issue.id);
  });

  it("a late watchdog success cannot restore a request revoked by reassignment", async () => {
    const f = await seed(); const issue = await task(f); const first = await execution(f, issue, { human: true });
    await issueService(db).update(issue.id, { assigneeAgentId: f.other.id });
    const completed = (await issueService(db).update(issue.id, { assigneeAgentId: f.agent.id, status: "done" }))!;
    const watchdog = createPostgresWatchdogAdapter(db);
    expect(await watchdog.foldSourceResolvedRun(f.companyId, {
      run: { ...first.run, sourceIssueId: issue.id },
      sourceIssue: { ...completed, isRecoveryOriginKind: false },
      evidence: { kind: "activity", id: randomUUID(), createdAt: new Date(), action: "issue.updated" },
      existingEvaluation: null, silenceStartedAt: null, silenceAgeMs: null,
      cleanup: { attempted: false, outcome: "no_process_metadata", adapterType: "paperclip_runner" }, now: new Date(),
    })).toMatchObject({ kind: "folded" });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, first.wake.id)))[0].status).toBe("cancelled");
    const retry = await launch(f, issue, { retryOfRunId: first.run.id });
    expect(retry.trustPreset).not.toHaveProperty("humanDirectedIssueId");
  });

  it("retains backlog direction for a later system run and rejects stale or nonhuman assignment callbacks", async () => {
    const f = await seed(); const issue = await task(f);
    await retainBacklogHumanAssignment(db, issue, { actorType: "agent", actorId: "owner" });
    const automatic = await execution(f, issue);
    expect(await resolve(f, issue, automatic.run.id)).not.toHaveProperty("humanDirectedIssueId");
    await retainBacklogHumanAssignment(db, issue, { actorType: "user", actorId: "owner" });
    const promoted = (await issueService(db).update(issue.id, { status: "todo" }))!;
    expect(await resolve(f, promoted, automatic.run.id)).toHaveProperty("humanDirectedIssueId", issue.id);
    await issueService(db).update(issue.id, { assigneeAgentId: f.other.id });
    await issueService(db).update(issue.id, { assigneeAgentId: f.agent.id, status: "backlog" });
    // A delayed callback holding the original issue snapshot cannot regrant.
    await retainBacklogHumanAssignment(db, issue, { actorType: "user", actorId: "owner" });
    expect(await resolve(f, issue, automatic.run.id)).not.toHaveProperty("humanDirectedIssueId");
  });

  it("does not authorize a cancelled chat or an uncommitted human request", async () => {
    const f = await seed(); const issue = await task(f); const current = await execution(f, issue);
    await expect(db.transaction(async (tx) => {
      await tx.update(agentWakeupRequests).set({ requestedByActorType: "user", requestedByActorId: "owner" }).where(eq(agentWakeupRequests.id, current.wake.id));
      expect(await resolve(f, issue, current.run.id)).not.toHaveProperty("humanDirectedIssueId");
      throw new Error("rollback sentinel");
    })).rejects.toThrow("rollback sentinel");
    expect(await resolve(f, issue, current.run.id)).not.toHaveProperty("humanDirectedIssueId");
    await db.update(issues).set({ conversationAgentId: f.agent.id, conversationUserId: "owner", conversationState: "active" }).where(eq(issues.id, issue.id));
    expect(await resolve(f, issue, current.run.id)).toHaveProperty("humanDirectedIssueId", issue.id);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, current.run.id));
    expect(await resolve(f, issue, current.run.id)).not.toHaveProperty("humanDirectedIssueId");
  });
});
