import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { formalQaPolicies, formalQaPreparations, projectWorkspaces } from "@paperclipai/db";
import type { CreateFormalQaPreparation } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

type PreparationRow = typeof formalQaPreparations.$inferSelect;
const ZERO_SHA = "0".repeat(40);
const ZERO_SHA256 = "0".repeat(64);
const REQUEST_TTL_MS = 6 * 60 * 60 * 1000;

function requestSha256(input: CreateFormalQaPreparation & { policyId: string; policyVersion: number }): string {
  return createHash("sha256").update(JSON.stringify({
    projectId: input.projectId,
    projectWorkspaceId: input.projectWorkspaceId,
    prNumber: input.prNumber,
    idempotencyKey: input.idempotencyKey,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
  })).digest("hex");
}

export type FormalQaPreparationService = ReturnType<typeof formalQaPreparationService>;

/**
 * Requests are durable but inert. They carry no caller-owned authority: the
 * issuer derives head, checks, expiry, evidence, and repository from the
 * enabled server policy and live GitHub reads.
 */
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
    create: async (input: CreateFormalQaPreparation & { companyId: string; issuedByUserId: string }) => db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_request:${input.companyId}:${input.idempotencyKey}`}, 0))`);
      const [policy] = await tx.select().from(formalQaPolicies).where(and(
        eq(formalQaPolicies.companyId, input.companyId),
        eq(formalQaPolicies.projectId, input.projectId),
        eq(formalQaPolicies.projectWorkspaceId, input.projectWorkspaceId),
      )).limit(1);
      if (!policy || !policy.enabled) throw conflict("No enabled Formal-QA policy is configured for this project workspace", { code: "formal_qa_policy_unavailable" });
      const [workspace] = await tx.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces).where(and(
        eq(projectWorkspaces.id, input.projectWorkspaceId),
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
      )).limit(1);
      if (!workspace || !workspace.repoUrl) throw notFound("Project workspace not found for this company and project");
      const digest = requestSha256({ ...input, policyId: policy.id, policyVersion: policy.version });
      const [existing] = await tx.select().from(formalQaPreparations).where(and(
        eq(formalQaPreparations.companyId, input.companyId),
        eq(formalQaPreparations.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (existing) {
        if (existing.requestSha256 !== digest) throw conflict("Formal-QA request idempotency key is already bound to different request data", { code: "formal_qa_preparation_idempotency_conflict" });
        return { preparation: existing, replayed: true };
      }
      const [preparation] = await tx.insert(formalQaPreparations).values({
        companyId: input.companyId,
        projectId: input.projectId,
        projectWorkspaceId: input.projectWorkspaceId,
        repository: policy.repository.toLowerCase(),
        prNumber: input.prNumber,
        headSha: ZERO_SHA,
        baseRef: "pending",
        baseSha: ZERO_SHA,
        treeSha: ZERO_SHA,
        evidenceSha256: ZERO_SHA256,
        issuerReceiptSha256: ZERO_SHA256,
        issuerOperationId: `request:${policy.id}:v${policy.version}`,
        issuedByUserId: input.issuedByUserId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: digest,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
        status: "prepared",
      }).returning();
      return { preparation: preparation!, replayed: false };
    }),
  };
}
