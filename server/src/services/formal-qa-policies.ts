import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, formalQaPolicies, projectWorkspaces } from "@paperclipai/db";
import type { UpsertFormalQaPolicy } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

function canonicalRepository(value: string): string | null {
  const trimmed = value.trim();
  if (REPOSITORY_RE.test(trimmed)) return trimmed.toLowerCase();
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return REPOSITORY_RE.test(path) ? path.toLowerCase() : null;
  } catch { return null; }
}

function samePolicy(existing: typeof formalQaPolicies.$inferSelect, input: UpsertFormalQaPolicy, repository: string) {
  return existing.projectWorkspaceId === input.projectWorkspaceId &&
    existing.reviewerAgentId === input.reviewerAgentId &&
    existing.repository === repository &&
    existing.requiredWorkflowId === input.requiredWorkflowId &&
    existing.requiredCheckName === input.requiredCheckName &&
    existing.requiredCheckAppId === input.requiredCheckAppId && existing.enabled === input.enabled;
}

/** Only the instance-admin policy route calls this service. */
export function formalQaPolicyService(db: Db) {
  return {
    getForProject: async (companyId: string, projectId: string) => {
      const [row] = await db.select().from(formalQaPolicies).where(and(
        eq(formalQaPolicies.companyId, companyId), eq(formalQaPolicies.projectId, projectId),
      )).limit(1);
      return row ?? null;
    },
    upsert: async (input: UpsertFormalQaPolicy & { companyId: string; projectId: string; actorUserId: string }) => db.transaction(async (tx) => {
      const repository = canonicalRepository(input.repository);
      if (!repository) throw conflict("Formal-QA policy repository must be a canonical GitHub repository", { code: "formal_qa_policy_invalid" });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_policy:${input.companyId}:${input.projectWorkspaceId}`}, 0))`);
      const [workspace] = await tx.select({ repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces).where(and(
        eq(projectWorkspaces.id, input.projectWorkspaceId), eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId),
      )).limit(1);
      if (!workspace || canonicalRepository(workspace.repoUrl ?? "") !== repository) throw notFound("Project workspace does not match the Formal-QA repository");
      const [reviewer] = await tx.select({ id: agents.id, adapterType: agents.adapterType }).from(agents).where(and(
        eq(agents.id, input.reviewerAgentId), eq(agents.companyId, input.companyId),
      )).limit(1);
      if (!reviewer) throw notFound("Formal-QA reviewer agent was not found in this company");
      if (reviewer.adapterType !== "codex_local") {
        throw conflict("Formal-QA reviewer agent must use the Codex local adapter", {
          code: "formal_qa_reviewer_adapter_unsupported",
        });
      }
      const [existing] = await tx.select().from(formalQaPolicies).where(eq(formalQaPolicies.projectWorkspaceId, input.projectWorkspaceId)).limit(1);
      if (existing && samePolicy(existing, input, repository)) return { policy: existing, replayed: true };
      if (existing) {
        const [policy] = await tx.update(formalQaPolicies).set({ reviewerAgentId: input.reviewerAgentId, repository, requiredWorkflowId: input.requiredWorkflowId, requiredCheckName: input.requiredCheckName, requiredCheckAppId: input.requiredCheckAppId, enabled: input.enabled, version: existing.version + 1, updatedByUserId: input.actorUserId, updatedAt: new Date() }).where(eq(formalQaPolicies.id, existing.id)).returning();
        return { policy: policy!, replayed: false };
      }
      const [policy] = await tx.insert(formalQaPolicies).values({ companyId: input.companyId, projectId: input.projectId, projectWorkspaceId: input.projectWorkspaceId, reviewerAgentId: input.reviewerAgentId, repository, requiredWorkflowId: input.requiredWorkflowId, requiredCheckName: input.requiredCheckName, requiredCheckAppId: input.requiredCheckAppId, enabled: input.enabled, createdByUserId: input.actorUserId, updatedByUserId: input.actorUserId }).returning();
      return { policy: policy!, replayed: false };
    }),
  };
}
