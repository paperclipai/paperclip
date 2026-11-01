import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, decisionRetention, issueRecoveryActions, issueRelations, issues } from "@paperclipai/db";
import type { AttentionSourceKind } from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import { decisionRetentionService } from "../services/decision-retention.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RETENTION_MATERIALIZATION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("retention first-materialization security", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string, agentId: string, userId: string;
  const users: string[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("retention-security-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID(); users.push(userId);
    await db.insert(authUsers).values({ id: userId, name: "Security operator", email: `${userId}@retention.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Materialization", issuePrefix: `S${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Source agent", status: "idle", adapterType: "process" });
  });
  afterEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { if (db) { await db.delete(authUsers).where(inArray(authUsers.id, users)); await db.$client.end(); } await temporary?.cleanup(); });
  const mutation = (sourceKind: AttentionSourceKind, sourceId: string) => ({ companyId, sourceKind, sourceId,
    authActor: { type: "board" as const, source: "local_implicit" as const, userId, companyIds: [companyId], isInstanceAdmin: true },
    actor: { actorType: "user" as const, actorId: userId, userId, agentId: null, runId: null, agentApiKeyId: null, responsibleUserId: userId } });
  async function issue(values: Partial<typeof issues.$inferInsert> = {}) {
    return (await db.insert(issues).values({ companyId, title: "Security source", status: "todo", createdByAgentId: agentId, ...values }).returning())[0]!;
  }
  async function visible(sourceKind: AttentionSourceKind, sourceId: string) {
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true, userId, excludeSources: ["approval", "join_request"] });
    return feed.items.some(item => item.sourceKind === sourceKind && item.subject.id === sourceId);
  }

  it("cannot pre-archive an unseen agent recovery before ordinary retry exhaustion asks the board for help", async () => {
    const row = await issue();
    const owner = issueRecoveryActionService(db);
    const input = { companyId, sourceIssueId: row.id, kind: "stranded_assigned_issue" as const,
      ownerType: "agent" as const, ownerAgentId: agentId, cause: "fixture", fingerprint: "same-recovery",
      nextAction: "Retry the existing work", maxAttempts: 2 };
    const action = await owner.upsertSourceScoped(input);
    expect(action).toMatchObject({ ownerType: "agent", status: "active" });
    let rejected: unknown;
    try { await decisionRetentionService(db).archive(mutation("recovery_action", action.id)); } catch (error) { rejected = error; }
    const escalated = await owner.upsertSourceScoped(input);
    expect(escalated).toMatchObject({ id: action.id, ownerType: "board", status: "escalated" });
    expect(await visible("recovery_action", action.id)).toBe(true);
    expect(rejected).toMatchObject({ status: 404 });
    expect((await decisionRetentionService(db).getState(companyId, "recovery_action", action.id))?.archivedAt).toBeNull();
  });

  it.each(["system", "resolved", "hidden", "harness", "conversation", "other_company"] as const)(
    "rejects first retention state for a currently ineligible recovery source: %s", async scenario => {
      const foreignCompany = randomUUID();
      if (scenario === "other_company") await db.insert(companies).values({ id: foreignCompany, name: "Foreign source", issuePrefix: `F${foreignCompany.slice(0, 6)}` });
      const row = await issue({ companyId: scenario === "other_company" ? foreignCompany : companyId,
        hiddenAt: scenario === "hidden" ? new Date() : null, harnessKind: scenario === "harness" ? "fixture" : null,
        ...(scenario === "conversation" ? { conversationAgentId: agentId, conversationUserId: userId, assigneeAgentId: agentId, conversationState: "active", status: "in_progress" } : {}) });
      const [action] = await db.insert(issueRecoveryActions).values({ companyId: row.companyId, sourceIssueId: row.id,
        kind: "stranded_assigned_issue", cause: "fixture", fingerprint: scenario, nextAction: "Recover",
        ownerType: scenario === "system" ? "system" : "board", status: scenario === "resolved" ? "resolved" : "active" }).returning();
      await expect(decisionRetentionService(db).archive(mutation("recovery_action", action.id))).rejects.toMatchObject({ status: 404 });
      expect(await db.select().from(decisionRetention).where(eq(decisionRetention.sourceId, action.id))).toEqual([]);
    });

  it("preserves existing recovery manual controls and legacy agent-owned TTL archival", async () => {
    const row = await issue(), owner = issueRecoveryActionService(db), retention = decisionRetentionService(db);
    const input = { companyId, sourceIssueId: row.id, kind: "stranded_assigned_issue" as const,
      cause: "fixture", fingerprint: "known-recovery", nextAction: "Recover" };
    const action = await owner.upsertSourceScoped({ ...input, ownerType: "board" });
    expect(await visible("recovery_action", action.id)).toBe(true);
    await owner.upsertSourceScoped({ ...input, ownerType: "agent", ownerAgentId: agentId });
    expect((await retention.archive(mutation("recovery_action", action.id))).archivedAt).toBeInstanceOf(Date);
    await retention.revive(mutation("recovery_action", action.id));
    await retention.setKeep({ ...mutation("recovery_action", action.id), keep: true });
    await retention.setKeep({ ...mutation("recovery_action", action.id), keep: false });
    // An already materialized legacy row retains its existing TTL contract.
    const activityAt = new Date(Date.now() - 100 * 86_400_000).toISOString();
    await db.update(issueRecoveryActions).set({ updatedAt: new Date(activityAt) }).where(eq(issueRecoveryActions.id, action.id));
    const states = await retention.syncItems(companyId, [{ sourceKind: "recovery_action", subject: { id: action.id }, activityAt }]);
    const state = [...states.values()][0];
    expect(await retention.autoArchive({ companyId, items: [{ sourceKind: "recovery_action", subject: { id: action.id }, activityAt,
      keep: state.keep, archivedAt: null, retentionVersion: state.version }] })).toBe(1);
    expect(await retention.getState(companyId, "recovery_action", action.id)).toMatchObject({ archivedReason: "idle_ttl" });
  });

  it.each(["review", "blocker_attention"] as const)("cannot pre-archive a future %s before an ordinary transition makes it visible", async kind => {
    const row = await issue({ assigneeUserId: userId });
    let rejected: unknown;
    try { await decisionRetentionService(db).archive(mutation(kind, row.id)); } catch (error) { rejected = error; }
    await issueService(db).update(row.id, kind === "review"
      ? { status: "in_review", actorUserId: userId }
      : { status: "blocked", unblockDescriptor: { owner: "board", action: "Choose the next owner" }, actorUserId: userId });
    expect(await visible(kind, row.id)).toBe(true);
    expect(rejected).toMatchObject({ status: 404 });
    expect((await decisionRetentionService(db).getState(companyId, kind, row.id))?.archivedAt).toBeNull();
  });

  it.each(["review", "blocker_attention", "productivity_review"] as const)("does not materialize Keep for an ineligible %s", async kind => {
    const row = await issue();
    await expect(decisionRetentionService(db).setKeep({ ...mutation(kind, row.id), keep: true })).rejects.toMatchObject({ status: 404 });
    expect(await decisionRetentionService(db).getState(companyId, kind, row.id)).toBeNull();
  });

  it("allows Keep on an unseen eligible review and preserves existing manual actions after it leaves review", async () => {
    const row = await issue({ status: "in_review", assigneeUserId: userId });
    const service = decisionRetentionService(db), input = mutation("review", row.id);
    expect(await service.getState(companyId, "review", row.id)).toBeNull();
    expect((await service.setKeep({ ...input, keep: true })).keep).toBe(true);
    await issueService(db).update(row.id, { status: "todo", actorUserId: userId });
    expect((await service.archive(input)).archivedReason).toBe("manual");
    expect((await service.setKeep({ ...input, keep: false })).keep).toBe(false);
    expect((await service.revive(input)).archivedAt).toBeNull();
  });

  it("allows unseen current board-owned blocker attention", async () => {
    const row = await issue({ status: "blocked", unblockDescriptor: { owner: "board", action: "Choose next owner" }, blockedTransitionAt: new Date() });
    expect((await decisionRetentionService(db).setKeep({ ...mutation("blocker_attention", row.id), keep: true })).keep).toBe(true);
  });

  it("requires current agent error status for a new alert but preserves existing row actions", async () => {
    const service = decisionRetentionService(db), input = mutation("agent_error_alert", agentId);
    await expect(service.archive(input)).rejects.toMatchObject({ status: 404 });
    expect(await service.getState(companyId, "agent_error_alert", agentId)).toBeNull();
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, agentId));
    expect((await service.setKeep({ ...input, keep: true })).keep).toBe(true);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    expect((await service.archive(input)).archivedAt).toBeInstanceOf(Date);
    expect((await service.revive(input)).archivedAt).toBeNull();
  });

  it("preserves historical productivity and terminal-leaf rows without inventing a new source", async () => {
    const row = await issue(); const service = decisionRetentionService(db);
    await service.syncItems(companyId, ["productivity_review", "blocker_attention"].map(sourceKind => ({ sourceKind: sourceKind as AttentionSourceKind, subject: { id: row.id }, activityAt: row.updatedAt.toISOString() })));
    for (const kind of ["productivity_review", "blocker_attention"] as const) {
      const input = mutation(kind, row.id);
      expect((await service.archive(input)).archivedAt).toBeInstanceOf(Date);
      expect((await service.revive(input)).archivedAt).toBeNull();
      expect((await service.setKeep({ ...input, keep: true })).keep).toBe(true);
    }
  });

  it("requires ordinary feed materialization for an unseen TODO terminal leaf, then preserves its manual controls", async () => {
    const root = await issue({ status: "blocked" });
    const leaf = await issue({ status: "todo" });
    await db.insert(issueRelations).values({ companyId, issueId: leaf.id, relatedIssueId: root.id, type: "blocks" });
    const service = decisionRetentionService(db), input = mutation("blocker_attention", leaf.id);
    await expect(service.setKeep({ ...input, keep: true })).rejects.toMatchObject({ status: 404 });
    expect(await service.getState(companyId, "blocker_attention", leaf.id)).toBeNull();
    const attention = await issueService(db).listBlockerAttention(companyId, [root]);
    expect(attention.get(root.id)).toMatchObject({ terminalBlockerIssueId: leaf.id, state: "needs_attention", blockingTreeLive: false });
    expect(await visible("blocker_attention", leaf.id)).toBe(true);
    expect((await service.archive(input)).archivedAt).toBeInstanceOf(Date);
    expect((await service.revive(input)).archivedAt).toBeNull();
    expect((await service.setKeep({ ...input, keep: true })).keep).toBe(true);
  });

  it.each(["review", "blocker_attention"] as const)("does not pre-materialize hidden %s", async kind => {
    const row = await issue({ hiddenAt: new Date(), status: kind === "review" ? "in_review" : "blocked", assigneeUserId: userId,
      unblockDescriptor: { owner: "board", action: "Choose next owner" }, blockedTransitionAt: new Date() });
    await expect(decisionRetentionService(db).archive(mutation(kind, row.id))).rejects.toMatchObject({ status: 404 });
    expect(await decisionRetentionService(db).getState(companyId, kind, row.id)).toBeNull();
  });

  it.each(["review", "agent_error_alert"] as const)("keeps company and agent authorization isolated for %s", async kind => {
    const foreign = randomUUID();
    await db.insert(companies).values({ id: foreign, name: "Foreign", issuePrefix: "FOREIGN" });
    const sourceId = kind === "review" ? (await issue({ companyId: foreign, status: "in_review", assigneeUserId: userId })).id
      : (await db.insert(agents).values({ companyId: foreign, name: "Foreign error", status: "error" }).returning())[0]!.id;
    const service = decisionRetentionService(db);
    await expect(service.archive(mutation(kind, sourceId))).rejects.toMatchObject({ status: 404 });
    const input = { ...mutation(kind, sourceId), companyId: foreign, authActor: { type: "agent" as const, agentId, companyId },
      actor: { actorType: "agent" as const, actorId: agentId, userId: null, agentId, runId: null, agentApiKeyId: null, responsibleUserId: null } };
    await expect(service.archive(input)).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(decisionRetention).where(and(eq(decisionRetention.companyId, foreign), eq(decisionRetention.sourceId, sourceId)))).toHaveLength(0);
  });
});
