import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  decisionArchiveNotificationOutbox,
  decisionRetention,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { decisionRetentionService } from "../services/decision-retention.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("decision retention", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-retention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(decisionArchiveNotificationOutbox);
    await db.delete(decisionRetention);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seedReviewItems(count: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Retention",
      issuePrefix: `R${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Origin",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const old = new Date("2026-04-01T00:00:00.000Z");
    const issueIds = Array.from({ length: count }, () => randomUUID());
    await db.insert(issues).values(issueIds.map((id, index) => ({
      id,
      companyId,
      identifier: `RET-${index + 1}`,
      title: `Old review ${index + 1}`,
      status: "in_review",
      priority: "medium",
      assigneeUserId: "board-user",
      createdByAgentId: agentId,
      createdAt: old,
      updatedAt: old,
    })));
    return { companyId, agentId, issueIds };
  }

  const boardActor = (companyId: string) => ({
    type: "board" as const,
    source: "local_implicit" as const,
    userId: "board-user",
    companyIds: [companyId],
    isInstanceAdmin: true,
  });
  const mutationActor = {
    actorType: "user" as const,
    actorId: "board-user",
    agentId: null,
    userId: "board-user",
    runId: null,
    agentApiKeyId: null,
    responsibleUserId: "board-user",
  };

  it("auto-archives, excludes by default, returns archived rows, and revives", async () => {
    const { companyId, issueIds } = await seedReviewItems(1);
    const now = new Date("2026-08-02T00:00:00.000Z");
    const svc = decisionRetentionService(db);
    const before = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(before.items).toHaveLength(1);

    expect(await svc.autoArchive({ companyId, items: before.items, now })).toBe(1);
    const current = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(current.items).toHaveLength(0);
    const archived = await attentionService(db, { now: () => now.getTime() }).list(companyId, { archived: true, limit: 100 });
    expect(archived.items[0]).toMatchObject({ subject: { id: issueIds[0] }, archivedAt: now.toISOString() });

    await svc.revive({
      companyId,
      sourceKind: "review",
      sourceId: issueIds[0]!,
      authActor: boardActor(companyId),
      actor: mutationActor,
    });
    const revived = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(revived.items[0]).toMatchObject({ subject: { id: issueIds[0] }, archivedAt: null });
  });

  it("exempts Keep rows and batches one notification per origin agent", async () => {
    const { companyId, agentId, issueIds } = await seedReviewItems(3);
    const now = new Date("2026-08-02T00:00:00.000Z");
    const notifications: Array<Record<string, unknown>> = [];
    const svc = decisionRetentionService(db, { notifyOriginAgent: async (batch) => notifications.push(batch) });
    await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    await svc.setKeep({
      companyId,
      sourceKind: "review",
      sourceId: issueIds[0]!,
      keep: true,
      authActor: boardActor(companyId),
      actor: mutationActor,
    });
    const refreshed = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(await svc.autoArchive({ companyId, items: refreshed.items, now })).toBe(2);
    expect(await svc.deliverNotifications()).toEqual({ notifiedAgents: 1, delivered: 2 });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ companyId, agentId, items: expect.arrayContaining([
      expect.objectContaining({ issueId: issueIds[1] }),
      expect.objectContaining({ issueId: issueIds[2] }),
    ]) });
    expect((await svc.getState(companyId, "review", issueIds[0]!))?.archivedAt).toBeNull();
  });

  it("fails the whole reviewed manifest when one expected version changes", async () => {
    const { companyId, issueIds } = await seedReviewItems(2);
    const now = Date.parse("2026-08-02T00:00:00.000Z");
    const svc = decisionRetentionService(db);
    const feed = await attentionService(db, { now: () => now }).list(companyId, { limit: 100 });
    const manifest = feed.items.map((item) => ({
      companyId,
      sourceKind: item.sourceKind,
      sourceId: item.subject.id,
      expectedVersion: item.retentionVersion,
      activityAt: item.activityAt,
      reason: "Reviewed as stale",
    }));
    await svc.setKeep({
      companyId,
      sourceKind: "review",
      sourceId: issueIds[0]!,
      keep: true,
      authActor: boardActor(companyId),
      actor: mutationActor,
    });
    await expect(svc.archiveReviewedManifest({
      companyId,
      manifest,
      originActor: boardActor(companyId),
      decidingActor: boardActor(companyId),
      decidedByUserId: "board-user",
    })).rejects.toThrow("archive_proposal_stale");
    expect((await db.select().from(decisionRetention)).every((row) => row.archivedAt === null)).toBe(true);
  });
});
