import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
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
  createTruthAtomSchema,
  createTruthBriefSchema,
  createTruthDocumentChunkSchema,
  createTruthDocumentSchema,
  createTruthDossierSchema,
  createTruthPromotionRequestSchema,
  createTruthRunAuditSchema,
  createTruthRunSchema,
} from "@paperclipai/shared";
import type { z } from "zod";
import { conflict, notFound, unprocessable } from "../errors.js";

export const TRUTH_CHUNK_NAMESPACE = "6ce6ebaa-7154-5b5e-9c39-b96c25df04c3";

type TruthPromotionStatus = "pending" | "approved" | "rejected" | "completed" | "failed" | "expired";
type TruthBriefRow = typeof truthBriefs.$inferSelect;
type TruthPromotionRequestRow = typeof truthPromotionRequests.$inferSelect;

type PromotionPatch = Partial<typeof truthPromotionRequests.$inferInsert>;

function parseUuid(value: string): Uint8Array {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID namespace: ${value}`);
  }
  return Uint8Array.from(hex.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidV5FromName(namespace: string, name: string): string {
  const namespaceBytes = parseUuid(namespace);
  const hash = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") throw new TypeError("BigInt values cannot be encoded as canonical JSON");
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return "null";
      return canonicalize(item);
    }).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined && typeof record[key] !== "function" && typeof record[key] !== "symbol")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid truth runtime input", parsed.error.flatten());
  }
  return parsed.data;
}

function toOptionalDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasContent(brief: Pick<TruthBriefRow, "contentMarkdown" | "contentJson">): boolean {
  return hasText(brief.contentMarkdown) || brief.contentJson != null;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function terminalStatus(status: TruthPromotionStatus): boolean {
  return status === "completed" || status === "rejected" || status === "failed" || status === "expired";
}

function ensureNotTerminal(request: TruthPromotionRequestRow): void {
  if (terminalStatus(request.status as TruthPromotionStatus)) {
    throw conflict(`Promotion request is already ${request.status}`);
  }
}

function ensureBriefPromotable(brief: TruthBriefRow): void {
  if (brief.status !== "accepted") {
    throw unprocessable("Brief must be accepted before promotion");
  }
  if (!hasContent(brief)) {
    throw unprocessable("Brief must have content before promotion");
  }
  if (!hasText(brief.inputHash) || !hasText(brief.payloadHash)) {
    throw unprocessable("Brief must have inputHash and payloadHash before promotion");
  }
}

async function getDocument(db: Db, id: string) {
  return db
    .select()
    .from(truthDocuments)
    .where(eq(truthDocuments.id, id))
    .then((rows) => rows[0] ?? null);
}

async function getRun(db: Db, id: string) {
  return db
    .select()
    .from(truthRuns)
    .where(eq(truthRuns.id, id))
    .then((rows) => rows[0] ?? null);
}

async function getBrief(db: Db, id: string) {
  return db
    .select()
    .from(truthBriefs)
    .where(eq(truthBriefs.id, id))
    .then((rows) => rows[0] ?? null);
}

async function getDossier(db: Db, id: string) {
  return db
    .select()
    .from(truthDossiers)
    .where(eq(truthDossiers.id, id))
    .then((rows) => rows[0] ?? null);
}

async function getPromotionRequestRow(db: Db, companyId: string, id: string) {
  return db
    .select()
    .from(truthPromotionRequests)
    .where(and(eq(truthPromotionRequests.companyId, companyId), eq(truthPromotionRequests.id, id)))
    .then((rows) => rows[0] ?? null);
}

async function assertDocumentForCompany(db: Db, companyId: string, id: string) {
  const document = await getDocument(db, id);
  if (!document) throw notFound("Truth document not found");
  if (document.companyId !== companyId) throw unprocessable("Truth document must belong to same company");
  return document;
}

async function assertRunForCompany(db: Db, companyId: string, id: string) {
  const run = await getRun(db, id);
  if (!run) throw notFound("Truth run not found");
  if (run.companyId !== companyId) throw unprocessable("Truth run must belong to same company");
  return run;
}

async function assertBriefForCompany(db: Db, companyId: string, id: string) {
  const brief = await getBrief(db, id);
  if (!brief) throw notFound("Truth brief not found");
  if (brief.companyId !== companyId) throw unprocessable("Truth brief must belong to same company");
  return brief;
}

async function assertDossierForCompany(db: Db, companyId: string, id: string) {
  const dossier = await getDossier(db, id);
  if (!dossier) throw notFound("Truth dossier not found");
  if (dossier.companyId !== companyId) throw unprocessable("Truth dossier must belong to same company");
  return dossier;
}

async function assertAgentForCompany(db: Db, companyId: string, id: string) {
  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .then((rows) => rows[0] ?? null);
  if (!agent) throw notFound("Agent not found");
  if (agent.companyId !== companyId) throw unprocessable("Agent must belong to same company");
  return agent;
}

async function loadBoundEvidence(
  db: Db,
  companyId: string,
  truthRunId: string,
  atomIds: string[],
  auditIds: string[],
): Promise<void> {
  const uniqueAtomIds = uniqueIds(atomIds);
  const uniqueAuditIds = uniqueIds(auditIds);

  if (uniqueAtomIds.length > 0) {
    const atoms = await db.select().from(truthAtoms).where(inArray(truthAtoms.id, uniqueAtomIds));
    if (atoms.length !== uniqueAtomIds.length) {
      throw unprocessable("Brief references one or more missing atoms");
    }
    for (const atom of atoms) {
      if (atom.companyId !== companyId) throw unprocessable("Brief atoms must belong to same company");
      if (atom.truthRunId !== truthRunId) throw unprocessable("Brief atoms must belong to the same truth run");
      if (atom.status !== "accepted") throw unprocessable("Brief atoms must be accepted");
    }
  }

  if (uniqueAuditIds.length > 0) {
    const audits = await db.select().from(truthRunAudits).where(inArray(truthRunAudits.id, uniqueAuditIds));
    if (audits.length !== uniqueAuditIds.length) {
      throw unprocessable("Brief references one or more missing audits");
    }
    for (const audit of audits) {
      if (audit.companyId !== companyId) throw unprocessable("Brief audits must belong to same company");
      if (audit.truthRunId !== truthRunId) throw unprocessable("Brief audits must belong to the same truth run");
    }
  }
}

async function normalizePromotionTarget(
  db: Db,
  companyId: string,
  input: { truthRunId?: string | null; briefId?: string | null; dossierId?: string | null },
) {
  let truthRunId = input.truthRunId ?? null;
  let briefId = input.briefId ?? null;
  let dossierId = input.dossierId ?? null;

  if (!truthRunId && !briefId && !dossierId) {
    throw unprocessable("At least one promotion target is required");
  }

  if (dossierId) {
    const dossier = await assertDossierForCompany(db, companyId, dossierId);
    if (briefId && briefId !== dossier.briefId) {
      throw unprocessable("Promotion briefId must match dossier lineage");
    }
    if (truthRunId && truthRunId !== dossier.truthRunId) {
      throw unprocessable("Promotion truthRunId must match dossier lineage");
    }
    briefId = dossier.briefId;
    truthRunId = dossier.truthRunId;
  }

  if (briefId) {
    const brief = await assertBriefForCompany(db, companyId, briefId);
    if (truthRunId && truthRunId !== brief.truthRunId) {
      throw unprocessable("Promotion truthRunId must match brief lineage");
    }
    truthRunId = brief.truthRunId;
  }

  if (truthRunId) {
    await assertRunForCompany(db, companyId, truthRunId);
  }

  return { truthRunId, briefId, dossierId };
}

export function truthRuntimeService(db: Db) {
  async function updatePromotionRequestFromStatuses(
    companyId: string,
    id: string,
    allowedStatuses: TruthPromotionStatus[],
    patch: PromotionPatch,
    message: string,
  ) {
    const now = new Date();
    const [updated] = await db
      .update(truthPromotionRequests)
      .set({ ...patch, updatedAt: now })
      .where(
        and(
          eq(truthPromotionRequests.companyId, companyId),
          eq(truthPromotionRequests.id, id),
          inArray(truthPromotionRequests.status, allowedStatuses),
        ),
      )
      .returning();
    if (updated) return updated;
    const existing = await getPromotionRequestRow(db, companyId, id);
    if (!existing) throw notFound("Promotion request not found");
    throw conflict(message);
  }

  async function markExpiredAndThrow(companyId: string, request: TruthPromotionRequestRow) {
    const expired = await updatePromotionRequestFromStatuses(
      companyId,
      request.id,
      ["pending", "approved"],
      { status: "expired" },
      "Promotion request changed before it could expire",
    );
    throw unprocessable("Promotion request expired", { status: expired.status });
  }

  function assertNotExpired(companyId: string, request: TruthPromotionRequestRow) {
    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
      return markExpiredAndThrow(companyId, request);
    }
    return Promise.resolve();
  }

  return {
    createDocument: async (companyId: string, input: unknown) => {
      const data = parseInput(createTruthDocumentSchema, input);
      const [document] = await db
        .insert(truthDocuments)
        .values({ ...data, companyId })
        .returning();
      return document;
    },

    listDocuments: async (companyId: string) => {
      return db
        .select()
        .from(truthDocuments)
        .where(eq(truthDocuments.companyId, companyId))
        .orderBy(desc(truthDocuments.createdAt));
    },

    createDocumentChunk: async (companyId: string, input: unknown) => {
      const data = parseInput(createTruthDocumentChunkSchema, input);
      const document = await assertDocumentForCompany(db, companyId, data.truthDocumentId);
      const id = uuidV5FromName(TRUTH_CHUNK_NAMESPACE, `${companyId}:${data.deterministicKey}`);
      const [chunk] = await db
        .insert(truthDocumentChunks)
        .values({
          ...data,
          id,
          companyId,
          truthDocumentId: document.id,
        })
        .returning();
      return chunk;
    },

    createRun: async (companyId: string, input: unknown) => {
      const data = parseInput(createTruthRunSchema, input);
      await assertDocumentForCompany(db, companyId, data.truthDocumentId);
      const [run] = await db
        .insert(truthRuns)
        .values({
          ...data,
          companyId,
          startedAt: toOptionalDate(data.startedAt),
          completedAt: toOptionalDate(data.completedAt),
          failedAt: toOptionalDate(data.failedAt),
        })
        .returning();
      return run;
    },

    createAtom: async (companyId: string, input: unknown) => {
      const data = parseInput(createTruthAtomSchema, input);
      const run = await assertRunForCompany(db, companyId, data.truthRunId);
      await assertDocumentForCompany(db, companyId, data.truthDocumentId);
      if (run.truthDocumentId !== data.truthDocumentId) {
        throw unprocessable("Truth atom document must match truth run document");
      }
      if (data.truthDocumentChunkId) {
        const chunk = await db
          .select()
          .from(truthDocumentChunks)
          .where(eq(truthDocumentChunks.id, data.truthDocumentChunkId))
          .then((rows) => rows[0] ?? null);
        if (!chunk) throw notFound("Truth document chunk not found");
        if (chunk.companyId !== companyId) throw unprocessable("Truth document chunk must belong to same company");
        if (chunk.truthDocumentId !== data.truthDocumentId) {
          throw unprocessable("Truth atom chunk must belong to the atom document");
        }
      }
      const [atom] = await db
        .insert(truthAtoms)
        .values({ ...data, companyId })
        .returning();
      return atom;
    },

    createAudit: async (companyId: string, input: unknown) => {
      const data = parseInput(createTruthRunAuditSchema, input);
      await assertRunForCompany(db, companyId, data.truthRunId);
      const [audit] = await db
        .insert(truthRunAudits)
        .values({
          ...data,
          companyId,
          startedAt: toOptionalDate(data.startedAt),
          completedAt: toOptionalDate(data.completedAt),
          failedAt: toOptionalDate(data.failedAt),
        })
        .returning();
      return audit;
    },

    createBrief: async (companyId: string, input: unknown) => {
      const data = parseInput(createTruthBriefSchema, input);
      await assertRunForCompany(db, companyId, data.truthRunId);

      const computedHash = sha256Hex(canonicalJson(data.canonicalInput));
      if (data.inputHash !== computedHash) {
        throw unprocessable("Brief inputHash must match canonicalInput");
      }
      await loadBoundEvidence(
        db,
        companyId,
        data.truthRunId,
        data.canonicalInput.atomIds,
        data.canonicalInput.auditIds,
      );
      if (data.status === "accepted") {
        if (!hasText(data.contentMarkdown) && data.contentJson == null) {
          throw unprocessable("Accepted brief must have content");
        }
        if (!hasText(data.payloadHash)) {
          throw unprocessable("Accepted brief must have payloadHash");
        }
      }
      if (data.createdByAgentId) {
        await assertAgentForCompany(db, companyId, data.createdByAgentId);
      }

      const [brief] = await db
        .insert(truthBriefs)
        .values({
          ...data,
          companyId,
          reviewedAt: toOptionalDate(data.reviewedAt),
        })
        .returning();
      return brief;
    },

    createDossier: async (companyId: string, input: unknown) => {
      const data = parseInput(createTruthDossierSchema, input);

      const brief = await assertBriefForCompany(db, companyId, data.briefId);
      if (brief.truthRunId !== data.truthRunId) {
        throw unprocessable("Dossier truthRunId must match linked brief");
      }
      if (data.generatedByAgentId) {
        await assertAgentForCompany(db, companyId, data.generatedByAgentId);
      }
      ensureBriefPromotable(brief);
      const [dossier] = await db
        .insert(truthDossiers)
        .values({
          truthRunId: brief.truthRunId,
          briefId: brief.id,
          companyId,
          title: data.title,
          status: data.status,
          htmlContent: data.htmlContent ?? null,
          filePath: data.filePath ?? null,
          contentSha256: data.contentSha256 ?? null,
          briefInputHash: brief.inputHash,
          briefPayloadHash: brief.payloadHash as string,
          promptVersion: data.promptVersion,
          templateVersion: data.templateVersion,
          generatedAt: toOptionalDate(data.generatedAt) ?? new Date(),
          generatedByAgentId: data.generatedByAgentId ?? null,
          generatedByUserId: data.generatedByUserId ?? null,
          metadata: data.metadata,
        })
        .returning();
      return dossier;
    },

    createPromotionRequest: async (companyId: string, input: unknown) => {
      const data = parseInput(createTruthPromotionRequestSchema, input);
      const target = await normalizePromotionTarget(db, companyId, data);
      const [request] = await db
        .insert(truthPromotionRequests)
        .values({
          ...data,
          ...target,
          companyId,
          status: "pending",
          expiresAt: toOptionalDate(data.expiresAt),
        })
        .returning();
      return request;
    },

    approvePromotionRequest: async (companyId: string, id: string, actorId: string) => {
      if (!hasText(actorId)) throw unprocessable("Approval actor is required");
      const request = await getPromotionRequestRow(db, companyId, id);
      if (!request) throw notFound("Promotion request not found");
      ensureNotTerminal(request);
      await assertNotExpired(companyId, request);
      if (request.status !== "pending") {
        throw conflict("Only pending promotion requests can be approved");
      }
      return updatePromotionRequestFromStatuses(
        companyId,
        id,
        ["pending"],
        { status: "approved", approvedAt: new Date(), approvedBy: actorId },
        "Only pending promotion requests can be approved",
      );
    },

    rejectPromotionRequest: async (companyId: string, id: string, reason: string) => {
      if (!hasText(reason)) throw unprocessable("Rejection reason is required");
      const request = await getPromotionRequestRow(db, companyId, id);
      if (!request) throw notFound("Promotion request not found");
      ensureNotTerminal(request);
      if (request.status !== "pending" && request.status !== "approved") {
        throw conflict("Only pending or approved promotion requests can be rejected");
      }
      return updatePromotionRequestFromStatuses(
        companyId,
        id,
        ["pending", "approved"],
        { status: "rejected", rejectedAt: new Date(), rejectionReason: reason },
        "Only pending or approved promotion requests can be rejected",
      );
    },

    completePromotionRequest: async (companyId: string, id: string) => {
      const request = await getPromotionRequestRow(db, companyId, id);
      if (!request) throw notFound("Promotion request not found");
      ensureNotTerminal(request);
      await assertNotExpired(companyId, request);
      if (request.status !== "approved") {
        throw conflict("Only approved promotion requests can be completed");
      }
      if (!request.briefId && !request.dossierId) {
        throw unprocessable("Runtime artifact promotion completion requires a brief or dossier target");
      }

      if (request.dossierId) {
        const dossier = await assertDossierForCompany(db, companyId, request.dossierId);
        if (dossier.status !== "ready" && dossier.status !== "published") {
          throw unprocessable("Dossier must be ready or published before promotion");
        }
        const brief = await assertBriefForCompany(db, companyId, dossier.briefId);
        ensureBriefPromotable(brief);
      } else if (request.briefId) {
        const brief = await assertBriefForCompany(db, companyId, request.briefId);
        ensureBriefPromotable(brief);
      }

      return updatePromotionRequestFromStatuses(
        companyId,
        id,
        ["approved"],
        { status: "completed", completedAt: new Date() },
        "Only approved promotion requests can be completed",
      );
    },

    failPromotionRequest: async (companyId: string, id: string, reason: string) => {
      if (!hasText(reason)) throw unprocessable("Failure reason is required");
      const request = await getPromotionRequestRow(db, companyId, id);
      if (!request) throw notFound("Promotion request not found");
      ensureNotTerminal(request);
      if (request.status !== "pending" && request.status !== "approved") {
        throw conflict("Only pending or approved promotion requests can fail");
      }
      return updatePromotionRequestFromStatuses(
        companyId,
        id,
        ["pending", "approved"],
        { status: "failed", failedAt: new Date(), failureReason: reason },
        "Only pending or approved promotion requests can fail",
      );
    },

    expirePromotionRequest: async (companyId: string, id: string) => {
      const request = await getPromotionRequestRow(db, companyId, id);
      if (!request) throw notFound("Promotion request not found");
      ensureNotTerminal(request);
      if (request.status !== "pending" && request.status !== "approved") {
        throw conflict("Only pending or approved promotion requests can expire");
      }
      return updatePromotionRequestFromStatuses(
        companyId,
        id,
        ["pending", "approved"],
        { status: "expired" },
        "Only pending or approved promotion requests can expire",
      );
    },

    getPromotionRequest: async (companyId: string, id: string) => {
      const request = await getPromotionRequestRow(db, companyId, id);
      if (!request) throw notFound("Promotion request not found");
      return request;
    },
  };
}
