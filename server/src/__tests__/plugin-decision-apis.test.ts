import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  approvals,
  companies,
  companyMemberships,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisionTriage,
  decisionTriageEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `D${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin decision API tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin attention and decision APIs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-decisions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(decisionTriageEvents);
    await db.delete(decisionTriage);
    await db.delete(decisionQueueItems);
    await db.delete(decisionQueues);
    await db.delete(decisionRetention);
    await db.delete(approvals);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Decisions",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    const ownerUserId = randomUUID();
    const viewerUserId = randomUUID();
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: viewerUserId, status: "active", membershipRole: "viewer" },
    ]);
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Ship it" },
    });
    return { companyId, ownerUserId, viewerUserId, approvalId };
  }

  const services = () => buildHostServices(db, "plugin-record-id", "paperclip.dashboard", createEventBusStub());

  it("lists the attention feed for an active member, viewers included", async () => {
    const { companyId, viewerUserId, approvalId } = await seedCompany();
    const feed = await services().attention.list({ companyId, actorUserId: viewerUserId });
    expect(feed.companyId).toBe(companyId);
    expect(feed.items.map((item) => `${item.sourceKind}:${item.subject.id}`)).toContain(`approval:${approvalId}`);
  });

  it("fails closed when actorUserId is missing or not an active member", async () => {
    const { companyId, approvalId } = await seedCompany();
    const host = services();
    await expect(
      host.attention.list({ companyId } as any),
    ).rejects.toThrow("actorUserId is required");
    await expect(
      host.decisions.getTriage({ companyId, sourceKind: "approval", sourceId: approvalId, actorUserId: randomUUID() }),
    ).rejects.toThrow("is not an active human member of this company");
  });

  it("does not read or write another company's sources", async () => {
    const { companyId, ownerUserId } = await seedCompany();
    const other = await seedCompany();
    const host = services();
    // The owner of company A is not a member of company B.
    await expect(
      host.decisions.updateTriage({
        companyId: other.companyId,
        sourceKind: "approval",
        sourceId: other.approvalId,
        actorUserId: ownerUserId,
        decideBy: "today",
      }),
    ).rejects.toThrow("is not an active human member of this company");
    // A source id from company B does not resolve inside company A.
    await expect(
      host.decisions.updateTriage({
        companyId,
        sourceKind: "approval",
        sourceId: other.approvalId,
        actorUserId: ownerUserId,
        decideBy: "today",
      }),
    ).rejects.toThrow("Attention source not found");
    await expect(db.select().from(decisionTriage)).resolves.toHaveLength(0);
  });

  it("rejects triage writes for a viewer and leaves no triage row", async () => {
    const { companyId, viewerUserId, approvalId } = await seedCompany();
    const host = services();
    await expect(
      host.decisions.getTriage({ companyId, sourceKind: "approval", sourceId: approvalId, actorUserId: viewerUserId }),
    ).resolves.toBeNull();
    await expect(
      host.decisions.updateTriage({
        companyId,
        sourceKind: "approval",
        sourceId: approvalId,
        actorUserId: viewerUserId,
        decideBy: "today",
      }),
    ).rejects.toThrow("viewer (read-only) access");
    await expect(db.select().from(decisionTriage)).resolves.toHaveLength(0);
  });

  it("validates the triage patch and the source identity", async () => {
    const { companyId, ownerUserId, approvalId } = await seedCompany();
    const host = services();
    await expect(
      host.decisions.updateTriage({
        companyId,
        sourceKind: "approval",
        sourceId: approvalId,
        actorUserId: ownerUserId,
        decideBy: "someday",
      }),
    ).rejects.toThrow();
    await expect(
      host.decisions.updateTriage({
        companyId,
        sourceKind: "not_a_kind" as any,
        sourceId: approvalId,
        actorUserId: ownerUserId,
        decideBy: "today",
      }),
    ).rejects.toThrow("Invalid attention source identity");
    await expect(db.select().from(decisionTriage)).resolves.toHaveLength(0);
  });

  it("sets triage for the paired user and logs the plugin as the activity actor", async () => {
    const { companyId, ownerUserId, approvalId } = await seedCompany();
    const host = services();
    const triage = await host.decisions.updateTriage({
      companyId,
      sourceKind: "approval",
      sourceId: approvalId,
      actorUserId: ownerUserId,
      decideBy: "2026-10-01",
      snoozedUntil: "2026-09-20T09:00:00.000Z",
    });
    expect(triage).toMatchObject({
      companyId,
      sourceKind: "approval",
      sourceId: approvalId,
      decideBy: "2026-10-01",
      setByType: "user",
      setByUserId: ownerUserId,
      version: 1,
    });

    const updated = await host.decisions.updateTriage({
      companyId,
      sourceKind: "approval",
      sourceId: approvalId,
      actorUserId: ownerUserId,
      snoozedUntil: null,
    });
    expect(updated).toMatchObject({ decideBy: "2026-10-01", snoozedUntil: null, version: 2 });

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "decision_triage.updated")))
      .limit(1);
    expect(activity).toMatchObject({ actorType: "plugin", actorId: "plugin-record-id" });
    expect(activity?.details).toMatchObject({
      sourcePluginKey: "paperclip.dashboard",
      initiatingActorType: "user",
      initiatingUserId: ownerUserId,
    });
  });

  it("keeps, archives, and revives a source through retention", async () => {
    const { companyId, ownerUserId, viewerUserId, approvalId } = await seedCompany();
    const host = services();
    // The feed read creates the retention row for the pending approval.
    await host.attention.list({ companyId, actorUserId: ownerUserId });
    const source = { companyId, sourceKind: "approval" as const, sourceId: approvalId };

    const kept = await host.decisions.setRetentionKeep({ ...source, actorUserId: ownerUserId, keep: true });
    expect(kept).toMatchObject({ keep: true });

    const archived = await host.decisions.archive({ ...source, actorUserId: ownerUserId });
    expect(archived).toMatchObject({ archivedReason: "manual", archivedByType: "user", archivedByUserId: ownerUserId });
    expect(archived.archivedAt).not.toBeNull();

    await expect(host.decisions.revive({ ...source, actorUserId: viewerUserId }))
      .rejects.toThrow("viewer (read-only) access");

    const revived = await host.decisions.revive({ ...source, actorUserId: ownerUserId });
    expect(revived).toMatchObject({ archivedAt: null, archivedByUserId: null });

    const rows = await db
      .select({ action: activityLog.action, actorType: activityLog.actorType })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    const retentionRows = rows.filter((row) => row.action.startsWith("decision_retention."));
    expect(retentionRows.map((row) => row.action).sort()).toEqual([
      "decision_retention.archived",
      "decision_retention.keep_updated",
      "decision_retention.revived",
    ]);
    expect(retentionRows.every((row) => row.actorType === "plugin")).toBe(true);
  });

  it("lists decision queues and their items for a viewer", async () => {
    const { companyId, viewerUserId, approvalId } = await seedCompany();
    const [queue] = await db.insert(decisionQueues).values({
      companyId,
      key: "release",
      title: "Release",
      createdByType: "system",
    }).returning();
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId: queue!.id,
      sourceKind: "approval",
      sourceId: approvalId,
      addedByType: "system",
    });
    const host = services();
    const queues = await host.decisions.listQueues({ companyId, actorUserId: viewerUserId });
    expect(queues).toEqual([expect.objectContaining({ key: "release", itemCount: 1 })]);
    await expect(host.decisions.listQueueItems({ companyId, key: "release", actorUserId: viewerUserId }))
      .resolves.toEqual([expect.objectContaining({ sourceKind: "approval", sourceId: approvalId })]);
    await expect(host.decisions.listQueueItems({ companyId, key: "missing", actorUserId: viewerUserId }))
      .rejects.toThrow("Decision queue not found");
  });
});
