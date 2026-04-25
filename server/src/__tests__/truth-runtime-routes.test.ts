import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  truthAtoms,
  truthBriefs,
  truthDocumentChunks,
  truthDocuments,
  truthDossiers,
  truthPromotionRequests,
  truthRunAudits,
  truthRuns,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { truthRuntimeRoutes } from "../routes/truth-runtime.js";
import {
  TRUTH_CHUNK_NAMESPACE,
  canonicalJson,
  sha256Hex,
  truthRuntimeService,
  uuidV5FromName,
} from "../services/truth-runtime.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres truth runtime route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("truth runtime routes", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof truthRuntimeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let actor: Express.Request["actor"];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-truth-runtime-routes-");
    db = createDb(tempDb.connectionString);
    service = truthRuntimeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(truthPromotionRequests);
    await db.delete(truthDossiers);
    await db.delete(truthBriefs);
    await db.delete(truthRunAudits);
    await db.delete(truthAtoms);
    await db.delete(truthRuns);
    await db.delete(truthDocumentChunks);
    await db.delete(truthDocuments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", truthRuntimeRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function allowLocalBoard() {
    actor = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
    };
  }

  async function seedCompany(name = "Truth Co") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedDocument(companyId: string, companySlug = `company-${companyId.slice(0, 8)}`) {
    return service.createDocument(companyId, {
      companySlug,
      title: "Transcript",
      sourceType: "transcript",
      sourceUri: `file://${randomUUID()}.txt`,
      sourceSha256: sha256Hex(`document-${randomUUID()}`),
    });
  }

  async function seedRun(companyId: string) {
    const document = await seedDocument(companyId);
    const run = await service.createRun(companyId, {
      companySlug: document.companySlug,
      truthDocumentId: document.id,
      status: "accepted",
      title: "Extraction",
      promptVersion: "truth-prompt-v1",
    });
    return { document, run };
  }

  async function seedAtom(companyId: string, truthRunId: string, truthDocumentId: string) {
    return service.createAtom(companyId, {
      truthRunId,
      truthDocumentId,
      atomIndex: 0,
      ledgerSection: "truth",
      atomType: "decision",
      atomText: `Launch ${randomUUID()}`,
      durabilityScore: 5,
      confidenceScore: "0.90",
      evidenceMode: "quoted",
      evidenceQuote: "We will launch next week.",
      status: "accepted",
    });
  }

  async function seedAudit(companyId: string, truthRunId: string) {
    return service.createAudit(companyId, {
      truthRunId,
      auditType: "integrity",
      status: "succeeded",
      promptVersion: "audit-prompt-v1",
      templateVersion: "audit-template-v1",
      findingCount: 0,
      summary: "No issues.",
    });
  }

  function canonicalInput(atomIds: string[], auditIds: string[]) {
    return {
      atomIds,
      auditIds,
      promptInputs: { audience: "board" },
      templateVariables: { format: "brief" },
    };
  }

  async function seedBrief(companyId: string, options: { status?: "draft" | "accepted"; content?: string | null } = {}) {
    const { document, run } = await seedRun(companyId);
    const atom = await seedAtom(companyId, run.id, document.id);
    const audit = await seedAudit(companyId, run.id);
    const input = canonicalInput([atom.id], [audit.id]);
    return service.createBrief(companyId, {
      truthRunId: run.id,
      title: "Board brief",
      status: options.status ?? "accepted",
      briefKind: "board",
      contentMarkdown: options.content ?? "Brief content",
      canonicalInput: input,
      promptVersion: "brief-prompt-v1",
      templateVersion: "brief-template-v1",
      inputHash: sha256Hex(canonicalJson(input)),
      payloadHash: sha256Hex("brief payload"),
    });
  }

  async function seedDossier(companyId: string, status: "draft" | "ready" | "published" = "ready") {
    const brief = await seedBrief(companyId);
    const dossier = await service.createDossier(companyId, {
      truthRunId: brief.truthRunId,
      briefId: brief.id,
      title: "Board dossier",
      status,
      htmlContent: "<article>Board dossier</article>",
      promptVersion: "dossier-prompt-v1",
      templateVersion: "dossier-template-v1",
    });
    return { brief, dossier };
  }

  it("requires company access before creating truth documents", async () => {
    const companyId = await seedCompany();
    actor = {
      type: "board",
      userId: "outsider",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    };

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/truth/documents`)
      .send({
        companySlug: "truth-co",
        title: "Transcript",
        sourceType: "transcript",
        sourceSha256: sha256Hex("document"),
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("User does not have access to this company");
  });

  it("creates documents with separate ingest, embedding, and exclusion statuses", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/truth/documents`)
      .send({
        companySlug: "truth-co",
        title: "Transcript",
        sourceType: "transcript",
        sourceSha256: sha256Hex("document"),
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      ingestStatus: "pending",
      embeddingStatus: "not_required",
      exclusionStatus: "included",
    });
  });

  it("creates chunks with stable UUIDv5 ids", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const document = await seedDocument(companyId);
    const deterministicKey = "truth-co:transcript:chunk-1";

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/truth/chunks`)
      .send({
        id: randomUUID(),
        truthDocumentId: document.id,
        sourceChunkKey: "chunk-1",
        deterministicKey,
        contentText: "Launch next week.",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(uuidV5FromName(TRUTH_CHUNK_NAMESPACE, `${companyId}:${deterministicKey}`));
  });

  it("rejects invalid brief inputHash values", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const { document, run } = await seedRun(companyId);
    const atom = await seedAtom(companyId, run.id, document.id);
    const audit = await seedAudit(companyId, run.id);
    const input = canonicalInput([atom.id], [audit.id]);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/truth/briefs`)
      .send({
        truthRunId: run.id,
        title: "Mismatched brief",
        briefKind: "board",
        canonicalInput: input,
        promptVersion: "brief-prompt-v1",
        templateVersion: "brief-template-v1",
        inputHash: "not-a-sha",
      });

    expect(res.status).toBe(422);
  });

  it("rejects dossier creation without htmlContent or filePath", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/truth/dossiers`)
      .send({
        truthRunId: brief.truthRunId,
        briefId: brief.id,
        title: "Empty dossier",
        promptVersion: "dossier-prompt-v1",
        templateVersion: "dossier-template-v1",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Invalid truth runtime input");
  });

  it("accepts run-only promotion request targets", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const { run } = await seedRun(companyId);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/truth/promotions`)
      .send({
        companySlug: "truth-co",
        truthRunId: run.id,
        requestedBy: "operator",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      truthRunId: run.id,
      briefId: null,
      dossierId: null,
      status: "pending",
    });
  });

  it("rejects mismatched explicit truthRunId, briefId, and dossierId lineage", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const { dossier } = await seedDossier(companyId);
    const { run: otherRun } = await seedRun(companyId);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/truth/promotions`)
      .send({
        companySlug: "truth-co",
        truthRunId: otherRun.id,
        briefId: dossier.briefId,
        dossierId: dossier.id,
        requestedBy: "operator",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Promotion truthRunId must match dossier lineage");
  });

  it("rejects completing run-only promotion requests", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const { run } = await seedRun(companyId);
    const requestRow = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      truthRunId: run.id,
      requestedBy: "operator",
    });
    await service.approvePromotionRequest(companyId, requestRow.id, "approver");

    const res = await request(createApp()).post(`/api/truth/promotions/${requestRow.id}/complete`).send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("requires a brief or dossier target");
  });

  it("rejects terminal-state promotion lifecycle transitions", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);
    const requestRow = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      briefId: brief.id,
      requestedBy: "operator",
    });
    await service.rejectPromotionRequest(companyId, requestRow.id, "Not ready");

    const res = await request(createApp())
      .post(`/api/truth/promotions/${requestRow.id}/approve`)
      .send({ approvedBy: "approver" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already rejected");
  });

  it("expires promotion lifecycle requests after expiresAt", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);
    const requestRow = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      briefId: brief.id,
      requestedBy: "operator",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await request(createApp())
      .post(`/api/truth/promotions/${requestRow.id}/reject`)
      .send({ rejectionReason: "Too late" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Promotion request expired");
    const expired = await service.getPromotionRequest(companyId, requestRow.id);
    expect(expired.status).toBe("expired");
  });

  it("requires completed dossier promotions to have a ready or published dossier and accepted linked brief", async () => {
    allowLocalBoard();
    const companyId = await seedCompany();
    const { dossier: draftDossier } = await seedDossier(companyId, "draft");
    const draftRequest = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      dossierId: draftDossier.id,
      requestedBy: "operator",
    });
    await service.approvePromotionRequest(companyId, draftRequest.id, "approver");

    const draftRes = await request(createApp()).post(`/api/truth/promotions/${draftRequest.id}/complete`).send({});

    expect(draftRes.status).toBe(422);
    expect(draftRes.body.error).toContain("Dossier must be ready or published");

    const { brief, dossier } = await seedDossier(companyId, "ready");
    await db.update(truthBriefs).set({ status: "draft" }).where(eq(truthBriefs.id, brief.id));
    const unacceptedBriefRequest = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      dossierId: dossier.id,
      requestedBy: "operator",
    });
    await service.approvePromotionRequest(companyId, unacceptedBriefRequest.id, "approver");

    const briefRes = await request(createApp()).post(`/api/truth/promotions/${unacceptedBriefRequest.id}/complete`).send({});

    expect(briefRes.status).toBe(422);
    expect(briefRes.body.error).toContain("Brief must be accepted before promotion");
  });
});
