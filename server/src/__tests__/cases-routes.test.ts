import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  caseAttachments,
  caseDocuments,
  caseEvents,
  caseIssueLinks,
  caseLabels,
  cases,
  companies,
  createDb,
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
import { caseRoutes } from "../routes/cases.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cases route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cases routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

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
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cases-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
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
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", caseRoutes(db, storage));
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
    await http.post(`/api/companies/${company.id}/cases`).send({ caseType: "bug", title: "Bug" }).expect(403);
    await http.get(`/api/cases/${caseRow!.id}`).expect(403);
    await http.patch(`/api/cases/${caseRow!.id}`).send({ status: "in_progress" }).expect(403);
    await http.put(`/api/cases/${caseRow!.id}/documents/body`).send({ body: "Body" }).expect(403);
    await http.post(`/api/cases/${caseRow!.id}/links`).send({ issueId: randomUUID(), role: "work" }).expect(403);
    await http.post(`/api/cases/${caseRow!.id}/attachments`).attach("file", Buffer.from("x"), "x.txt").expect(403);
    await http.get(`/api/cases/${caseRow!.id}/events`).expect(403);
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

  it("rejects cross-company agent access across the cases route surface", async () => {
    await enableCases();
    const ownCompany = await seedCompany("OWN");
    const otherCompany = await seedCompany("OTH");
    const agent = await seedAgent(ownCompany.id);
    const [otherIssue] = await db.insert(issues).values({
      companyId: otherCompany.id,
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
    await http.get(`/api/cases/${caseRow!.id}`).expect(403);
    await http.get(`/api/cases/${caseRow!.identifier}`).expect(403);
    await http.patch(`/api/cases/${caseRow!.id}`).send({ status: "in_progress" }).expect(403);
    await http.put(`/api/cases/${caseRow!.id}/documents/body`).send({ body: "Body" }).expect(403);
    await http
      .post(`/api/cases/${caseRow!.id}/links`)
      .send({ issueId: otherIssue!.id, role: "reference" })
      .expect(403);
    await http
      .post(`/api/cases/${caseRow!.id}/attachments`)
      .attach("file", Buffer.from("artifact"), "artifact.txt")
      .expect(403);
    await http.get(`/api/cases/${caseRow!.id}/events`).expect(403);

    expect(await db.select().from(cases)).toHaveLength(1);
    expect(await db.select().from(caseDocuments)).toHaveLength(0);
    expect(await db.select().from(documents)).toHaveLength(0);
    expect(await db.select().from(caseIssueLinks)).toHaveLength(0);
    expect(await db.select().from(caseAttachments)).toHaveLength(0);
    expect(await db.select().from(assets)).toHaveLength(0);
    expect(await db.select().from(caseEvents)).toHaveLength(1);
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

    const detail = await http.get(`/api/cases/${created.body.identifier}`).expect(200);
    expect(detail.body.labels).toHaveLength(1);
    expect(detail.body.documents).toHaveLength(1);
    expect(detail.body.issueLinks).toHaveLength(1);
    expect(detail.body.attachments).toHaveLength(1);

    const events = await http.get(`/api/cases/${created.body.id}/events`).expect(200);
    expect(events.body.map((event: { kind: string }) => event.kind)).toEqual(
      expect.arrayContaining(["created", "label_added", "document_revised", "issue_linked", "attachment_added"]),
    );
  });
});
