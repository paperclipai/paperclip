import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
import {
  TRUTH_CHUNK_NAMESPACE,
  canonicalJson,
  sha256Hex,
  truthRuntimeService,
  uuidV5FromName,
} from "../services/truth-runtime.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres truth runtime service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function expectUnprocessable(action: Promise<unknown>) {
  return expect(action).rejects.toMatchObject({ status: 422 });
}

function expectConflict(action: Promise<unknown>) {
  return expect(action).rejects.toMatchObject({ status: 409 });
}

describe("truth runtime helpers", () => {
  it("computes deterministic UUIDv5 chunk IDs that are stable for the same deterministic key", () => {
    const first = uuidV5FromName(TRUTH_CHUNK_NAMESPACE, "paperclip:doc:chunk:1");
    const second = uuidV5FromName(TRUTH_CHUNK_NAMESPACE, "paperclip:doc:chunk:1");

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("computes different UUIDv5 chunk IDs for different deterministic keys", () => {
    expect(uuidV5FromName(TRUTH_CHUNK_NAMESPACE, "paperclip:doc:chunk:1")).not.toBe(
      uuidV5FromName(TRUTH_CHUNK_NAMESPACE, "paperclip:doc:chunk:2"),
    );
  });

  it("computes brief canonical input hashes from canonical JSON consistently", () => {
    const left = {
      templateVariables: { tone: "board", limit: 4 },
      auditIds: ["00000000-0000-4000-8000-000000000002"],
      promptInputs: { audience: "operator", nested: { b: 2, a: 1 } },
      atomIds: ["00000000-0000-4000-8000-000000000001"],
    };
    const right = {
      atomIds: ["00000000-0000-4000-8000-000000000001"],
      promptInputs: { nested: { a: 1, b: 2 }, audience: "operator" },
      auditIds: ["00000000-0000-4000-8000-000000000002"],
      templateVariables: { limit: 4, tone: "board" },
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256Hex(canonicalJson(left))).toBe(sha256Hex(canonicalJson(right)));
  });
});

describeEmbeddedPostgres("truth runtime service", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof truthRuntimeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-truth-runtime-service-");
    db = createDb(tempDb.connectionString);
    service = truthRuntimeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(truthPromotionRequests);
    await db.delete(truthDossiers);
    await db.delete(truthBriefs);
    await db.delete(truthRunAudits);
    await db.delete(truthAtoms);
    await db.delete(truthRuns);
    await db.delete(truthDocumentChunks);
    await db.delete(truthDocuments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

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
      promptVersion: "prompt-v1",
    });
    return { document, run };
  }

  async function seedAtom(companyId: string, truthRunId: string, truthDocumentId: string, status = "accepted") {
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
      status: status as "accepted",
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

  async function seedBrief(companyId: string, options: { status?: "draft" | "accepted"; content?: string | null; payloadHash?: string | null } = {}) {
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
      payloadHash: options.payloadHash === undefined ? sha256Hex("payload") : options.payloadHash,
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

  it("rejects creating a brief when canonicalInput omits promptInputs", async () => {
    const companyId = await seedCompany();
    const { document, run } = await seedRun(companyId);
    const atom = await seedAtom(companyId, run.id, document.id);
    const audit = await seedAudit(companyId, run.id);
    const input = { atomIds: [atom.id], auditIds: [audit.id], templateVariables: {} };

    await expectUnprocessable(
      service.createBrief(companyId, {
        truthRunId: run.id,
        title: "Missing prompt inputs",
        briefKind: "board",
        canonicalInput: input as any,
        promptVersion: "brief-prompt-v1",
        templateVersion: "brief-template-v1",
        inputHash: sha256Hex(canonicalJson(input)),
      }),
    );
  });

  it("rejects creating a brief when canonicalInput omits templateVariables", async () => {
    const companyId = await seedCompany();
    const { document, run } = await seedRun(companyId);
    const atom = await seedAtom(companyId, run.id, document.id);
    const audit = await seedAudit(companyId, run.id);
    const input = { atomIds: [atom.id], auditIds: [audit.id], promptInputs: {} };

    await expectUnprocessable(
      service.createBrief(companyId, {
        truthRunId: run.id,
        title: "Missing template variables",
        briefKind: "board",
        canonicalInput: input as any,
        promptVersion: "brief-prompt-v1",
        templateVersion: "brief-template-v1",
        inputHash: sha256Hex(canonicalJson(input)),
      }),
    );
  });

  it("rejects creating a brief when referenced atoms or audits do not exist", async () => {
    const companyId = await seedCompany();
    const { run } = await seedRun(companyId);
    const input = canonicalInput([randomUUID()], [randomUUID()]);

    await expectUnprocessable(
      service.createBrief(companyId, {
        truthRunId: run.id,
        title: "Missing evidence",
        briefKind: "board",
        canonicalInput: input,
        promptVersion: "brief-prompt-v1",
        templateVersion: "brief-template-v1",
        inputHash: sha256Hex(canonicalJson(input)),
      }),
    );
  });

  it("rejects creating a brief when referenced atoms or audits belong to another company", async () => {
    const companyId = await seedCompany("Primary");
    const otherCompanyId = await seedCompany("Other");
    const { run } = await seedRun(companyId);
    const { document: otherDocument, run: otherRun } = await seedRun(otherCompanyId);
    const otherAtom = await seedAtom(otherCompanyId, otherRun.id, otherDocument.id);
    const otherAudit = await seedAudit(otherCompanyId, otherRun.id);
    const input = canonicalInput([otherAtom.id], [otherAudit.id]);

    await expectUnprocessable(
      service.createBrief(companyId, {
        truthRunId: run.id,
        title: "Cross-company evidence",
        briefKind: "board",
        canonicalInput: input,
        promptVersion: "brief-prompt-v1",
        templateVersion: "brief-template-v1",
        inputHash: sha256Hex(canonicalJson(input)),
      }),
    );
  });

  it("rejects creating a brief when referenced atoms or audits belong to a different truth run", async () => {
    const companyId = await seedCompany();
    const { run } = await seedRun(companyId);
    const { document: otherDocument, run: otherRun } = await seedRun(companyId);
    const otherAtom = await seedAtom(companyId, otherRun.id, otherDocument.id);
    const otherAudit = await seedAudit(companyId, otherRun.id);
    const input = canonicalInput([otherAtom.id], [otherAudit.id]);

    await expectUnprocessable(
      service.createBrief(companyId, {
        truthRunId: run.id,
        title: "Cross-run evidence",
        briefKind: "board",
        canonicalInput: input,
        promptVersion: "brief-prompt-v1",
        templateVersion: "brief-template-v1",
        inputHash: sha256Hex(canonicalJson(input)),
      }),
    );
  });

  it("rejects creating a brief when referenced atoms are not accepted", async () => {
    const companyId = await seedCompany();
    const { document, run } = await seedRun(companyId);
    const atom = await seedAtom(companyId, run.id, document.id, "needs_review");
    const audit = await seedAudit(companyId, run.id);
    const input = canonicalInput([atom.id], [audit.id]);

    await expectUnprocessable(
      service.createBrief(companyId, {
        truthRunId: run.id,
        title: "Unaccepted atom",
        briefKind: "board",
        canonicalInput: input,
        promptVersion: "brief-prompt-v1",
        templateVersion: "brief-template-v1",
        inputHash: sha256Hex(canonicalJson(input)),
      }),
    );
  });

  it("creates a brief when canonical input hash matches canonical JSON", async () => {
    const companyId = await seedCompany();
    const { document, run } = await seedRun(companyId);
    const atom = await seedAtom(companyId, run.id, document.id);
    const audit = await seedAudit(companyId, run.id);
    const input = canonicalInput([atom.id], [audit.id]);

    const brief = await service.createBrief(companyId, {
      truthRunId: run.id,
      title: "Valid brief",
      status: "accepted",
      briefKind: "board",
      contentMarkdown: "Brief content",
      canonicalInput: input,
      promptVersion: "brief-prompt-v1",
      templateVersion: "brief-template-v1",
      inputHash: sha256Hex(canonicalJson(input)),
      payloadHash: sha256Hex("brief payload"),
    });

    expect(brief.inputHash).toBe(sha256Hex(canonicalJson(input)));
  });

  it("rejects creating a dossier without htmlContent or filePath", async () => {
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);

    await expectUnprocessable(
      service.createDossier(companyId, {
        truthRunId: brief.truthRunId,
        briefId: brief.id,
        title: "Empty dossier",
        promptVersion: "dossier-prompt-v1",
        templateVersion: "dossier-template-v1",
      }),
    );
  });

  it("rejects creating a dossier when supplied truthRunId does not match linked brief truthRunId", async () => {
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);
    const { run: otherRun } = await seedRun(companyId);

    await expectUnprocessable(
      service.createDossier(companyId, {
        truthRunId: otherRun.id,
        briefId: brief.id,
        title: "Mismatched dossier",
        htmlContent: "<article>Mismatched</article>",
        promptVersion: "dossier-prompt-v1",
        templateVersion: "dossier-template-v1",
      }),
    );
  });

  it("snapshots briefInputHash and briefPayloadHash from the linked brief when creating a dossier", async () => {
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);

    const dossier = await service.createDossier(companyId, {
      truthRunId: brief.truthRunId,
      briefId: brief.id,
      title: "Snapshot dossier",
      htmlContent: "<article>Snapshot</article>",
      briefInputHash: sha256Hex("incorrect-input"),
      briefPayloadHash: sha256Hex("incorrect-payload"),
      promptVersion: "dossier-prompt-v1",
      templateVersion: "dossier-template-v1",
    } as any);

    expect(dossier.briefInputHash).toBe(brief.inputHash);
    expect(dossier.briefPayloadHash).toBe(brief.payloadHash);
  });

  it("rejects creating a promotion request without a target", async () => {
    const companyId = await seedCompany();

    await expectUnprocessable(
      service.createPromotionRequest(companyId, {
        companySlug: "truth-co",
        requestedBy: "operator",
      } as any),
    );
  });

  it("rejects creating a promotion request with mixed targets that do not share one lineage", async () => {
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);
    const { run: otherRun } = await seedRun(companyId);

    await expectUnprocessable(
      service.createPromotionRequest(companyId, {
        companySlug: "truth-co",
        truthRunId: otherRun.id,
        briefId: brief.id,
        requestedBy: "operator",
      }),
    );
  });

  it("treats dossier promotion lineage as authoritative and rejects mismatched explicit briefId or truthRunId", async () => {
    const companyId = await seedCompany();
    const { dossier } = await seedDossier(companyId);
    const otherBrief = await seedBrief(companyId);

    await expectUnprocessable(
      service.createPromotionRequest(companyId, {
        companySlug: "truth-co",
        truthRunId: dossier.truthRunId,
        briefId: otherBrief.id,
        dossierId: dossier.id,
        requestedBy: "operator",
      }),
    );
  });

  it("rejects completing a run-only promotion request", async () => {
    const companyId = await seedCompany();
    const { run } = await seedRun(companyId);
    const request = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      truthRunId: run.id,
      requestedBy: "operator",
    });
    await service.approvePromotionRequest(request.id, "approver");

    await expectUnprocessable(service.completePromotionRequest(request.id));
  });

  it("rejects completing a brief promotion unless the brief is accepted and has content plus hashes", async () => {
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId, { status: "draft", content: "Draft content" });
    const request = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      briefId: brief.id,
      requestedBy: "operator",
    });
    await service.approvePromotionRequest(request.id, "approver");

    await expectUnprocessable(service.completePromotionRequest(request.id));
  });

  it("rejects completing a dossier promotion unless the dossier is ready or published and linked brief is promotable", async () => {
    const companyId = await seedCompany();
    const { dossier } = await seedDossier(companyId, "draft");
    const request = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      dossierId: dossier.id,
      requestedBy: "operator",
    });
    await service.approvePromotionRequest(request.id, "approver");

    await expectUnprocessable(service.completePromotionRequest(request.id));
  });

  it("marks expired promotion requests expired when approval is attempted after expiresAt", async () => {
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);
    const request = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      briefId: brief.id,
      requestedBy: "operator",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expectUnprocessable(service.approvePromotionRequest(request.id, "approver"));
    const expired = await service.getPromotionRequest(request.id);
    expect(expired.status).toBe("expired");
  });

  it("does not allow terminal promotion requests to transition again", async () => {
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);
    const completed = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      briefId: brief.id,
      requestedBy: "operator",
    });
    await service.approvePromotionRequest(completed.id, "approver");
    await service.completePromotionRequest(completed.id);

    await expectConflict(service.approvePromotionRequest(completed.id, "approver-2"));
    await expectConflict(service.rejectPromotionRequest(completed.id, "late reject"));
    await expectConflict(service.completePromotionRequest(completed.id));
    await expectConflict(service.failPromotionRequest(completed.id, "late failure"));
    await expectConflict(service.expirePromotionRequest(completed.id));
  });

  it("stores deterministic document chunk IDs from deterministicKey", async () => {
    const companyId = await seedCompany();
    const document = await seedDocument(companyId);
    const chunk = await service.createDocumentChunk(companyId, {
      truthDocumentId: document.id,
      sourceChunkKey: "source#1",
      deterministicKey: "truth-co:transcript:source#1",
      chunkIndex: 0,
      contentText: "Launch next week.",
    });

    expect(chunk.id).toBe(uuidV5FromName(TRUTH_CHUNK_NAMESPACE, "truth-co:transcript:source#1"));
  });

  it("lists only documents for the requested company", async () => {
    const companyId = await seedCompany("Primary");
    const otherCompanyId = await seedCompany("Other");
    const document = await seedDocument(companyId);
    await seedDocument(otherCompanyId);

    await expect(service.listDocuments(companyId)).resolves.toMatchObject([{ id: document.id }]);
  });

  it("normalizes dossier promotion targets to the dossier lineage", async () => {
    const companyId = await seedCompany();
    const { brief, dossier } = await seedDossier(companyId);

    const request = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      dossierId: dossier.id,
      requestedBy: "operator",
    });

    expect(request.truthRunId).toBe(brief.truthRunId);
    expect(request.briefId).toBe(brief.id);
    expect(request.dossierId).toBe(dossier.id);
  });

  it("persists accepted brief promotions through completion", async () => {
    const companyId = await seedCompany();
    const brief = await seedBrief(companyId);
    const request = await service.createPromotionRequest(companyId, {
      companySlug: "truth-co",
      briefId: brief.id,
      requestedBy: "operator",
    });
    await service.approvePromotionRequest(request.id, "approver");

    const completed = await service.completePromotionRequest(request.id);

    expect(completed.status).toBe("completed");
    const [row] = await db.select().from(truthPromotionRequests).where(eq(truthPromotionRequests.id, request.id));
    expect(row?.completedAt).toBeInstanceOf(Date);
  });
});
