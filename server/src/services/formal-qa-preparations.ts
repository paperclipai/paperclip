import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { formalQaPreparations, projectWorkspaces } from "@paperclipai/db";
import type { CreateFormalQaPreparation } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

type PreparationRow = typeof formalQaPreparations.$inferSelect;

function requestSha256(input: CreateFormalQaPreparation): string {
  // All input is validated and scalar. Keeping the exact key order here makes
  // idempotency comparison stable without accepting a caller-provided digest.
  return createHash("sha256").update(JSON.stringify({
    projectId: input.projectId,
    projectWorkspaceId: input.projectWorkspaceId,
    repository: input.repository,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    treeSha: input.treeSha,
    evidenceSha256: input.evidenceSha256,
    issuerReceiptSha256: input.issuerReceiptSha256,
    issuerOperationId: input.issuerOperationId,
    idempotencyKey: input.idempotencyKey,
    expiresAt: input.expiresAt.toISOString(),
  })).digest("hex");
}

export type FormalQaPreparationService = ReturnType<typeof formalQaPreparationService>;

export function formalQaPreparationService(db: Db) {
  async function getById(id: string): Promise<PreparationRow | null> {
    const [row] = await db.select().from(formalQaPreparations).where(eq(formalQaPreparations.id, id)).limit(1);
    return row ?? null;
  }

  return {
    getById,

    list: async (companyId: string, projectId?: string | null): Promise<PreparationRow[]> => {
      const filters = [eq(formalQaPreparations.companyId, companyId)];
      if (projectId) filters.push(eq(formalQaPreparations.projectId, projectId));
      return db.select().from(formalQaPreparations).where(and(...filters)).orderBy(formalQaPreparations.createdAt);
    },

    create: async (input: CreateFormalQaPreparation & { companyId: string; issuedByUserId: string }) => {
      const digest = requestSha256(input);
      return db.transaction(async (tx) => {
        // Serialize idempotency-key creation before the workspace lookup and
        // insert. This makes a replay deterministic instead of relying on a
        // unique-index exception after a partial request path.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_preparation:${input.companyId}:${input.idempotencyKey}`}, 0))`);

        const [existing] = await tx
          .select()
          .from(formalQaPreparations)
          .where(and(
            eq(formalQaPreparations.companyId, input.companyId),
            eq(formalQaPreparations.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        if (existing) {
          if (existing.requestSha256 !== digest) {
            throw conflict("Formal-QA preparation idempotency key is already bound to different immutable request data", {
              code: "formal_qa_preparation_idempotency_conflict",
            });
          }
          return { preparation: existing, replayed: true };
        }

        const [workspace] = await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(and(
            eq(projectWorkspaces.id, input.projectWorkspaceId),
            eq(projectWorkspaces.companyId, input.companyId),
            eq(projectWorkspaces.projectId, input.projectId),
          ))
          .limit(1);
        if (!workspace) {
          throw notFound("Project workspace not found for this company and project");
        }

        const [preparation] = await tx.insert(formalQaPreparations).values({
          companyId: input.companyId,
          projectId: input.projectId,
          projectWorkspaceId: input.projectWorkspaceId,
          repository: input.repository,
          prNumber: input.prNumber,
          headSha: input.headSha,
          baseRef: input.baseRef,
          baseSha: input.baseSha,
          treeSha: input.treeSha,
          evidenceSha256: input.evidenceSha256,
          issuerReceiptSha256: input.issuerReceiptSha256,
          issuerOperationId: input.issuerOperationId,
          issuedByUserId: input.issuedByUserId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: digest,
          expiresAt: input.expiresAt,
        }).returning();
        return { preparation: preparation!, replayed: false };
      });
    },
  };
}
