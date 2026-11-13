import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, assets, caseAccessSources, caseAttachments, caseDocuments, caseEvents,
  caseHandoffs, caseIssueLinks, caseLabels, cases, companies, createDb,
  documentAnnotationAnchorSnapshots, documentAnnotationComments, documentAnnotationThreads,
  documentRevisions, documents, heartbeatRuns, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { caseRoutes } from "../routes/cases.js";
import { caseHandoffRoutes } from "../routes/case-handoffs.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { StorageService } from "../storage/types.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("case REST mutation fencing", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const oldJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const board = { type: "board" as const, source: "local_implicit" as const };

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "case-mutation-fence-test-secret";
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-case-mutation-fence-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
  }, 30_000);
  afterAll(async () => {
    await temporary?.cleanup();
    if (oldJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldJwtSecret;
  });

  async function fixture(runtimeMode: "native" | "legacy") {
    const companyId = randomUUID(), agentId = randomUUID(), recipientId = randomUUID(), runId = randomUUID();
    const prefix = `F${companyId.slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Case mutation fence", issuePrefix: prefix });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Case author", role: "ceo", status: "active", adapterType: "process" },
      { id: recipientId, companyId, name: "Successor", role: "engineer", reportsTo: agentId, status: "active", adapterType: "process" },
    ]);
    const [source] = await db.insert(issues).values({ companyId, title: "Workflow source", assigneeAgentId: agentId, status: "in_progress" }).returning();
    const [reference] = await db.insert(issues).values({ companyId, title: "Unchanged reference task", status: "todo" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId: source!.id,
      runtimeMode, nativeIssueId: runtimeMode === "native" ? source!.id : null, status: "running",
      contextSnapshot: { issueId: source!.id, executionPolicy: {} } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, source!.id));

    const objects = new Map<string, Buffer>();
    const storage: StorageService = {
      provider: "local_disk",
      async putFile(input) {
        if (!Buffer.isBuffer(input.body)) throw new Error("Fixture expects a buffered upload");
        const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}`;
        objects.set(objectKey, input.body);
        return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: input.body.length,
          originalFilename: input.originalFilename, sha256: createHash("sha256").update(input.body).digest("hex") };
      },
      async getObject() { throw new Error("Fixture does not download assets"); },
      async headObject() { return { exists: false }; },
      deleteObject: vi.fn(async (_companyId: string, key: string) => { objects.delete(key); }),
    };
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", caseRoutes(db, storage));
    app.use("/api", caseHandoffRoutes(db));
    app.use(errorHandler);
    const boardApp = express();
    boardApp.use(express.json());
    boardApp.use((req, _res, next) => { req.actor = board; next(); });
    boardApp.use("/api", caseRoutes(db, storage));
    boardApp.use(errorHandler);
    const boardHttp = request(boardApp);
    const target = await boardHttp.post(`/api/companies/${companyId}/cases`)
      .send({ caseType: "fence", key: "target", title: "Keep these findings", fields: { original: true } }).expect(201);
    const first = await boardHttp.put(`/api/cases/${target.body.id}/documents/body`).send({ body: "Alpha beta gamma" }).expect(200);
    const second = await boardHttp.put(`/api/cases/${target.body.id}/documents/body`)
      .send({ body: "Alpha beta gamma delta", baseRevisionId: first.body.revision.id }).expect(200);
    const annotationInput = {
      baseRevisionId: second.body.revision.id, baseRevisionNumber: second.body.revision.revisionNumber,
      selector: { quote: { exact: "beta", prefix: "Alpha ", suffix: " gamma" },
        position: { normalizedStart: 6, normalizedEnd: 10, markdownStart: 6, markdownEnd: 10 } },
      body: "Existing annotation",
    };
    const annotation = await boardHttp.post(`/api/cases/${target.body.id}/documents/body/annotations`).send(annotationInput).expect(201);
    const [workflow] = await db.insert(cases).values({ companyId, caseNumber: 2, identifier: `${prefix}-C2`,
      caseType: "workflow", key: "source", title: "Active workflow", workIssueId: source!.id }).returning();
    const http = request(app);
    const authorization = `Bearer ${createLocalAgentJwt(agentId, companyId, "process", runId)}`;
    const acceptHandoff = async () => {
      const response = await http.post(`/api/companies/${companyId}/case-handoffs`).set("Authorization", authorization)
        .send({ idempotencyKey: randomUUID(), case: { id: workflow!.id }, toAgentId: recipientId,
          phase: "verification", instructions: "Verify the saved findings.", expectedHandoffVersion: 0,
          expectedIssueStatusVersion: source!.statusVersion }).expect(202);
      expect(response.body).toMatchObject({ state: "awaiting_release", taskId: source!.id, callerMustYield: true });
    };
    const snapshot = async () => {
      const tables = [cases, documents, documentRevisions, caseDocuments, caseAttachments, assets, caseEvents,
        caseAccessSources, caseIssueLinks, caseLabels, documentAnnotationThreads, documentAnnotationComments,
        documentAnnotationAnchorSnapshots, caseHandoffs, activityLog] as const;
      return Promise.all(tables.map(async table => (await db.select().from(table).where(eq(table.companyId, companyId)))
        .sort((left, right) => left.id.localeCompare(right.id))));
    };
    return { companyId, runId, http, authorization, target: target.body, first: first.body, second: second.body,
      annotation: annotation.body, annotationInput, reference: reference!, storage, objects, snapshot, acceptHandoff };
  }

  it.each(["native", "legacy"] as const)("rejects all %s case writes after an accepted handoff while reads remain available", async runtimeMode => {
    const f = await fixture(runtimeMode);
    await f.acceptHandoff();
    const before = await f.snapshot();
    const path = `/api/cases/${f.target.id}`;
    const http = f.http;
    const writes = [
      () => http.post(`/api/companies/${f.companyId}/cases`).set("Authorization", f.authorization).send({ caseType: "fence", key: "new", title: "Late creation" }),
      () => http.post(`/api/companies/${f.companyId}/cases`).set("Authorization", f.authorization).send({ caseType: "fence", key: "target", title: "Late upsert" }),
      () => http.patch(path).set("Authorization", f.authorization).send({ fields: { late: true } }),
      () => http.put(`${path}/documents/new`).set("Authorization", f.authorization).send({ body: "Late document" }),
      () => http.post(`${path}/documents/body/lock`).set("Authorization", f.authorization),
      () => http.post(`${path}/documents/body/unlock`).set("Authorization", f.authorization),
      () => http.post(`${path}/documents/body/revisions/${f.first.revision.id}/restore`).set("Authorization", f.authorization),
      () => http.delete(`${path}/documents/body`).set("Authorization", f.authorization),
      () => http.post(`${path}/links`).set("Authorization", f.authorization).send({ issueId: f.reference.id, role: "work" }),
      () => http.post(`${path}/documents/body/annotations`).set("Authorization", f.authorization).send(f.annotationInput),
      () => http.post(`${path}/documents/body/annotations/${f.annotation.id}/comments`).set("Authorization", f.authorization).send({ body: "Late reply" }),
      () => http.patch(`${path}/documents/body/annotations/${f.annotation.id}`).set("Authorization", f.authorization).send({ status: "resolved" }),
      () => http.post(`${path}/attachments`).set("Authorization", f.authorization).attach("file", Buffer.from("Late file"), "late.txt"),
    ];
    for (const write of writes) {
      const response = await write().expect(403);
      expect(response.body.code).toBe("case_handoff_run_yielded");
    }
    for (const route of [path, `${path}/documents/body`, `${path}/documents/body/annotations?includeComments=true`, `${path}/events`]) {
      await http.get(route).set("Authorization", f.authorization).expect(200);
    }
    expect(await f.snapshot()).toEqual(before);
    expect(f.objects.size).toBe(0);
    expect(f.storage.deleteObject).toHaveBeenCalledOnce();
  });

  it.each(["stop", "handoff"] as const)("rechecks authority after an upload races %s and compensates its object", async action => {
    const f = await fixture("native");
    const originalPut = f.storage.putFile;
    let stored = false;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.storage.putFile = async input => {
      const result = await originalPut(input);
      stored = true;
      await barrier;
      return result;
    };
    const before = await f.snapshot();
    const pending = f.http.post(`/api/cases/${f.target.id}/attachments`).set("Authorization", f.authorization)
      .attach("file", Buffer.from("Late upload"), "late.txt").then(response => response);
    let expected: Awaited<ReturnType<typeof f.snapshot>>;
    try {
      await vi.waitFor(() => expect(stored).toBe(true), { timeout: 5_000 });
      // Copying bytes is outside the transaction; preflight must not persist
      // a source boundary before the eventual authorized attachment commit.
      expect(await f.snapshot()).toEqual(before);
      if (action === "stop") {
        await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } })
          .where(eq(heartbeatRuns.id, f.runId));
      } else await f.acceptHandoff();
      expected = await f.snapshot();
    } finally { release(); }
    const response = await pending;
    expect(response.status).toBe(403);
    expect(response.body.code).toBe(action === "stop" ? "agent_run_cancelled" : "case_handoff_run_yielded");
    expect(await f.snapshot()).toEqual(expected!);
    expect(f.objects.size).toBe(0);
    expect(f.storage.deleteObject).toHaveBeenCalledOnce();
  });
});
