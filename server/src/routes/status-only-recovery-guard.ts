import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export const STATUS_ONLY_RECOVERY_ISSUE_EXPANSION_ERROR =
  "Cheap status-only recovery runs cannot create executable issues or accepted-plan decompositions";

export function isStatusOnlyCheapRecoveryContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.modelProfile === "cheap" &&
    context.recoveryIntent === "status_only" &&
    context.allowDeliverableWork === false &&
    context.allowDocumentUpdates === false &&
    context.resumeRequiresNormalModel === true;
}

export async function loadActorRunContext(db: Db, req: Request, companyId: string) {
  if (req.actor.type !== "agent") return null;
  const runId = req.actor.runId?.trim();
  if (!runId) return null;
  const run = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return null;
  return run;
}

export async function assertStatusOnlyRecoveryRunAllowsDeliverableMutation(
  db: Db,
  req: Request,
  res: Response,
  input: {
    companyId: string;
    error: string;
    issueId?: string | null;
    surface?: string;
  },
) {
  const run = await loadActorRunContext(db, req, input.companyId);
  if (!run) return true;
  if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

  res.status(403).json({
    error: input.error,
    details: {
      companyId: input.companyId,
      issueId: input.issueId ?? null,
      runId: run.id,
      modelProfile: "cheap",
      recoveryIntent: "status_only",
      resumeRequiresNormalModel: true,
      ...(input.surface ? { surface: input.surface } : {}),
    },
  });
  return false;
}

export async function assertStatusOnlyRecoveryRunAllowsIssueExpansion(
  db: Db,
  req: Request,
  res: Response,
  input: {
    companyId: string;
    issueId?: string | null;
    surface: "issues.create" | "issues.children.create" | "issues.accepted_plan_decomposition";
  },
) {
  return assertStatusOnlyRecoveryRunAllowsDeliverableMutation(db, req, res, {
    ...input,
    error: STATUS_ONLY_RECOVERY_ISSUE_EXPANSION_ERROR,
  });
}
