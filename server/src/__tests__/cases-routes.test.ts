import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  caseAttachments,
  caseAccessSources,
  caseHandoffs,
  caseDocuments,
  caseEvents,
  caseIssueLinks,
  caseLabels,
  cases,
  companies,
  companyMemberships,
  createDb,
  documentAnnotationComments,
  documentAnnotationThreads,
  documents,
  documentRevisions,
  heartbeatRuns,
  instanceSettings,
  issues,
  labels,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { buildCasePatchUpdateValues, caseRoutes } from "../routes/cases.js";
import { caseHandoffRoutes } from "../routes/case-handoffs.js";
import { canActorReadAssetContent } from "../services/asset-content-access.js";
import { caseActivityReadSqlCondition } from "../services/case-activity-access.js";
import { activityService } from "../services/activity.js";
import { agentActionAuditService } from "../services/agent-action-audit.js";
import { assertCaseTrustedForExecution, canActorReadCase, canActorReceiveCase, retainCaseAccessSource } from "../services/case-access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cases route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cases routes", () => {
  it("omits completedAt from non-status case patches", () => {
    const now = new Date("2026-07-10T00:00:00.000Z");
    const completedAt = new Date("2026-07-09T00:00:00.000Z");

    expect(buildCasePatchUpdateValues({ title: "Rename" }, { status: "todo", completedAt: null }, now)).not.toHaveProperty("completedAt");
    expect(buildCasePatchUpdateValues({ title: "Rename" }, { status: "done", completedAt }, now)).not.toHaveProperty("completedAt");

    const statusPatch = buildCasePatchUpdateValues({ status: "done" }, { status: "todo", completedAt: null }, now);
    expect(statusPatch).toHaveProperty("completedAt");
    expect(statusPatch.completedAt).toBeInstanceOf(Date);
  });

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const liveEventUnsubscribers: Array<() => void> = [];

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
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "cases-routes-test-secret";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cases-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const unsubscribe of liveEventUnsubscribers.splice(0)) unsubscribe();
    await db.delete(activityLog);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(caseAttachments);
    await db.delete(caseLabels);
    await db.delete(caseDocuments);
    await db.delete(caseIssueLinks);
    await db.delete(caseEvents);
    await db.delete(cases);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(assets);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    }
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", caseRoutes(db, storage));
    instance.use("/api", caseHandoffRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  function authenticatedApp() {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    instance.use("/api", caseRoutes(db, storage));
    instance.use("/api", caseHandoffRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function enableCases() {
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
  }

  async function seedCompany(prefix = "CASE") {
    const [company] = await db.insert(companies).values({
      name: `${prefix} Co`,
      issuePrefix: `${prefix}${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    return company!;
  }

  async function seedAgent(companyId: string) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Cases Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return agent!;
  }

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  it("gates every case route when enableCases is off", async () => {
    const company = await seedCompany("OFF");
    const [caseRow] = await db.insert(cases).values({
      companyId: company.id,
      caseNumber: 1,
      identifier: `${company.issuePrefix}-C1`,
      caseType: "bug",
      title: "Hidden case",
    }).returning();
    const http = request(app(boardActor));

    await http.get(`/api/companies/${company.id}/cases`).expect(403);
    await http.get(`/api/companies/${company.id}/cases/types`).expect(403);
    await http.post(`/api/companies/${company.id}/cases`).send({ caseType: "bug", title: "Bug" }).expect(403);
    await http.get(`/api/cases/${caseRow!.id}`).expect(403);
    await http.patch(`/api/cases/${caseRow!.id}`).send({ status: "in_progress" }).expect(403);
    await http.put(`/api/cases/${caseRow!.id}/documents/body`).send({ body: "Body" }).expect(403);
    await http.get(`/api/cases/${caseRow!.id}/documents/body/annotations`).expect(403);
    await http.post(`/api/cases/${caseRow!.id}/links`).send({ issueId: randomUUID(), role: "work" }).expect(403);
    await http.post(`/api/cases/${caseRow!.id}/attachments`).attach("file", Buffer.from("x"), "x.txt").expect(403);
    await http.get(`/api/cases/${caseRow!.id}/events`).expect(403);
  });

  it("returns not found for unknown case IDs on the former shared routes", async () => {
    await enableCases();
    const http = request(app(boardActor));
    const unknownId = randomUUID();
    await http.get(`/api/cases/${unknownId}`).expect(404);
    await http.patch(`/api/cases/${unknownId}`).send({ status: "in_progress" }).expect(404);
    await http.put(`/api/cases/${unknownId}/documents/body`).send({ body: "Body" }).expect(404);
    await http.get(`/api/cases/${unknownId}/documents/body/revisions`).expect(404);
    await http.get(`/api/cases/${unknownId}/events`).expect(404);
  });

  it("creates cases and upserts idempotently by type and key", async () => {
    await enableCases();
    const company = await seedCompany("UPS");
    const http = request(app(boardActor));

    const first = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({
        caseType: "security",
        key: "CVE-1",
        title: "Investigate report",
        fields: { severity: "high" },
      })
      .expect(201);
    const second = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({
        caseType: "security",
        key: "CVE-1",
        title: "Investigate report again",
        fields: { severity: "critical" },
      })
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(first.body.identifier).toBe(`${company.issuePrefix.toUpperCase()}-C1`);
    const all = await db.select().from(cases);
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("Investigate report again");
    expect(all[0]!.fields).toEqual({ severity: "critical" });
  });

  it("converges concurrent keyed upserts to one case", async () => {
    await enableCases();
    const company = await seedCompany("RCE");
    const http = request(app(boardActor));

    const requests = [
      http.post(`/api/companies/${company.id}/cases`).send({
        caseType: "release_note",
        key: "2026-07-07",
        title: "Release note A",
        fields: { channel: "stable" },
      }),
      http.post(`/api/companies/${company.id}/cases`).send({
        caseType: "release_note",
        key: "2026-07-07",
        title: "Release note B",
        fields: { channel: "canary" },
      }),
    ];

    const responses = await Promise.all(requests);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 201]);
    expect(responses[0]!.body.id).toBe(responses[1]!.body.id);

    const all = await db.select().from(cases);
    expect(all).toHaveLength(1);
    expect(all[0]!.caseType).toBe("release_note");
    expect(all[0]!.key).toBe("2026-07-07");
    expect(["Release note A", "Release note B"]).toContain(all[0]!.title);
    expect([{ channel: "stable" }, { channel: "canary" }]).toContainEqual(all[0]!.fields);
  });

  it("upserts keyless cases by company and type", async () => {
    await enableCases();
    const company = await seedCompany("NUL");
    const http = request(app(boardActor));

    const first = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "release_note", title: "Draft release note" })
      .expect(201);
    const second = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "release_note", title: "Updated release note" })
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.key).toBeNull();
    expect(second.body.title).toBe("Updated release note");
    const all = await db.select().from(cases);
    expect(all).toHaveLength(1);
  });

  it("rejects the removed createOnly option without changing existing passive records", async () => {
    await enableCases();
    const company = await seedCompany("NEW"), http = request(app(boardActor));
    const original = await http.post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "research", title: "Existing passive case" }).expect(201);
    await http.post(`/api/companies/${company.id}/cases`)
      .send({ createOnly: true, caseType: "research", title: "Must not overwrite" }).expect(400);
    const all = await db.select().from(cases).where(eq(cases.companyId, company.id));
    expect(all).toMatchObject([{ id: original.body.id, title: "Existing passive case", workIssueId: null }]);
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toHaveLength(0);
  });

  it("resolves cases by identifier", async () => {
    await enableCases();
    const company = await seedCompany("REF");
    const http = request(app(boardActor));

    const created = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "blog_post", key: "launch", title: "Launch post" })
      .expect(201);

    const byIdentifier = await http.get(`/api/cases/${created.body.identifier}`).expect(200);
    expect(byIdentifier.body.id).toBe(created.body.id);
    expect(byIdentifier.body.identifier).toMatch(/^REF[A-Z0-9]{4}-C1$/);
  });

  it("auto-links run writes to their issue with a work link and event", async () => {
    await enableCases();
    const company = await seedCompany("RUN");
    const agent = await seedAgent(company.id);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: agent.id,
      status: "running",
    });
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Source task",
      status: "in_progress",
      executionRunId: runId,
    }).returning();
    const created = await request(app(boardActor))
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "bug", title: "Bug" })
      .expect(201);

    const agentActor: Express.Request["actor"] = {
      type: "agent",
      companyId: company.id,
      agentId: agent.id,
      runId,
      source: "agent_jwt",
      onBehalfOfUserId: null,
      onBehalfOfMemberships: [],
    };
    await request(app(agentActor))
      .patch(`/api/cases/${created.body.id}`)
      .send({ fields: { rootCause: "missing coverage" } })
      .expect(200);

    const links = await db.select().from(caseIssueLinks);
    expect(links).toHaveLength(1);
    expect(links[0]!.caseId).toBe(created.body.id);
    expect(links[0]!.issueId).toBe(issue!.id);
    expect(links[0]!.role).toBe("work");
    expect(links[0]!.createdByRunId).toBe(runId);

    const linkedEvents = await db.select().from(caseEvents).where(eq(caseEvents.kind, "issue_linked"));
    expect(linkedEvents).toHaveLength(1);
    expect(linkedEvents[0]!.actorAgentId).toBe(agent.id);
    expect(linkedEvents[0]!.runId).toBe(runId);
    expect(linkedEvents[0]!.payload).toMatchObject({ issueId: issue!.id, role: "work", autoLinked: true });
  });

  it("lets a run-scoped agent JWT complete the case happy path without manual linking", async () => {
    await enableCases();
    const company = await seedCompany("JWT");
    const agent = await seedAgent(company.id);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: agent.id,
      status: "running",
    });
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Agent case source",
      status: "in_progress",
      executionRunId: runId,
    }).returning();
    const token = createLocalAgentJwt(agent.id, company.id, agent.adapterType, runId);
    expect(token).toBeTruthy();

    const http = request(authenticatedApp());
    const createResponse = await http
      .post(`/api/companies/${company.id}/cases`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({
        caseType: "blog_post",
        key: "launch-post",
        title: "Launch post",
        fields: { slug: "launch-post", target_audience: "operators" },
      })
      .expect(201);
    const caseId = createResponse.body.id as string;

    await http
      .put(`/api/cases/${createResponse.body.identifier}/documents/body`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ body: "# Launch\n\nDraft body." })
      .expect(200);

    await http
      .patch(`/api/cases/${caseId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({
        status: "in_review",
        fields: { slug: "launch-post", target_audience: "operators", publish_url: "https://example.com/launch" },
      })
      .expect(200);

    await http
      .post(`/api/cases/${caseId}/attachments`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .attach("file", Buffer.from("asset"), "asset.txt")
      .expect(201);

    const links = await db.select().from(caseIssueLinks);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      companyId: company.id,
      caseId,
      issueId: issue!.id,
      role: "origin",
      createdByRunId: runId,
    });

    const detail = await http
      .get(`/api/cases/${createResponse.body.identifier}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .expect(200);
    expect(detail.body.status).toBe("in_review");
    expect(detail.body.documents).toHaveLength(1);
    expect(detail.body.attachments).toHaveLength(1);
    expect(detail.body.issueLinks).toHaveLength(1);

    const eventRows = await db.select().from(caseEvents);
    expect(eventRows.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "created",
      "issue_linked",
      "document_revised",
      "status_changed",
      "attachment_added",
    ]));
    expect(eventRows.filter((event) => event.runId === runId)).toHaveLength(eventRows.length);
  });

  it("rejects cross-company agent access across the cases route surface", async () => {
    await enableCases();
    const ownCompany = await seedCompany("OWN");
    const otherCompany = await seedCompany("OTH");
    const agent = await seedAgent(ownCompany.id);
    const [otherIssue] = await db.insert(issues).values({
      companyId: otherCompany.id,
      identifier: `${otherCompany.issuePrefix.toUpperCase()}-1`,
      title: "Other company task",
      status: "todo",
    }).returning();
    const [caseRow] = await db.insert(cases).values({
      companyId: otherCompany.id,
      caseNumber: 1,
      identifier: `${otherCompany.issuePrefix.toUpperCase()}-C1`,
      caseType: "bug",
      title: "Other company case",
    }).returning();
    const [ownCase] = await db.insert(cases).values({
      companyId: ownCompany.id,
      caseNumber: 1,
      identifier: `${ownCompany.issuePrefix.toUpperCase()}-C1`,
      caseType: "bug",
      title: "Own company case",
    }).returning();
    await db.insert(caseEvents).values({
      companyId: otherCompany.id,
      caseId: caseRow!.id,
      kind: "created",
      actorType: "system",
      payload: {},
    });

    const agentActor: Express.Request["actor"] = {
      type: "agent",
      companyId: ownCompany.id,
      agentId: agent.id,
      source: "agent_key",
      keyId: "key-1",
      onBehalfOfUserId: "user-1",
      onBehalfOfMemberships: [],
    };
    const http = request(app(agentActor));

    await http.get(`/api/companies/${otherCompany.id}/cases`).expect(403);
    await http
      .post(`/api/companies/${otherCompany.id}/cases`)
      .send({ caseType: "bug", title: "Wrong company create" })
      .expect(403);
    await http.get(`/api/cases/${caseRow!.id}`).expect(404);
    await http.get(`/api/cases/${caseRow!.identifier}`).expect(404);
    await http.patch(`/api/cases/${caseRow!.id}`).send({ status: "in_progress" }).expect(404);
    await http.put(`/api/cases/${caseRow!.id}/documents/body`).send({ body: "Body" }).expect(404);
    await http
      .post(`/api/cases/${caseRow!.id}/links`)
      .send({ issueId: otherIssue!.id, role: "reference" })
      .expect(404);
    await http
      .post(`/api/cases/${caseRow!.id}/attachments`)
      .attach("file", Buffer.from("artifact"), "artifact.txt")
      .expect(404);
    await http.get(`/api/cases/${caseRow!.id}/events`).expect(404);
    await http.get(`/api/issues/${otherIssue!.id}/cases`).expect(404);
    await http.get(`/api/issues/${otherIssue!.identifier}/cases`).expect(404);

    const limitedBoardActor: Express.Request["actor"] = {
      type: "board",
      userId: "limited-board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [ownCompany.id],
      memberships: [{ companyId: ownCompany.id, membershipRole: "operator", status: "active" }],
    };
    await db.insert(companyMemberships).values({ companyId: ownCompany.id, principalType: "user", principalId: "limited-board-user", status: "active", membershipRole: "operator" });
    const limitedBoardHttp = request(app(limitedBoardActor));
    const ownCaseResponse = await limitedBoardHttp.get(`/api/cases/${ownCase!.id}`).expect(200);
    expect(ownCaseResponse.body.id).toBe(ownCase!.id);
    await limitedBoardHttp.get(`/api/cases/${caseRow!.id}`).expect(404);
    await limitedBoardHttp.get(`/api/cases/${caseRow!.identifier}`).expect(404);
    await limitedBoardHttp.get(`/api/issues/${otherIssue!.id}/cases`).expect(404);
    await limitedBoardHttp.get(`/api/issues/${otherIssue!.identifier}/cases`).expect(404);

    const scopedAdminHttp = request(app({ ...limitedBoardActor, isInstanceAdmin: true }));
    await scopedAdminHttp.get(`/api/cases/${caseRow!.id}`).expect(404);
    await scopedAdminHttp.get(`/api/cases/${caseRow!.identifier}`).expect(404);
    await scopedAdminHttp.get(`/api/issues/${otherIssue!.id}/cases`).expect(404);
    await scopedAdminHttp.get(`/api/issues/${otherIssue!.identifier}/cases`).expect(404);

    expect(await db.select().from(cases)).toHaveLength(2);
    expect(await db.select().from(caseDocuments)).toHaveLength(0);
    expect(await db.select().from(documents)).toHaveLength(0);
    expect(await db.select().from(caseIssueLinks)).toHaveLength(0);
    expect(await db.select().from(caseAttachments)).toHaveLength(0);
    expect(await db.select().from(assets)).toHaveLength(0);
    expect(await db.select().from(caseEvents)).toHaveLength(1);
  });

  it("returns identical cross-company and absent case handoff responses without mutating passive cases", async () => {
    await enableCases();
    const own = await seedCompany("HANDOFF-OWN"), foreign = await seedCompany("HANDOFF-FOREIGN");
    const agent = await seedAgent(own.id);
    const [ownCase, foreignCase] = await db.insert(cases).values([
      { companyId: own.id, caseNumber: 1, identifier: `${own.issuePrefix}-C1`, caseType: "work", title: "Own passive case" },
      { companyId: foreign.id, caseNumber: 1, identifier: `${foreign.issuePrefix}-C1`, caseType: "work", title: "Foreign confidential case", fields: { privateFact: "Keep this private" } },
    ]).returning();
    await db.insert(companyMemberships).values({ companyId: own.id, principalType: "user", principalId: "handoff-operator", status: "active", membershipRole: "operator" });
    const scopedBoard: Express.Request["actor"] = { type: "board", source: "session", userId: "handoff-operator",
      companyIds: [own.id], isInstanceAdmin: false,
      memberships: [{ companyId: own.id, membershipRole: "operator", status: "active" }] };
    const actors: Express.Request["actor"][] = [
      { type: "agent", companyId: own.id, agentId: agent.id, source: "agent_key" },
      scopedBoard, { ...scopedBoard, isInstanceAdmin: true },
    ];
    // An authorized passive case has an empty history, proving the real router
    // is mounted rather than accepting Express's unmatched-route 404.
    await request(app(boardActor)).get(`/api/cases/${ownCase!.id}/handoffs`).expect(200);
    const absentCaseId = randomUUID(), handoffId = randomUUID();
    for (const actor of actors) {
      const http = request(app(actor));
      const presentHistory = await http.get(`/api/cases/${foreignCase!.id}/handoffs`).expect(404);
      const absentHistory = await http.get(`/api/cases/${absentCaseId}/handoffs`).expect(404);
      expect(presentHistory.body).toEqual(absentHistory.body);
      for (const action of ["retry", "cancel"]) {
        const presentControl = await http.post(`/api/cases/${foreignCase!.id}/handoffs/${handoffId}/${action}`).send({}).expect(404);
        const absentControl = await http.post(`/api/cases/${absentCaseId}/handoffs/${handoffId}/${action}`).send({}).expect(404);
        expect(presentControl.body).toEqual(absentControl.body);
      }
    }
    expect(await db.select().from(cases).where(eq(cases.id, foreignCase!.id))).toEqual([foreignCase]);
    expect(await db.select().from(caseHandoffs)).toHaveLength(0);
    expect(await db.select().from(caseEvents)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("supports documents, manual issue links, attachment links, events, and list filters", async () => {
    await enableCases();
    const company = await seedCompany("SUR");
    const [label] = await db.insert(labels).values({
      companyId: company.id,
      name: "Needs Review",
      color: "#f59e0b",
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix.toUpperCase()}-12`,
      title: "Related task",
      status: "todo",
    }).returning();
    const http = request(app(boardActor));
    const created = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "incident", title: "Production incident", status: "in_progress" })
      .expect(201);

    await http.patch(`/api/cases/${created.body.id}`).send({ labels: [label!.id] }).expect(200);
    await http.put(`/api/cases/${created.body.identifier}/documents/runbook`).send({ body: "Steps" }).expect(200);
    await http.post(`/api/cases/${created.body.id}/links`).send({ issueId: issue!.id, role: "reference" }).expect(201);
    await http.post(`/api/cases/${created.body.id}/attachments`).attach("file", Buffer.from("artifact"), "artifact.txt").expect(201);

    const activeList = await http
      .get(`/api/companies/${company.id}/cases`)
      .query({ status: "active", label: label!.id, q: "Production" })
      .expect(200);
    expect(activeList.body).toHaveLength(1);
    expect(activeList.body[0].id).toBe(created.body.id);

    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Launch" }).returning();
    const [projectCase] = await db.insert(cases).values({
      companyId: company.id,
      projectId: project!.id,
      caseNumber: 50,
      identifier: `${company.issuePrefix.toUpperCase()}-C50`,
      caseType: "brief",
      title: "Project brief",
      status: "draft",
    }).returning();
    const multiFiltered = await http
      .get(`/api/companies/${company.id}/cases`)
      .query({ types: ["incident", "brief"], statuses: ["in_progress", "draft"], projectIds: [project!.id], includeNoProject: "true" })
      .expect(200);
    expect(multiFiltered.body.map((row: { id: string }) => row.id).sort()).toEqual([created.body.id, projectCase!.id].sort());

    await db.insert(cases).values(Array.from({ length: 205 }, (_, index) => ({
      companyId: company.id,
      caseNumber: 100 + index,
      identifier: `${company.issuePrefix.toUpperCase()}-C${100 + index}`,
      caseType: "incident",
      title: `Filler incident ${index}`,
      status: "in_progress",
      updatedAt: new Date(`2030-01-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`),
    })));
    const deepFiltered = await http
      .get(`/api/companies/${company.id}/cases`)
      .query({ q: "Production", limit: 1 })
      .expect(200);
    expect(deepFiltered.body).toHaveLength(1);
    expect(deepFiltered.body[0].id).toBe(created.body.id);

    const detail = await http.get(`/api/cases/${created.body.identifier}`).expect(200);
    expect(detail.body.labels).toHaveLength(1);
    expect(detail.body.documents).toHaveLength(1);
    expect(detail.body.issueLinks).toHaveLength(1);
    expect(detail.body.attachments).toHaveLength(1);

    const events = await http.get(`/api/cases/${created.body.id}/events`).expect(200);
    expect(events.body.map((event: { kind: string }) => event.kind)).toEqual(
      expect.arrayContaining(["created", "label_added", "document_revised", "issue_linked", "attachment_added"]),
    );
    const linkedEvent = events.body.find((event: { kind: string }) => event.kind === "issue_linked");
    expect(linkedEvent.issue).toMatchObject({
      id: issue!.id,
      identifier: issue!.identifier,
      title: "Related task",
      status: "todo",
    });
  });

  it("enriches events and revisions with actor name and run→issue attribution", async () => {
    await enableCases();
    const company = await seedCompany("ATT");
    const agent = await seedAgent(company.id);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: agent.id,
      status: "running",
    });
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Attribution source task",
      status: "in_progress",
      executionRunId: runId,
    }).returning();

    const agentActor: Express.Request["actor"] = {
      type: "agent",
      companyId: company.id,
      agentId: agent.id,
      runId,
      source: "agent_jwt",
      onBehalfOfUserId: null,
      onBehalfOfMemberships: [],
    };
    const http = request(app(agentActor));

    const created = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "blog_post", title: "Attribution post" })
      .expect(201);
    // Two revisions on the body document.
    const rev1 = await http
      .put(`/api/cases/${created.body.id}/documents/body`)
      .send({ body: "# v1" })
      .expect(200);
    await http
      .put(`/api/cases/${created.body.id}/documents/body`)
      .send({ body: "# v2", baseRevisionId: rev1.body.revision.id, changeSummary: "polish" })
      .expect(200);

    const events = await http.get(`/api/cases/${created.body.id}/events`).expect(200);
    const revisedEvent = events.body.find((e: { kind: string }) => e.kind === "document_revised");
    expect(revisedEvent.actorAgentName).toBe("Cases Agent");
    expect(revisedEvent.issue).toMatchObject({ id: issue!.id, title: "Attribution source task" });

    const revisions = await http
      .get(`/api/cases/${created.body.id}/documents/body/revisions`)
      .expect(200);
    expect(revisions.body.revisions).toHaveLength(2);
    expect(revisions.body.revisions[0].revisionNumber).toBe(2);
    expect(revisions.body.revisions[0].body).toBe("# v2");
    expect(revisions.body.revisions[0].changeSummary).toBe("polish");
    expect(revisions.body.revisions[0].actorAgentName).toBe("Cases Agent");
    expect(revisions.body.revisions[0].issue).toMatchObject({ id: issue!.id });
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, created.body.id));
    const documentActivity = activity.filter(row => row.action === "case.document_revised");
    expect(documentActivity).toHaveLength(2);
    expect(documentActivity).toEqual(expect.arrayContaining([expect.objectContaining({
      actorType: "agent", actorId: agent.id, agentId: agent.id, runId,
      details: expect.objectContaining({ key: "body", documentKey: "body", documentId: rev1.body.document.id }),
    })]));
  });

  it("locks, unlocks, deletes, and restores case documents through shared document controls", async () => {
    await enableCases();
    const company = await seedCompany("DOC");
    const http = request(app(boardActor));
    const created = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "blog_post", title: "Document controls" })
      .expect(201);
    const publishedRevisions: Record<string, unknown>[] = [];
    liveEventUnsubscribers.push(subscribeCompanyLiveEvents(company.id, event => {
      if (event.payload.action === "case.document_revised") publishedRevisions.push(event.payload);
    }));

    const firstRevision = await http
      .put(`/api/cases/${created.body.id}/documents/body`)
      .send({ body: "# v1" })
      .expect(200);
    const secondRevision = await http
      .put(`/api/cases/${created.body.id}/documents/body`)
      .send({ body: "# v2", baseRevisionId: firstRevision.body.revision.id })
      .expect(200);

    const loaded = await http.get(`/api/cases/${created.body.id}/documents/body`).expect(200);
    expect(loaded.body.body).toBe("# v2");
    expect(loaded.body.latestRevisionNumber).toBe(2);

    const locked = await http.post(`/api/cases/${created.body.id}/documents/body/lock`).expect(200);
    expect(locked.body.lockedAt).toBeTruthy();
    await http
      .put(`/api/cases/${created.body.id}/documents/body`)
      .send({ body: "# blocked", baseRevisionId: secondRevision.body.revision.id })
      .expect(409);
    await http.delete(`/api/cases/${created.body.id}/documents/body`).expect(409);

    const unlocked = await http.post(`/api/cases/${created.body.id}/documents/body/unlock`).expect(200);
    expect(unlocked.body.lockedAt).toBeNull();

    const restored = await http
      .post(`/api/cases/${created.body.id}/documents/body/revisions/${firstRevision.body.revision.id}/restore`)
      .expect(200);
    expect(restored.body.document.body).toBe("# v1");
    expect(restored.body.document.latestRevisionNumber).toBe(3);
    expect(restored.body.restoredFromRevisionNumber).toBe(1);

    const revisions = await http.get(`/api/cases/${created.body.id}/documents/body/revisions`).expect(200);
    expect(revisions.body.revisions).toHaveLength(3);
    expect(revisions.body.revisions[0].changeSummary).toBe("Restored from revision 1");

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, created.body.id));
    const documentActivity = activity.filter(row => row.action === "case.document_revised");
    expect(documentActivity).toHaveLength(3);
    expect(publishedRevisions).toHaveLength(3);
    const revisionsByNumber = new Map([firstRevision, secondRevision, restored].map((response, index) => [index + 1, response.body.revision.id]));
    for (const row of documentActivity) {
      const details = row.details as Record<string, unknown>;
      expect(row).toMatchObject({ companyId: company.id, entityType: "case", entityId: created.body.id, actorType: "user", actorId: "board-user" });
      expect(details).toMatchObject({ key: "body", documentKey: "body", documentId: firstRevision.body.document.id,
        revisionId: revisionsByNumber.get(details.revisionNumber as number) });
      expect(details).not.toHaveProperty("body");
      expect(details).not.toHaveProperty("title");
      expect(publishedRevisions).toContainEqual(expect.objectContaining({ entityType: "case", entityId: created.body.id,
        action: "case.document_revised", details }));
    }
    expect(documentActivity.find(row => (row.details as Record<string, unknown>).revisionNumber === 3)?.details).toMatchObject({
      restoredFromRevisionId: firstRevision.body.revision.id, restoredFromRevisionNumber: 1,
    });
    expect(JSON.stringify(publishedRevisions)).not.toMatch(/# v1|# v2|# blocked/);

    await http.delete(`/api/cases/${created.body.id}/documents/body`).expect(200);
    await http.get(`/api/cases/${created.body.id}`).expect(200).expect((res) => {
      expect(res.body.documents).toHaveLength(0);
    });
  });

  it("creates, replies to, resolves, reopens, and remaps case document annotations", async () => {
    await enableCases();
    const company = await seedCompany("ANN");
    const http = request(app(boardActor));
    const created = await http
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "brief", title: "Annotated case" })
      .expect(201);
    const document = await http
      .put(`/api/cases/${created.body.id}/documents/body`)
      .send({ body: "Alpha beta gamma" })
      .expect(200);

    const annotation = await http
      .post(`/api/cases/${created.body.id}/documents/body/annotations`)
      .send({
        baseRevisionId: document.body.revision.id,
        baseRevisionNumber: document.body.revision.revisionNumber,
        selector: {
          quote: { exact: "beta", prefix: "Alpha ", suffix: " gamma" },
          position: { normalizedStart: 6, normalizedEnd: 10, markdownStart: 6, markdownEnd: 10 },
        },
        body: "Clarify this word.",
      })
      .expect(201);

    expect(annotation.body.caseId).toBe(created.body.id);
    expect(annotation.body.issueId).toBeNull();
    expect(annotation.body.routineId).toBeNull();
    expect(annotation.body.comments[0].caseId).toBe(created.body.id);

    const listed = await http
      .get(`/api/cases/${created.body.identifier}/documents/body/annotations?status=all&includeComments=true`)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].comments).toHaveLength(1);

    const reply = await http
      .post(`/api/cases/${created.body.id}/documents/body/annotations/${annotation.body.id}/comments`)
      .send({ body: "Added context." })
      .expect(201);
    expect(reply.body.caseId).toBe(created.body.id);

    const resolved = await http
      .patch(`/api/cases/${created.body.id}/documents/body/annotations/${annotation.body.id}`)
      .send({ status: "resolved" })
      .expect(200);
    expect(resolved.body.status).toBe("resolved");

    const reopened = await http
      .patch(`/api/cases/${created.body.id}/documents/body/annotations/${annotation.body.id}`)
      .send({ status: "open" })
      .expect(200);
    expect(reopened.body.status).toBe("open");

    const updatedDocument = await http
      .put(`/api/cases/${created.body.id}/documents/body`)
      .send({
        body: "Alpha beta gamma delta",
        baseRevisionId: document.body.revision.id,
      })
      .expect(200);
    const remapped = await http
      .get(`/api/cases/${created.body.id}/documents/body/annotations/${annotation.body.id}`)
      .expect(200);
    expect(remapped.body.currentRevisionNumber).toBe(updatedDocument.body.revision.revisionNumber);
    expect(remapped.body.comments).toHaveLength(2);

    const activities = await db
      .select({ action: activityLog.action, entityType: activityLog.entityType, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.entityId, created.body.id));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "case", action: "case.document_annotation_thread_created" }),
      expect.objectContaining({ entityType: "case", action: "case.document_annotation_comment_added" }),
      expect.objectContaining({ entityType: "case", action: "case.document_annotation_thread_resolved" }),
      expect.objectContaining({ entityType: "case", action: "case.document_annotation_thread_reopened" }),
      expect.objectContaining({ entityType: "case", action: "case.document_annotation_remapped" }),
    ]));
  });

  it("lists children by parent, exposes parent in detail, and lists cases for an issue", async () => {
    await enableCases();
    const company = await seedCompany("TREE");
    const boardHttp = request(app(boardActor));
    const parent = await boardHttp
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "epic", title: "Parent epic" })
      .expect(201);
    const child = await boardHttp
      .post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "task", title: "Child task", parentCaseId: parent.body.id })
      .expect(201);

    const children = await boardHttp
      .get(`/api/companies/${company.id}/cases`)
      .query({ parent: parent.body.id })
      .expect(200);
    expect(children.body).toHaveLength(1);
    expect(children.body[0].id).toBe(child.body.id);

    const searchOnly = await boardHttp
      .get(`/api/companies/${company.id}/cases`)
      .query({ q: "Child task" })
      .expect(200);
    expect(searchOnly.body.map((row: { id: string }) => row.id)).toEqual([child.body.id]);

    const searchWithAncestors = await boardHttp
      .get(`/api/companies/${company.id}/cases`)
      .query({ q: "Child task", includeAncestors: "true" })
      .expect(200);
    expect(searchWithAncestors.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: child.body.id, matchesListFilters: true }),
      expect.objectContaining({ id: parent.body.id, matchesListFilters: false }),
    ]));

    const childDetail = await boardHttp.get(`/api/cases/${child.body.id}`).expect(200);
    expect(childDetail.body.parent).toMatchObject({ id: parent.body.id, identifier: parent.body.identifier });

    // Link the child case to an issue, then resolve cases-for-issue.
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Issue with cases",
      status: "todo",
    }).returning();
    await boardHttp
      .post(`/api/cases/${child.body.id}/links`)
      .send({ issueId: issue!.id, role: "work" })
      .expect(201);

    const forIssue = await boardHttp.get(`/api/issues/${issue!.id}/cases`).expect(200);
    expect(forIssue.body).toHaveLength(1);
    expect(forIssue.body[0]).toMatchObject({ role: "work" });
    expect(forIssue.body[0].case).toMatchObject({ id: child.body.id, identifier: child.body.identifier, status: child.body.status });
  });
  it("enriches case pages and detail with current work in bounded batch queries", async () => {
    await enableCases();
    const company = await seedCompany("WORK-LIST");
    const sender = await seedAgent(company.id);
    const recipient = await seedAgent(company.id);
    await db.update(agents).set({ name: "Triage" }).where(eq(agents.id, sender.id));
    await db.update(agents).set({ name: "Verifier" }).where(eq(agents.id, recipient.id));
    const work = await db.insert(issues).values(Array.from({ length: 20 }, (_, index) => ({
      companyId: company.id, title: `Task ${index}`, identifier: `${company.issuePrefix}-${index + 1}`,
      assigneeAgentId: sender.id, status: "todo",
    }))).returning();
    const records = await db.insert(cases).values(work.map((issue, index) => ({
      companyId: company.id, caseNumber: index + 1, identifier: `${company.issuePrefix}-C${index + 1}`,
      caseType: "factory", title: `Case ${index}`, workIssueId: issue.id, phase: "triage", handoffVersion: 1,
    }))).returning();
    const pending = await db.insert(caseHandoffs).values(records.map((record, index) => ({
      companyId: company.id, caseId: record.id, issueId: work[index]!.id, version: 1,
      fromAgentId: sender.id, toAgentId: recipient.id, phase: "verification", instructions: "Check the saved work.",
      actorType: "user" as const, actorId: "board-user", wakeupRequestId: randomUUID(),
      actorContext: { schema: "paperclip.case-handoff-actor.v1", companyId: company.id, actorType: "user", actorId: "board-user",
        source: "session", runId: null, keyId: null, sessionId: "INTERNAL_SESSION_CANARY", keyScope: { kind: "standard" },
        onBehalfOfUserId: null, authorizingUserId: null },
      idempotencyKey: randomUUID(), inputFingerprint: "a".repeat(64), state: "pending_dispatch" as const,
    }))).returning();
    const http = request(app(boardActor));
    const select = vi.spyOn(db, "select");
    try {
      await http.get(`/api/companies/${company.id}/cases?limit=1`).expect(200);
      const singleSelects = select.mock.calls.length;
      select.mockClear();
      const page = await http.get(`/api/companies/${company.id}/cases?limit=20`).expect(200);
      expect(page.body).toHaveLength(20);
      // These are actual Drizzle reads against PostgreSQL, observed without
      // replacing their results. A task/handoff read per row fails this bound.
      expect(select.mock.calls.length).toBeLessThanOrEqual(singleSelects + 1);
      const first = page.body.find((row: { id: string }) => row.id === records[0]!.id);
      expect(first).toMatchObject({ phase: "triage", handoffVersion: 1,
        workIssue: { id: work[0]!.id, assigneeAgentId: sender.id, assigneeAgentName: "Triage", status: "todo" },
        pendingHandoff: { id: pending[0]!.id, phase: "verification", state: "pending_dispatch", fromAgentName: "Triage", toAgentName: "Verifier" },
      });
      const detail = await http.get(`/api/cases/${records[0]!.id}`).expect(200);
      expect(detail.body.workIssue).toEqual(first.workIssue);
      expect(detail.body.pendingHandoff).toEqual(first.pendingHandoff);
      for (const row of page.body) expect(row.pendingHandoff).not.toHaveProperty("actorContext");
      expect(detail.body.pendingHandoff).not.toHaveProperty("actorContext");
      expect(JSON.stringify([page.body, detail.body])).not.toContain("INTERNAL_SESSION_CANARY");
    } finally {
      select.mockRestore();
    }
  });

  it("paginates authorized filtered cases and discovers types outside the current page", async () => {
    await enableCases();
    const company = await seedCompany("LIST-PAGE");
    const owner = await seedAgent(company.id);
    const reader = await seedAgent(company.id);
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
    const [privateSource] = await db.insert(issues).values({ companyId: company.id, title: "Private", visibility: "private", assigneeAgentId: owner.id }).returning();
    const [hidden, first, second] = await db.insert(cases).values([
      { companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, title: "Needle hidden", caseType: "factory", status: "in_progress", updatedAt: new Date("2030-01-04") },
      { companyId: company.id, caseNumber: 2, identifier: `${company.issuePrefix}-C2`, title: "Needle first", caseType: "factory", status: "in_progress", updatedAt: new Date("2030-01-03") },
      { companyId: company.id, caseNumber: 3, identifier: `${company.issuePrefix}-C3`, title: "Needle second", caseType: "factory", status: "in_progress", updatedAt: new Date("2030-01-02") },
      { companyId: company.id, caseNumber: 4, identifier: `${company.issuePrefix}-C4`, title: "Unrelated draft", caseType: "research", status: "draft" },
      { companyId: company.id, caseNumber: 5, identifier: `${company.issuePrefix}-C5`, title: "Needle project", caseType: "factory", status: "in_progress", projectId: project!.id, updatedAt: new Date("2030-01-05") },
    ]).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: hidden!.id, sourceKind: "issue", sourceId: privateSource!.id });
    const [secretType] = await db.insert(cases).values({ companyId: company.id, caseNumber: 6,
      identifier: `${company.issuePrefix}-C6`, title: "Private type", caseType: "secret-type" }).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: secretType!.id, sourceKind: "issue", sourceId: privateSource!.id });
    const http = request(app({ type: "agent", companyId: company.id, agentId: reader.id, source: "agent_key" }));
    const query = { q: "Needle", type: "factory", status: "in_progress", includeNoProject: "true", limit: 1 };
    const firstPage = await http.get(`/api/companies/${company.id}/cases`).query(query).expect(200);
    const secondPage = await http.get(`/api/companies/${company.id}/cases`).query({ ...query, offset: 1 }).expect(200);
    expect(firstPage.body.map((row: { id: string }) => row.id)).toEqual([first!.id]);
    expect(secondPage.body.map((row: { id: string }) => row.id)).toEqual([second!.id]);
    await http.get(`/api/companies/${company.id}/cases`).query({ offset: -1 }).expect(400);
    const types = await http.get(`/api/companies/${company.id}/cases/types`).expect(200);
    expect(types.body).toEqual(["factory", "research"]);
    await db.delete(issues).where(eq(issues.id, privateSource!.id));
    expect((await http.get(`/api/companies/${company.id}/cases/types`).expect(200)).body).toEqual(types.body);
  });

  it("sorts and groups the full authorized result before pagination", async () => {
    await enableCases();
    const company = await seedCompany("LIST-ORDER");
    const owner = await seedAgent(company.id);
    const reader = await seedAgent(company.id);
    const projectRows = await db.insert(projects).values([
      { companyId: company.id, name: "One" },
      { companyId: company.id, name: "Two" },
    ]).returning();
    const [privateSource] = await db.insert(issues).values({
      companyId: company.id, title: "Private", visibility: "private", assigneeAgentId: owner.id,
    }).returning();
    const statuses = ["draft", "in_progress", "in_review", "approved", "done", "cancelled"];
    const types = ["factory", "incident", "research"];
    const records = await db.insert(cases).values(Array.from({ length: 207 }, (_, index) => ({
      companyId: company.id, caseNumber: index + 1, identifier: `${company.issuePrefix}-C${index + 1}`,
      title: `${index % 2 ? "Alpha" : "beta"} ${String(207 - index).padStart(3, "0")}`,
      caseType: types[index % types.length]!, status: statuses[index % statuses.length]!,
      projectId: index % 3 === 2 ? null : projectRows[index % 3]!.id,
      createdAt: new Date(Date.UTC(2030, 0, 1, 0, index)),
      updatedAt: new Date(Date.UTC(2031, 0, 1, 0, 207 - index)),
    }))).returning();
    const [hidden] = await db.insert(cases).values({
      companyId: company.id, caseNumber: 208, identifier: `${company.issuePrefix}-C208`,
      title: "000 confidential", caseType: "a-secret", status: "draft",
      updatedAt: new Date("2035-01-01"),
    }).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: hidden!.id, sourceKind: "issue", sourceId: privateSource!.id });
    const http = request(app({ type: "agent", companyId: company.id, agentId: reader.id, source: "agent_key" }));
    type SortField = "updated" | "created" | "title" | "status" | "type";
    type GroupBy = "none" | "status" | "type" | "project";
    type RecordRow = (typeof records)[number];
    const compare = (left: string | number, right: string | number) => left < right ? -1 : left > right ? 1 : 0;
    const sortValue = (row: RecordRow, field: SortField) => ({
      updated: row.updatedAt.getTime(), created: row.createdAt.getTime(), title: row.title.toLowerCase(),
      status: statuses.indexOf(row.status), type: row.caseType,
    })[field];
    const options: Array<{ sortField?: SortField; sortDir?: "asc" | "desc"; groupBy?: GroupBy }> = [
      {}, { sortField: "updated", sortDir: "asc" }, { sortField: "created", sortDir: "asc" },
      { sortField: "title", sortDir: "asc" }, { sortField: "status", sortDir: "desc" },
      { sortField: "type", sortDir: "asc" },
      { groupBy: "status", sortField: "title", sortDir: "asc" },
      { groupBy: "type", sortField: "created", sortDir: "desc" },
      { groupBy: "project", sortField: "updated", sortDir: "asc" },
    ];
    for (const option of options) {
      const expected = [...records].sort((left, right) => {
        let grouped = 0;
        if (option.groupBy === "status") grouped = compare(statuses.indexOf(left.status), statuses.indexOf(right.status));
        if (option.groupBy === "type") grouped = compare(left.caseType, right.caseType);
        if (option.groupBy === "project") grouped = left.projectId === null ? Number(right.projectId !== null)
          : right.projectId === null ? -1 : compare(left.projectId, right.projectId);
        return grouped || (option.sortDir === "asc" ? 1 : -1) * compare(sortValue(left, option.sortField ?? "updated"), sortValue(right, option.sortField ?? "updated"))
          || compare(right.updatedAt.getTime(), left.updatedAt.getTime())
          || compare(right.createdAt.getTime(), left.createdAt.getTime()) || compare(right.id, left.id);
      });
      const first = await http.get(`/api/companies/${company.id}/cases`).query({ ...option, limit: 200 }).expect(200);
      const second = await http.get(`/api/companies/${company.id}/cases`).query({ ...option, offset: 200, limit: 200 }).expect(200);
      expect([...first.body, ...second.body].map((row: { id: string }) => row.id), JSON.stringify(option)).toEqual(expected.map((row) => row.id));
    }
    for (const invalid of [{ sortField: "assignee" }, { sortDir: "sideways" }, { groupBy: "private" }]) {
      await http.get(`/api/companies/${company.id}/cases`).query(invalid).expect(400);
    }
  });

  it("does not enrich readable cases with inaccessible tasks or out-of-bound agent names", async () => {
    await enableCases();
    const company = await seedCompany("LIST-BOUNDARY");
    const owner = await seedAgent(company.id);
    const reader = await seedAgent(company.id);
    const rootId = randomUUID();
    await db.update(agents).set({ name: "Private owner" }).where(eq(agents.id, owner.id));
    await db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: {
      trustBoundary: { mode: "low_trust_review", rootIssueId: rootId },
    } } }).where(eq(agents.id, reader.id));
    const [privateWork, allowedWork] = await db.insert(issues).values([
      { companyId: company.id, title: "Private task contents", visibility: "private", assigneeAgentId: owner.id },
      { id: rootId, companyId: company.id, title: "Allowed task", assigneeAgentId: reader.id },
    ]).returning();
    const [malformed, allowed] = await db.insert(cases).values([
      { companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, title: "Legacy public record", caseType: "factory", workIssueId: privateWork!.id },
      { companyId: company.id, caseNumber: 2, identifier: `${company.issuePrefix}-C2`, title: "Allowed record", caseType: "factory", workIssueId: allowedWork!.id },
    ]).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: allowed!.id, sourceKind: "issue", sourceId: allowedWork!.id });
    await db.insert(caseHandoffs).values([malformed!, allowed!].map((record, index) => ({
      companyId: company.id, caseId: record.id, issueId: record.workIssueId!, version: 1,
      fromAgentId: owner.id, toAgentId: reader.id, phase: "verify", instructions: index ? "Allowed instruction" : "Private handoff contents",
      actorType: "user" as const, actorId: "board-user", wakeupRequestId: randomUUID(),
      idempotencyKey: randomUUID(), inputFingerprint: "a".repeat(64), state: "pending_dispatch" as const,
    })));
    const ordinary = request(app({ type: "agent", companyId: company.id, agentId: reader.id, source: "agent_key" }));
    // A low-trust caller cannot read the unsourced company record at all.
    const page = await ordinary.get(`/api/companies/${company.id}/cases`).expect(200);
    expect(page.body).toHaveLength(1);
    expect(page.body[0]).toMatchObject({ id: allowed!.id, workIssue: { id: allowedWork!.id },
      pendingHandoff: { instructions: "Allowed instruction", fromAgentName: null, toAgentName: null } });
    expect(JSON.stringify(page.body)).not.toContain("Private owner");
    // Standard company access can read a legacy passive case, but its malformed
    // primary link must not bypass the private task's independent boundary.
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, reader.id));
    const visible = await ordinary.get(`/api/cases/${malformed!.id}`).expect(200);
    expect(visible.body.workIssue).toBeNull();
    expect(visible.body.pendingHandoff).toBeNull();
    expect(JSON.stringify(visible.body)).not.toContain("Private handoff contents");
  });

  it("filters retained private cases before pagination and protects nested content", async () => {
    await enableCases();
    const company = await seedCompany("PRIV");
    const owner = await seedAgent(company.id);
    const unrelated = await seedAgent(company.id);
    const [source] = await db.insert(issues).values({ companyId: company.id, title: "Private source", visibility: "private", assigneeAgentId: owner.id }).returning();
    const [hidden] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, caseType: "work", title: "Secret case", updatedAt: new Date("2030-01-01") }).returning();
    const [open] = await db.insert(cases).values({ companyId: company.id, caseNumber: 2, identifier: `${company.issuePrefix}-C2`, caseType: "work", title: "Open case" }).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: hidden!.id, sourceKind: "issue", sourceId: source!.id });
    const actor = { type: "agent" as const, companyId: company.id, agentId: unrelated.id, source: "agent_key" as const };
    const http = request(app(actor));
    const list = await http.get(`/api/companies/${company.id}/cases?limit=1`).expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toEqual([open!.id]);
    await http.get(`/api/cases/${hidden!.id}`).expect(404);
    await http.get(`/api/cases/${hidden!.id}/events`).expect(404);
    await http.get(`/api/cases/${hidden!.id}/documents/spec/revisions`).expect(404);
    await http.get(`/api/cases/${hidden!.id}/documents/spec/annotations`).expect(404);
    await http.patch(`/api/cases/${hidden!.id}`).send({ fields: { stolen: true } }).expect(404);
    expect(await canActorReadCase(db, { ...actor, agentId: owner.id }, hidden!.id)).toBe(true);
  });

  it("retains source boundaries after unlink and fails closed after source deletion", async () => {
    const company = await seedCompany("KEEP");
    const owner = await seedAgent(company.id);
    const [source] = await db.insert(issues).values({ companyId: company.id, title: "Source", visibility: "private", assigneeAgentId: owner.id }).returning();
    const [record] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, caseType: "work", title: "Retained" }).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: record!.id, sourceKind: "issue", sourceId: source!.id });
    await db.insert(caseIssueLinks).values({ companyId: company.id, caseId: record!.id, issueId: source!.id, role: "origin" });
    await db.delete(caseIssueLinks).where(eq(caseIssueLinks.caseId, record!.id));
    const actor = { type: "agent" as const, companyId: company.id, agentId: owner.id };
    expect(await canActorReadCase(db, actor, record!.id)).toBe(true);
    await db.delete(issues).where(eq(issues.id, source!.id));
    expect(await canActorReadCase(db, actor, record!.id)).toBe(false);
    expect(await db.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, record!.id))).toHaveLength(1);
  });

  it("prospectively grants only the transferred task, preserving unrelated retained boundaries", async () => {
    const company = await seedCompany("DEST");
    const owner = await seedAgent(company.id);
    const recipient = await seedAgent(company.id);
    const [primary, unrelated] = await db.insert(issues).values([
      { companyId: company.id, title: "Primary", visibility: "private", assigneeAgentId: owner.id },
      { companyId: company.id, title: "Other source", visibility: "private", assigneeAgentId: owner.id },
    ]).returning();
    const [record] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, caseType: "work", title: "Prospective", workIssueId: primary!.id }).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: record!.id, sourceKind: "issue", sourceId: primary!.id });
    const actor = { type: "agent" as const, companyId: company.id, agentId: owner.id };
    expect(await canActorReceiveCase(db, actor, record!, primary!.id, recipient.id)).toBe(true);
    await retainCaseAccessSource(db, { companyId: company.id, caseId: record!.id, sourceKind: "issue", sourceId: unrelated!.id });
    expect(await canActorReceiveCase(db, actor, record!, primary!.id, recipient.id)).toBe(false);
  });

  it("keeps case assets and activity private, including detached attachment links", async () => {
    const company = await seedCompany("EXTERNAL");
    const owner = await seedAgent(company.id);
    const outsider = await seedAgent(company.id);
    const [source] = await db.insert(issues).values({ companyId: company.id, title: "Private source", visibility: "private", assigneeAgentId: owner.id }).returning();
    const [privateCase, openCase] = await db.insert(cases).values([
      { companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, caseType: "work", title: "Private" },
      { companyId: company.id, caseNumber: 2, identifier: `${company.issuePrefix}-C2`, caseType: "work", title: "Open" },
    ]).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: privateCase!.id, sourceKind: "issue", sourceId: source!.id });
    const [asset] = await db.insert(assets).values({ companyId: company.id, provider: "local_disk", objectKey: `${company.id}/cases/${privateCase!.id}/2026/10/19/evidence.txt`, contentType: "text/plain", byteSize: 1, sha256: "a".repeat(64), originalFilename: "evidence.txt", createdByAgentId: owner.id }).returning();
    await db.insert(caseAttachments).values({ companyId: company.id, caseId: privateCase!.id, assetId: asset!.id });
    const actor = { type: "agent" as const, companyId: company.id, agentId: outsider.id };
    expect(await canActorReadAssetContent(db, actor, asset!)).toBe(false);
    expect(await canActorReadAssetContent(db, { ...actor, agentId: owner.id }, asset!)).toBe(true);
    await db.delete(caseAttachments).where(eq(caseAttachments.assetId, asset!.id));
    expect(await canActorReadAssetContent(db, actor, asset!)).toBe(false);
    await db.insert(activityLog).values([
      { companyId: company.id, actorType: "agent", actorId: owner.id, agentId: owner.id, action: "case.updated", entityType: "case", entityId: privateCase!.id, details: { title: "Secret" }, createdAt: new Date("2030-01-01") },
      { companyId: company.id, actorType: "agent", actorId: owner.id, agentId: owner.id, action: "case.updated", entityType: "case", entityId: openCase!.id, details: { title: "Open" } },
    ]);
    const caseReadCondition = await caseActivityReadSqlCondition(db, actor);
    const activity = await activityService(db).list({ companyId: company.id, caseReadCondition, limit: 1 });
    expect(activity.map(row => row.entityId)).toEqual([openCase!.id]);
    const audit = await agentActionAuditService(db).list({ companyId: company.id, caseReadCondition, limit: 1 });
    expect(audit.items.map(row => row.entityId)).toEqual([openCase!.id]);
    expect(audit.nextCursor).toBeNull();
  });

  it("keeps source-scoped cases inside the canonical low-trust read boundary", async () => {
    await enableCases();
    const company = await seedCompany("SCOPE");
    const scopedAgent = await seedAgent(company.id);
    const rootId = randomUUID();
    await db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", rootIssueId: rootId } } } }).where(eq(agents.id, scopedAgent.id));
    const [root, outside] = await db.insert(issues).values([
      { id: rootId, companyId: company.id, title: "Allowed root", assigneeAgentId: scopedAgent.id },
      { companyId: company.id, title: "Outside root" },
    ]).returning();
    const [allowedCase, outsideCase] = await db.insert(cases).values([
      { companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, caseType: "work", title: "Allowed" },
      { companyId: company.id, caseNumber: 2, identifier: `${company.issuePrefix}-C2`, caseType: "work", title: "Outside", updatedAt: new Date("2030-01-01") },
    ]).returning();
    await retainCaseAccessSource(db, { companyId: company.id, caseId: allowedCase!.id, sourceKind: "issue", sourceId: root!.id });
    await retainCaseAccessSource(db, { companyId: company.id, caseId: outsideCase!.id, sourceKind: "issue", sourceId: outside!.id });
    const actor = { type: "agent" as const, companyId: company.id, agentId: scopedAgent.id, source: "agent_key" as const };
    expect(await canActorReadCase(db, actor, allowedCase!.id)).toBe(true);
    expect(await canActorReadCase(db, actor, outsideCase!.id)).toBe(false);
    const list = await request(app(actor)).get(`/api/companies/${company.id}/cases?limit=1`).expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toEqual([allowedCase!.id]);
  });

  it("rejects quarantined run writes across standalone case routes without restricting trusted writes", async () => {
    await enableCases();
    const company = await seedCompany("WRITE-TRUST");
    const agent = await seedAgent(company.id);
    const [source] = await db.insert(issues).values({ companyId: company.id, title: "Review source", assigneeAgentId: agent.id }).returning();
    const policy = { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", rootIssueId: source!.id } } };
    const [containedRun, trustedRun] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: agent.id, issueId: source!.id, status: "running", contextSnapshot: { executionPolicy: policy } },
      { companyId: company.id, agentId: agent.id, issueId: source!.id, status: "running", contextSnapshot: { executionPolicy: {} } },
    ]).returning();
    const board = request(app(boardActor));
    const record = await board.post(`/api/companies/${company.id}/cases`).send({ caseType: "review", key: "existing", title: "Passive case", summary: "Trusted summary", fields: { trusted: true } }).expect(201);
    await board.post(`/api/cases/${record.body.id}/links`).send({ issueId: source!.id, role: "work" }).expect(201);
    await board.put(`/api/cases/${record.body.id}/documents/existing`).send({ body: "Trusted document" }).expect(200);
    const eventsBefore = await db.select().from(caseEvents);
    const sourcesBefore = await db.select().from(caseAccessSources);
    const token = createLocalAgentJwt(agent.id, company.id, agent.adapterType, containedRun!.id);
    const http = request(authenticatedApp());
    const authorization = `Bearer ${token}`;
    await http.get(`/api/cases/${record.body.id}`).set("Authorization", authorization).expect(200);
    await http.post(`/api/companies/${company.id}/cases`).set("Authorization", authorization)
      .send({ caseType: "review", key: "new", title: "Raw case", fields: { raw: "quarantined" } }).expect(403);
    await http.post(`/api/companies/${company.id}/cases`).set("Authorization", authorization)
      .send({ caseType: "review", key: "existing", title: "Raw upsert", summary: "Raw instructions" }).expect(403);
    await http.patch(`/api/cases/${record.body.id}`).set("Authorization", authorization)
      .send({ summary: "Raw instructions", fields: { raw: "quarantined" } }).expect(403);
    await http.put(`/api/cases/${record.body.id}/documents/raw`).set("Authorization", authorization)
      .send({ body: "Quarantined instructions" }).expect(403);
    await http.post(`/api/cases/${record.body.id}/documents/existing/lock`).set("Authorization", authorization).expect(403);
    await http.delete(`/api/cases/${record.body.id}/documents/existing`).set("Authorization", authorization).expect(403);
    await http.post(`/api/cases/${record.body.id}/links`).set("Authorization", authorization)
      .send({ issueId: source!.id, role: "work" }).expect(403);
    await http.post(`/api/cases/${record.body.id}/attachments`).set("Authorization", authorization)
      .attach("file", Buffer.from("Quarantined attachment"), "raw.txt").expect(403);
    const [unchanged] = await db.select().from(cases).where(eq(cases.id, record.body.id));
    expect(unchanged).toMatchObject({ title: "Passive case", summary: "Trusted summary", fields: { trusted: true }, workIssueId: null });
    expect(await db.select().from(cases)).toHaveLength(1);
    expect(await db.select().from(documents)).toHaveLength(1);
    expect(await db.select().from(assets)).toHaveLength(0);
    expect(await db.select().from(caseEvents)).toEqual(eventsBefore);
    expect(await db.select().from(caseAccessSources)).toEqual(sourcesBefore);
    const trusted = `Bearer ${createLocalAgentJwt(agent.id, company.id, agent.adapterType, trustedRun!.id)}`;
    await http.patch(`/api/cases/${record.body.id}`).set("Authorization", trusted).send({ fields: { sanitized: true } }).expect(200);
    await http.put(`/api/cases/${record.body.id}/documents/sanitized`).set("Authorization", trusted).send({ body: "Trusted finding" }).expect(200);
    await expect(assertCaseTrustedForExecution(db, { id: record.body.id, companyId: company.id })).resolves.toBeUndefined();
  });

  it("blocks historical low-trust case output from execution while preserving authorized reads", async () => {
    await enableCases();
    const company = await seedCompany("HISTORICAL-TRUST");
    const agent = await seedAgent(company.id);
    const [source] = await db.insert(issues).values({ companyId: company.id, title: "Retained source", assigneeAgentId: agent.id }).returning();
    const record = await request(app(boardActor)).post(`/api/companies/${company.id}/cases`)
      .send({ caseType: "review", title: "Historical case", fields: { unreviewed: "Old raw output" } }).expect(201);
    await retainCaseAccessSource(db, { companyId: company.id, caseId: record.body.id, sourceKind: "issue", sourceId: source!.id });
    await expect(assertCaseTrustedForExecution(db, { id: record.body.id, companyId: company.id })).resolves.toBeUndefined();
    const policy = { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", rootIssueId: source!.id } } };
    await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, source!.id));
    await expect(assertCaseTrustedForExecution(db, { id: record.body.id, companyId: company.id })).rejects.toMatchObject({ status: 403 });
    await db.update(issues).set({ executionPolicy: {} }).where(eq(issues.id, source!.id));
    const [oldRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: source!.id,
      status: "succeeded", contextSnapshot: { executionPolicy: policy } }).returning();
    // Represents output persisted before cases enforced quarantine; current task
    // and agent settings are now standard, but the recorded source run is not.
    await db.insert(caseEvents).values({ companyId: company.id, caseId: record.body.id, kind: "fields_changed",
      actorType: "agent", actorAgentId: agent.id, runId: oldRun!.id });
    await expect(assertCaseTrustedForExecution(db, { id: record.body.id, companyId: company.id })).rejects.toMatchObject({ status: 403 });
    const readable = await request(app(boardActor)).get(`/api/cases/${record.body.id}`).expect(200);
    expect(readable.body.fields).toEqual({ unreviewed: "Old raw output" });
  });

  it("preserves historical source attribution for a delivered board-originated handoff", async () => {
    const company = await seedCompany("HISTORY");
    const previous = await seedAgent(company.id), recipient = await seedAgent(company.id);
    const [task] = await db.insert(issues).values({ companyId: company.id, title: "Historical workflow", assigneeAgentId: recipient.id }).returning();
    const [record] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, caseType: "work", title: "History", workIssueId: task!.id }).returning();
    const [handoff] = await db.insert(caseHandoffs).values({ companyId: company.id, caseId: record!.id, issueId: task!.id, version: 1,
      fromAgentId: previous.id, toAgentId: recipient.id, phase: "implementation", instructions: "Continue this work", actorType: "user", actorId: "fixture-board",
      wakeupRequestId: randomUUID(), idempotencyKey: "history", inputFingerprint: "history", state: "delivered" }).returning();
    await expect(db.delete(agents).where(eq(agents.id, previous.id))).rejects.toThrow();
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, handoff!.id)))[0]!.fromAgentId).toBe(previous.id);
  });

});
