import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { formalQaCheckouts, formalQaPolicies, formalQaPreparations, projectWorkspaces } from "@paperclipai/db";
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
        eq(formalQaPreparations.requestKey, input.idempotencyKey),
      )).orderBy(desc(formalQaPreparations.generation)).limit(1);
      if (existing && existing.status !== "expired") {
        if (existing.projectId !== input.projectId || existing.projectWorkspaceId !== input.projectWorkspaceId ||
          existing.prNumber !== input.prNumber) {
          throw conflict("Formal-QA request idempotency key is already bound to different request data", { code: "formal_qa_preparation_idempotency_conflict" });
        }
        return { preparation: existing, replayed: true };
      }
      const generation = existing ? existing.generation + 1 : 1;
      const idempotencyKey = generation === 1
        ? input.idempotencyKey
        : `${input.idempotencyKey.slice(0, 150)}:g:${generation}:${createHash("sha256").update(`${input.idempotencyKey}:${generation}`).digest("hex").slice(0, 16)}`;
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
        idempotencyKey,
        requestKey: input.idempotencyKey,
        generation,
        predecessorPreparationId: existing?.id ?? null,
        requestSha256: digest,
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
        status: "prepared",
      }).returning();
      return { preparation: preparation!, replayed: false };
    }),
    /**
     * Bounded lifecycle convergence for authorities whose fixed expiry passed.
     * This never refreshes or rewrites authority. It only marks an inert or
     * issued envelope terminal and closes a checkout that was interrupted
     * before verification. Review/run convergence is owned by the review
     * reconciler because it must atomically project onto scheduler rows.
     */
    expireStale: async (input: { companyId?: string; limit?: number } = {}) => db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('formal_qa_preparation_expiry', 0))`);
      const now = new Date();
      const candidates = await tx.select({ id: formalQaPreparations.id })
        .from(formalQaPreparations)
        .where(and(
          inArray(formalQaPreparations.status, ["prepared", "issuing", "issued"]),
          lte(formalQaPreparations.expiresAt, now),
          input.companyId ? eq(formalQaPreparations.companyId, input.companyId) : undefined,
        ))
        .orderBy(asc(formalQaPreparations.expiresAt), asc(formalQaPreparations.createdAt))
        .limit(Math.max(1, Math.min(input.limit ?? 25, 100)));
      let expired = 0;
      let checkoutsExpired = 0;
      for (const candidate of candidates) {
        const [terminal] = await tx.update(formalQaPreparations).set({
          status: "expired",
          updatedAt: new Date(),
        }).where(and(
          eq(formalQaPreparations.id, candidate.id),
          inArray(formalQaPreparations.status, ["prepared", "issuing", "issued"]),
          lte(formalQaPreparations.expiresAt, now),
        )).returning({ id: formalQaPreparations.id });
        if (!terminal) continue;
        expired += 1;
        const terminalCheckouts = await tx.update(formalQaCheckouts).set({ status: "expired" })
          .where(and(
            eq(formalQaCheckouts.preparationId, terminal.id),
            eq(formalQaCheckouts.status, "creating"),
          )).returning({ id: formalQaCheckouts.id });
        checkoutsExpired += terminalCheckouts.length;
      }
      return { scanned: candidates.length, expired, checkoutsExpired };
    }),
  };
}
