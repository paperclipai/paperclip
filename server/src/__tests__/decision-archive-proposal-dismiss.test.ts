import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  decisionEffectExecutions,
  decisionRetention,
  decisions,
  decisionTargetIssues,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { AttentionArchiveManifestEntry, AttentionArchiveTargetSnapshot } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { hashAttentionArchiveManifest } from "../services/decision-retention.js";
import { decisionService } from "../services/decisions.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_DECISIONS_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("decisionService attention archive proposal dismissal", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let originIssueId: string;
  let targetIssueId: string;
  let runId: string;
  let originResponsibleUserId: string;
  let decidedByUserId: string;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-archive-dismiss-");
    db = createDb(externalUrl ?? tempDb!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 20_000);

  beforeEach(async () => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    companyId = randomUUID(); agentId = randomUUID(); originIssueId = randomUUID(); targetIssueId = randomUUID(); runId = randomUUID();
    originResponsibleUserId = `origin-${randomUUID()}`; decidedByUserId = `decider-${randomUUID()}`;
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Decisions", issuePrefix: `D${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values([
      { id: originResponsibleUserId, name: "Origin", email: `${originResponsibleUserId}@example.test`, createdAt: now, updatedAt: now },
      { id: decidedByUserId, name: "Decider", email: `${decidedByUserId}@example.test`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: originResponsibleUserId, status: "active", membershipRole: "member" },
      { companyId, principalType: "user", principalId: decidedByUserId, status: "active", membershipRole: "member" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Proposer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values([
      { id: originIssueId, companyId, title: "Origin", status: "in_progress", priority: "medium", assigneeAgentId: agentId, responsibleUserId: originResponsibleUserId },
      { id: targetIssueId, companyId, title: "Target", status: "in_review", priority: "medium", createdByAgentId: agentId, assigneeUserId: decidedByUserId },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: originResponsibleUserId, contextSnapshot: { issueId: originIssueId } });
  });

  afterEach(async () => {
    await db.delete(decisionEffectExecutions); await db.delete(decisionTargetIssues); await db.delete(decisions); await db.delete(decisionRetention); await db.delete(activityLog);
    await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(agents); await db.delete(companyMemberships); await db.delete(authUsers); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await tempDb?.cleanup(); });

  const agentActor = () => ({ type: "agent" as const, companyId, agentId, runId, source: "agent_jwt" as const,
    onBehalfOfUserId: originResponsibleUserId, onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const boardActor = () => ({ type: "board" as const, userId: decidedByUserId, companyIds: [companyId], source: "session" as const,
    memberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const service = () => decisionService(db, { wakeOriginAgent: async () => {} });

  it("decides keep and leaves the manifest items unarchived when an archive proposal is dismissed", async () => {
    const activityAt = new Date("2026-04-01T00:00:00.000Z");
    await db.insert(decisionRetention).values({ companyId, sourceKind: "review", sourceId: targetIssueId, sourceActivityAt: activityAt });
    const manifest: AttentionArchiveManifestEntry[] = [{ companyId, sourceKind: "review", sourceId: targetIssueId,
      expectedVersion: 1, activityAt: activityAt.toISOString(), reason: "Archive" }];
    const created = await service().create({
      companyId,
      actor: agentActor(),
      agentId,
      runId,
      title: "Archive?",
      body: "Reviewed exact set",
      options: [
        { id: "archive", label: "Archive reviewed items", style: "destructive", effects: [] },
        { id: "keep", label: "Keep items", effects: [] },
      ],
      metadata: { kind: "attention_archive_proposal", manifestHash: hashAttentionArchiveManifest(manifest) },
      additionalTargetSnapshots: {
        [`attention:review:${targetIssueId}`]: {
          status: "attention",
          assigneeAgentId: null,
          assigneeUserId: null,
          updatedAt: activityAt.toISOString(),
          attentionArchive: manifest[0],
        } satisfies AttentionArchiveTargetSnapshot,
      },
    });
    const result = await service().dismiss(created.id, decidedByUserId, boardActor(), "Not now");
    expect(result).toMatchObject({ chosenOptionId: "keep", executionStatus: "succeeded" });
    const [state] = await db.select().from(decisionRetention).where(eq(decisionRetention.sourceId, targetIssueId));
    expect(state?.archivedAt).toBeNull();
  });
});
