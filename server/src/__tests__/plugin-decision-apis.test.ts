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

  /** The host-owned invocation scope of a UI bridge call by `userId`. */
  const invokedBy = (companyId: string, userId?: string) => ({
    invocationScope: userId ? { companyId, actorUserId: userId } : { companyId },
  });

  it("lists the attention feed for an active member, viewers included", async () => {
    const { companyId, viewerUserId, approvalId } = await seedCompany();
    const feed = await services().attention.list({ companyId }, invokedBy(companyId, viewerUserId));
    expect(feed.companyId).toBe(companyId);
    expect(feed.items.map((item) => `${item.sourceKind}:${item.subject.id}`)).toContain(`approval:${approvalId}`);
  });

  it("acts only for the invoking user and ignores a user the plugin names", async () => {
    const { companyId, ownerUserId, viewerUserId, approvalId } = await seedCompany();
    const host = services();
    // The viewer invoked the plugin. The plugin names the owner to get write
    // access; the host ignores the parameter and acts for the viewer.
    await expect(
      host.decisions.updateTriage(
        { companyId, sourceKind: "approval", sourceId: approvalId, actorUserId: ownerUserId, decideBy: "today" } as any,
        invokedBy(companyId, viewerUserId),
      ),
    ).rejects.toThrow("viewer (read-only) access");
    await expect(db.select().from(decisionTriage)).resolves.toHaveLength(0);
  });

  it("fails closed without an invoking user, for another company, or for a non-member", async () => {
    const { companyId, ownerUserId, approvalId } = await seedCompany();
    const host = services();
    const noUser = "this invocation has none";
    // No invocation (a timer or a proactive call).
    await expect(host.attention.list({ companyId })).rejects.toThrow(noUser);
    // An invocation with no signed-in user (a job, an event, an agent tool).
    await expect(host.attention.list({ companyId }, invokedBy(companyId))).rejects.toThrow(noUser);
    // A user scope for a different company does not carry over.
    await expect(
      host.decisions.listQueues({ companyId }, invokedBy(randomUUID(), ownerUserId)),
    ).rejects.toThrow(noUser);
    await expect(
      host.decisions.getTriage(
        { companyId, sourceKind: "approval", sourceId: approvalId },
        invokedBy(companyId, randomUUID()),
      ),
    ).rejects.toThrow("is not an active human member of this company");
  });

  it("rejects a full attention snapshot without a queue filter", async () => {
    const { companyId, ownerUserId } = await seedCompany();
    await expect(
      services().attention.list({ companyId, all: true }, invokedBy(companyId, ownerUserId)),
    ).rejects.toThrow("all requires a queue filter");
  });

  it("does not read or write another company's sources", async () => {
    const { companyId, ownerUserId } = await seedCompany();
    const other = await seedCompany();
    const host = services();
    // The owner of company A is not a member of company B.
    await expect(
      host.decisions.updateTriage(
        { companyId: other.companyId, sourceKind: "approval", sourceId: other.approvalId, decideBy: "today" },
        invokedBy(other.companyId, ownerUserId),
      ),
    ).rejects.toThrow("is not an active human member of this company");
    // A source id from company B does not resolve inside company A.
    await expect(
      host.decisions.updateTriage(
        { companyId, sourceKind: "approval", sourceId: other.approvalId, decideBy: "today" },
        invokedBy(companyId, ownerUserId),
      ),
    ).rejects.toThrow("Attention source not found");
    await expect(db.select().from(decisionTriage)).resolves.toHaveLength(0);
  });

  it("rejects triage writes for a viewer and leaves no triage row", async () => {
    const { companyId, viewerUserId, approvalId } = await seedCompany();
    const host = services();
    const source = { companyId, sourceKind: "approval" as const, sourceId: approvalId };
    await expect(host.decisions.getTriage(source, invokedBy(companyId, viewerUserId))).resolves.toBeNull();
    await expect(
      host.decisions.updateTriage({ ...source, decideBy: "today" }, invokedBy(companyId, viewerUserId)),
    ).rejects.toThrow("viewer (read-only) access");
    await expect(db.select().from(decisionTriage)).resolves.toHaveLength(0);
  });

  it("validates the triage patch and the source identity", async () => {
    const { companyId, ownerUserId, approvalId } = await seedCompany();
    const host = services();
    const scope = invokedBy(companyId, ownerUserId);
    await expect(
      host.decisions.updateTriage({ companyId, sourceKind: "approval", sourceId: approvalId, decideBy: "someday" }, scope),
    ).rejects.toThrow();
    await expect(
      host.decisions.updateTriage(
        { companyId, sourceKind: "not_a_kind" as any, sourceId: approvalId, decideBy: "today" },
        scope,
      ),
    ).rejects.toThrow("Invalid attention source identity");
    await expect(db.select().from(decisionTriage)).resolves.toHaveLength(0);
  });

  it("sets triage for the invoking user and logs the plugin as the activity actor", async () => {
    const { companyId, ownerUserId, approvalId } = await seedCompany();
    const host = services();
    const scope = invokedBy(companyId, ownerUserId);
    const triage = await host.decisions.updateTriage(
      {
        companyId,
        sourceKind: "approval",
        sourceId: approvalId,
        decideBy: "2026-10-01",
        snoozedUntil: "2026-09-20T09:00:00.000Z",
      },
      scope,
    );
    expect(triage).toMatchObject({
      companyId,
      sourceKind: "approval",
      sourceId: approvalId,
      decideBy: "2026-10-01",
      setByType: "user",
      setByUserId: ownerUserId,
      version: 1,
    });
    // Results cross the worker RPC as JSON: timestamps arrive as ISO strings,
    // which is what the SDK types declare.
    const wire = JSON.parse(JSON.stringify(triage));
    expect(wire.snoozedUntil).toBe("2026-09-20T09:00:00.000Z");
    expect(typeof wire.createdAt).toBe("string");

    const updated = await host.decisions.updateTriage(
      { companyId, sourceKind: "approval", sourceId: approvalId, snoozedUntil: null },
      scope,
    );
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
    const owner = invokedBy(companyId, ownerUserId);
    // The feed read creates the retention row for the pending approval.
    await host.attention.list({ companyId }, owner);
    const source = { companyId, sourceKind: "approval" as const, sourceId: approvalId };

    const kept = await host.decisions.setRetentionKeep({ ...source, keep: true }, owner);
    expect(kept).toMatchObject({ keep: true });

    const archived = await host.decisions.archive(source, owner);
    expect(archived).toMatchObject({ archivedReason: "manual", archivedByType: "user", archivedByUserId: ownerUserId });
    expect(archived.archivedAt).not.toBeNull();

    await expect(host.decisions.revive(source, invokedBy(companyId, viewerUserId)))
      .rejects.toThrow("viewer (read-only) access");

    const revived = await host.decisions.revive(source, owner);
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
    const viewer = invokedBy(companyId, viewerUserId);
    const queues = await host.decisions.listQueues({ companyId }, viewer);
    expect(queues).toEqual([expect.objectContaining({ key: "release", itemCount: 1 })]);
    await expect(host.decisions.listQueueItems({ companyId, key: "release" }, viewer))
      .resolves.toEqual([expect.objectContaining({ sourceKind: "approval", sourceId: approvalId })]);
    await expect(host.decisions.listQueueItems({ companyId, key: "missing" }, viewer))
      .rejects.toThrow("Decision queue not found");
    // A full snapshot scoped to a queue is allowed.
    await expect(host.attention.list({ companyId, all: true, queue: "release" }, viewer)).resolves.toMatchObject({
      companyId,
    });
  });
});
