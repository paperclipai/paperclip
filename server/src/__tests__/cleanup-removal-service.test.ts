import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { agentLifecycleCompanyDeletion } from "../modules/agent-lifecycle/company-deletion.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  closeRegisteredClients,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  chatEndpoints,
  chatConversations,
  chatPublications,
  chatDiscordCommandOwners,
  toolApplications,
  toolConnections,
  activityLog,
  agents,
  companies,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueReadStates,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";
import { logActivity } from "../services/activity-log.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_CLEANUP_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? tempDb!.connectionString, external ? { maxConnections: 4 } : undefined);
    configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(chatEndpoints);
    await db.delete(chatDiscordCommandOwners);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const close of [
      () => db?.$client.end({ timeout: 1 }),
      () => external ? closeRegisteredClients(external, { scope: "database" }) : undefined,
      () => tempDb?.cleanup(),
    ]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Cleanup removal fixture failed to close");
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, agentId));
    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes heartbeat events by run id before deleting company-owned runs", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(heartbeatRunEvents).values({
      companyId: otherCompanyId,
      runId,
      agentId,
      seq: 1,
      eventType: "output",
      message: "event with mismatched company scope",
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
  });

  it("removes routines before deleting company agents", async () => {
    const { agentId, companyId } = await seedFixture();
    const routineId = randomUUID();

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Daily cleanup",
      assigneeAgentId: agentId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(routines).where(eq(routines.id, routineId))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
  });
  async function seedEndpoint(companyId: string, agentId: string, issueId: string) {
    const [app] = await db.insert(toolApplications).values({ companyId, name: "Discord", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: app.id, uid: randomUUID(), name: "Discord", transport: "chat_sdk", connectionPurpose: "channel",
    }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({
      companyId, connectionId: connection.id, provider: "discord", publicId: randomUUID(), assignedAgentId: agentId,
    }).returning();
    const [conversation] = await db.insert(chatConversations).values({
      companyId, endpointId: endpoint.id, issueId, externalConversationId: randomUUID(), externalLabel: "Saved chat",
    }).returning();
    await db.insert(chatPublications).values({
      companyId, endpointId: endpoint.id, conversationId: conversation.id, issueId,
      idempotencyKey: randomUUID(), payload: { text: "Saved response" }, state: "published",
    });
    return endpoint;
  }

  it("deletes company endpoints before their agents while preserving other companies and ownership tombstones", async () => {
    const first = await seedFixture(), second = await seedFixture();
    const endpoint = await seedEndpoint(first.companyId, first.agentId, first.issueId);
    const other = await seedEndpoint(second.companyId, second.agentId, second.issueId);
    const [owner] = await db.insert(chatDiscordCommandOwners).values({
      applicationId: String(1_400_000_000_000_000_000n + BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 12))),
      companyId: first.companyId, endpointId: endpoint.id, actionId: randomUUID(),
    }).returning();
    await companyService(db).remove(first.companyId);
    expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id))).toEqual([]);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.companyId, first.companyId))).toEqual([]);
    expect(await db.select().from(chatPublications).where(eq(chatPublications.companyId, first.companyId))).toEqual([]);
    expect(await db.select().from(agents).where(eq(agents.companyId, first.companyId))).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.id, first.companyId))).toEqual([]);
    expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, other.id))).toEqual([other]);
    expect(await db.select().from(chatDiscordCommandOwners).where(eq(chatDiscordCommandOwners.applicationId, owner.applicationId))).toEqual([owner]);
  });

  it("rolls back endpoint cleanup when the later agent deletion fails", async () => {
    const f = await seedFixture();
    const endpoint = await seedEndpoint(f.companyId, f.agentId, f.issueId);
    vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementationOnce(async tx => {
      expect(await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id))).toEqual([]);
      throw new Error("agent deletion failed");
    });
    await expect(companyService(db).remove(f.companyId)).rejects.toThrow("agent deletion failed");
    expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id))).toEqual([endpoint]);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.endpointId, endpoint.id))).toHaveLength(1);
    expect(await db.select().from(chatPublications).where(eq(chatPublications.endpointId, endpoint.id))).toHaveLength(1);
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agents).where(eq(agents.id, f.agentId))).toHaveLength(1);
  });

  it("deletes a company when authorized activity commits after its first audit cleanup", async () => {
    const companyId = randomUUID(), otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Deleting company", issuePrefix: `D${companyId.slice(0, 7)}` },
      { id: otherCompanyId, name: "Retained company", issuePrefix: `O${otherCompanyId.slice(0, 7)}` },
    ]);
    const initialActivity = await logActivity(db, { companyId, actorType: "user", actorId: "board",
      action: "company.updated", entityType: "company", entityId: companyId });
    expect(await db.select().from(activityLog).where(eq(activityLog.id, initialActivity.id))).toHaveLength(1);
    const otherActivity = await logActivity(db, { companyId: otherCompanyId, actorType: "user",
      actorId: "board", action: "company.updated", entityType: "company", entityId: otherCompanyId });
    const writer = createDb(external ?? tempDb!.connectionString, { maxConnections: 1 });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const participant = agentLifecycleCompanyDeletion.deleteCompanyData;
    let participantCalls = 0, lateActivityCommitted = false, primary: unknown;
    const gate = vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementation(async (tx, id) => {
      await participant(tx, id);
      if (id === companyId) {
        participantCalls++;
        if (participantCalls === 1) {
          // This transaction sees its own first audit deletion; another
          // connection would still see the original committed row under MVCC.
          expect(await tx.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual([]);
          entered.resolve();
          await release.promise;
        }
      }
    });
    const deletion = companyService(db).remove(companyId);
    const joined = deletion.then(value => ({ status: "fulfilled" as const, value }),
      reason => ({ status: "rejected" as const, reason }));
    try {
      await Promise.race([entered.promise, deletion.then(() => { throw new Error("Deletion missed its real participant gate"); })]);
      const late = await logActivity(writer, { companyId, actorType: "user", actorId: "board",
        action: "company.updated", entityType: "company", entityId: companyId });
      lateActivityCommitted = true;
      expect(await writer.select().from(activityLog).where(eq(activityLog.id, late.id))).toHaveLength(1);
      release.resolve();
      const outcome = await joined;
      let original = outcome.status === "rejected" ? outcome.reason : undefined;
      const failures: Array<{ code?: string; constraint?: string }> = [];
      const seen = new Set<unknown>();
      while (original && typeof original === "object" && !seen.has(original)) {
        seen.add(original);
        const failure = original as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
        if (failure.code) failures.push({ code: failure.code, constraint: failure.constraint_name ?? failure.constraint });
        original = failure.cause;
      }
      console.info("COMPANY_DELETE_LATE_ACTIVITY_FRONTIER", JSON.stringify({ realParticipantReached: true,
        firstAuditCleanupObserved: true, lateActivityCommitted, writerJoined: true,
        deletionJoined: true, participantCalls, status: outcome.status, failures }));
      if (outcome.status === "rejected") throw outcome.reason;
      expect(outcome.value?.id).toBe(companyId);
      expect(participantCalls).toBe(1);
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toEqual([]);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual([]);
      expect(await db.select().from(companies).where(eq(companies.id, otherCompanyId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.id, otherActivity.id))).toHaveLength(1);
    } catch (error) { primary = error; }
    finally {
      release.resolve();
      await joined;
      gate.mockRestore();
      const cleanup = await Promise.allSettled([writer.$client.end({ timeout: 1 })]);
      const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (primary || errors.length) throw new AggregateError([...(primary ? [primary] : []), ...errors],
        "Company deletion late activity original and cleanup failures");
    }
  }, 30_000);

  it("propagates a different real company foreign key without retrying or losing audit rows", async () => {
    const companyId = randomUUID(), otherCompanyId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const tableName = `company_delete_guard_${suffix}`, constraintName = `company_delete_fk_${suffix}`;
    await db.insert(companies).values([
      { id: companyId, name: "Refused deletion", issuePrefix: `F${companyId.slice(0, 7)}` },
      { id: otherCompanyId, name: "Untouched company", issuePrefix: `U${otherCompanyId.slice(0, 7)}` },
    ]);
    const originalActivity = await logActivity(db, { companyId, actorType: "user", actorId: "board",
      action: "company.updated", entityType: "company", entityId: companyId });
    const otherActivity = await logActivity(db, { companyId: otherCompanyId, actorType: "user", actorId: "board",
      action: "company.updated", entityType: "company", entityId: otherCompanyId });
    const priorDebug = db.$client.options.debug;
    const participant = agentLifecycleCompanyDeletion.deleteCompanyData;
    let parentDeleteStatements = 0, participantCalls = 0, primary: unknown;
    const observed = vi.spyOn(agentLifecycleCompanyDeletion, "deleteCompanyData").mockImplementation(async (tx, id) => {
      await participant(tx, id);
      if (id === companyId) participantCalls++;
    });
    try {
      // This is a real test-owned child, not a replacement constraint or SQL
      // result. PostgreSQL temporary tables cannot reference a permanent parent.
      await db.execute(sql`create table ${sql.identifier(tableName)} (
        company_id uuid not null,
        constraint ${sql.identifier(constraintName)} foreign key (company_id) references companies(id)
      )`);
      await db.execute(sql`insert into ${sql.identifier(tableName)} (company_id) values (${companyId})`);
      db.$client.options.debug = (connection, query, parameters, types) => {
        if (/^\s*delete\s+from\s+"companies"\s/i.test(query) && parameters.some(value => value === companyId))
          parentDeleteStatements++;
        if (typeof priorDebug === "function") priorDebug(connection, query, parameters, types);
      };
      let rejected: unknown;
      try { await companyService(db).remove(companyId); } catch (error) { rejected = error; }
      let driver = rejected;
      const seen = new Set<unknown>();
      while (driver && typeof driver === "object" && !seen.has(driver)) {
        seen.add(driver);
        const failure = driver as { code?: string; cause?: unknown };
        if (failure.code) break;
        driver = failure.cause;
      }
      expect(driver).toMatchObject({ code: "23503", constraint_name: constraintName });
      expect(parentDeleteStatements).toBe(1);
      expect(participantCalls).toBe(1);
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.id, originalActivity.id))).toHaveLength(1);
      expect(await db.select().from(companies).where(eq(companies.id, otherCompanyId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.id, otherActivity.id))).toHaveLength(1);
    } catch (error) { primary = error; }
    finally {
      db.$client.options.debug = priorDebug;
      observed.mockRestore();
      const cleanup = await Promise.allSettled([
        db.execute(sql`drop table if exists ${sql.identifier(tableName)}`),
      ]);
      const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (primary || errors.length) throw new AggregateError([...(primary ? [primary] : []), ...errors],
        "Company deletion foreign key control original and cleanup failures");
    }
  }, 30_000);

});
