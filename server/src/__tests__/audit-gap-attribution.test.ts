import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  caseAttachments,
  caseDocuments,
  caseEvents,
  caseIssueLinks,
  caseLabels,
  cases,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  goals,
  heartbeatRuns,
  invites,
  issueComments,
  issues,
  joinRequests,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineDocuments,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { goalRoutes } from "../routes/goals.js";
import { caseRoutes } from "../routes/cases.js";
import { accessRoutes } from "../routes/access.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";

// PAP-14491: prove every gap-list route now emits a durable activity_log row that resolves
// to agentId + runId + responsibleUserId for agent-in-run mutations. Gaps covered here:
//   G13 (pipelines), G14/P16 (case documents), P2 (goals), P3 (access), P12 (issue dedup).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping audit-gap attribution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("audit-gap attribution (PAP-14491)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const noopHeartbeat = { wakeup: async () => null };

  const storage: StorageService = {
    provider: "local_disk",
    async putFile(input) {
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${randomUUID()}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      };
    },
    async getObject() {
      throw new Error("not used");
    },
    async headObject() {
      return { exists: false };
    },
    async deleteObject() {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-audit-gap-attribution-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(caseAttachments);
    await db.delete(caseLabels);
    await db.delete(caseIssueLinks);
    await db.delete(caseEvents);
    await db.delete(caseDocuments);
    await db.delete(cases);
    await db.delete(pipelineCaseBlockers);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelineDocuments);
    await db.delete(pipelines);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(heartbeatRuns);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    // instance settings are global; reset the experimental flags between cases.
    await instanceSettingsService(db).updateExperimental({ enableCases: false });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Mount one router per app: pipelineRoutes and caseRoutes both register `/cases/:id/...`,
  // so combining them in a single app would shadow the case-document routes under test.
  function appWith(actor: Express.Request["actor"], mount: (app: express.Express) => void) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    mount(app);
    app.use(errorHandler);
    return app;
  }

  const mountPipelines = (app: express.Express) =>
    app.use("/api", pipelineRoutes(db, { heartbeat: noopHeartbeat as never }));
  const mountGoals = (app: express.Express) => app.use("/api", goalRoutes(db));
  const mountCases = (app: express.Express) => app.use("/api", caseRoutes(db, storage));
  const mountIssues = (app: express.Express) => app.use("/api", issueRoutes(db, {} as never));
  const mountAccess = (app: express.Express) =>
    app.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }));

  async function seedAgentInRun(permissionKeys: string[] = []) {
    const [company] = await db.insert(companies).values({
      name: `Audit ${randomUUID()}`,
      issuePrefix: `AG${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "default-user",
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Audit Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    for (const permissionKey of permissionKeys) {
      await db.insert(principalPermissionGrants).values({
        companyId: company!.id,
        principalType: "agent",
        principalId: agent!.id,
        permissionKey,
        scope: null,
      });
    }
    const runId = randomUUID();
    const responsibleUserId = `run-user-${randomUUID()}`;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      responsibleUserId,
    });
    const actor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company!.id,
      runId,
      source: "agent_key",
    };
    return { companyId: company!.id, agentId: agent!.id, runId, responsibleUserId, actor };
  }

  async function activityRow(companyId: string, action: string) {
    const rows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
    return rows[0] ?? null;
  }

  function expectAgentAttribution(
    row: Record<string, unknown> | null,
    seed: { agentId: string; runId: string; responsibleUserId: string },
  ) {
    expect(row, "expected an activity_log row for the action").toBeTruthy();
    expect(row).toMatchObject({
      actorType: "agent",
      actorId: seed.agentId,
      agentId: seed.agentId,
      runId: seed.runId,
      responsibleUserId: seed.responsibleUserId,
    });
  }

  it("G13: pipeline admin mutations record agent/run/responsible-user attribution", async () => {
    const seed = await seedAgentInRun(["pipelines:write"]);
    const http = request(appWith(seed.actor, mountPipelines));

    const created = await http
      .post(`/api/companies/${seed.companyId}/pipelines`)
      .send({
        key: "content",
        name: "Content",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const pipelineId = created.body.id as string;

    await http.patch(`/api/pipelines/${pipelineId}`).send({ name: "Content Ops", enforceTransitions: true }).expect(200);
    const stage = await http
      .post(`/api/pipelines/${pipelineId}/stages`)
      .send({ key: "qa", name: "QA", kind: "working", position: 300 })
      .expect(201);
    await http.patch(`/api/pipelines/${pipelineId}/stages/${stage.body.id}`).send({ name: "QA pass" }).expect(200);
    await http.delete(`/api/pipelines/${pipelineId}/stages/${stage.body.id}`).expect(200);
    await http
      .put(`/api/pipelines/${pipelineId}/transitions`)
      .send({ transitions: [{ fromStageKey: "intake", toStageKey: "done" }] })
      .expect(200);

    for (const action of [
      "pipeline.created",
      "pipeline.updated",
      "pipeline.stage_created",
      "pipeline.stage_updated",
      "pipeline.stage_deleted",
      "pipeline.transitions_replaced",
    ]) {
      expectAgentAttribution(await activityRow(seed.companyId, action), seed);
    }
  });

  it("P2: goal creation carries the run id and responsible user", async () => {
    const seed = await seedAgentInRun();
    const http = request(appWith(seed.actor, mountGoals));

    await http
      .post(`/api/companies/${seed.companyId}/goals`)
      .send({ title: "Ship audit coverage", level: "company" })
      .expect(201);

    expectAgentAttribution(await activityRow(seed.companyId, "goal.created"), seed);
  });

  it("G14/P16: case document lock, unlock, and delete emit attributed durable records", async () => {
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const seed = await seedAgentInRun();
    const http = request(appWith(seed.actor, mountCases));

    const caseRes = await http
      .post(`/api/companies/${seed.companyId}/cases`)
      .send({ caseType: "bug", title: "Broken audit" })
      .expect(201);
    const caseId = caseRes.body.id as string;

    await http
      .put(`/api/cases/${caseId}/documents/notes`)
      .send({ format: "markdown", body: "First revision" })
      .expect(200);
    await http.post(`/api/cases/${caseId}/documents/notes/lock`).expect(200);
    await http.post(`/api/cases/${caseId}/documents/notes/unlock`).expect(200);
    await http.delete(`/api/cases/${caseId}/documents/notes`).expect(200);

    expectAgentAttribution(await activityRow(seed.companyId, "case.document_locked"), seed);
    expectAgentAttribution(await activityRow(seed.companyId, "case.document_unlocked"), seed);
    const deletedRow = await activityRow(seed.companyId, "case.document_deleted");
    expectAgentAttribution(deletedRow, seed);
    // The tombstone preserves the destroyed history metadata after the hard delete.
    expect(deletedRow?.details).toMatchObject({ key: "notes" });
    expect((deletedRow?.details as Record<string, unknown>).documentId).toBeTruthy();
    expect((deletedRow?.details as Record<string, unknown>).revisionCount).toBeGreaterThanOrEqual(1);
  });

  it("P3: join rejection and invite revoke attribute the acting agent (not a hardcoded user)", async () => {
    const seed = await seedAgentInRun(["joins:approve", "users:invite"]);
    const http = request(appWith(seed.actor, mountAccess));

    const [invite] = await db.insert(invites).values({
      companyId: seed.companyId,
      inviteType: "company_join",
      tokenHash: `hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).returning();
    const [joinRequest] = await db.insert(joinRequests).values({
      companyId: seed.companyId,
      inviteId: invite!.id,
      requestType: "agent",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      agentName: "Hopeful Agent",
    }).returning();

    await http
      .post(`/api/companies/${seed.companyId}/join-requests/${joinRequest!.id}/reject`)
      .send({})
      .expect(200);
    await http.post(`/api/invites/${invite!.id}/revoke`).send({}).expect(200);

    expectAgentAttribution(await activityRow(seed.companyId, "join.rejected"), seed);
    expectAgentAttribution(await activityRow(seed.companyId, "invite.revoked"), seed);
  });

  it("P12: a de-duplicated issue create attempt is audit-visible with attribution", async () => {
    const seed = await seedAgentInRun();
    const http = request(appWith(seed.actor, mountIssues));
    const idempotencyKey = `dup-${randomUUID()}`;

    const first = await http
      .post(`/api/companies/${seed.companyId}/issues`)
      .send({ title: "Duplicate me", idempotencyKey })
      .expect(201);
    const second = await http
      .post(`/api/companies/${seed.companyId}/issues`)
      .send({ title: "Duplicate me", idempotencyKey })
      .expect(200);
    expect(second.body).toMatchObject({ id: first.body.id, deduplicated: true, deduplicationReason: "idempotency_key" });

    const row = await activityRow(seed.companyId, "issue.create_deduplicated");
    expectAgentAttribution(row, seed);
    expect(row?.details).toMatchObject({ deduplicationReason: "idempotency_key" });
  });
});
