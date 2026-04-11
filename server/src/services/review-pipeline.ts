import { eq, and, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  reviewPipelineTemplates,
  reviewRuns,
  reviewChecks,
  approvals,
  issueApprovals,
  issueWorkProducts,
  projectEnvironments,
  companySecrets,
  companySecretVersions,
  issues,
  teamWorkflowStatuses,
} from "@paperclipai/db";
import type { ReviewStepConfig } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { SecretProvider } from "@paperclipai/shared";

function extractPrNumber(prUrl: string): number {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) throw unprocessable(`Cannot extract PR number from URL: ${prUrl}`);
  return parseInt(match[1], 10);
}

export function reviewPipelineService(db: Db) {
  // --- Pipeline Template ---

  async function getTeamPipeline(companyId: string, teamId: string) {
    return db
      .select()
      .from(reviewPipelineTemplates)
      .where(
        and(
          eq(reviewPipelineTemplates.companyId, companyId),
          eq(reviewPipelineTemplates.teamId, teamId),
          eq(reviewPipelineTemplates.isDefault, true),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function upsertTeamPipeline(
    companyId: string,
    teamId: string,
    data: { name?: string; enabled?: boolean; steps?: ReviewStepConfig[] },
  ) {
    const existing = await getTeamPipeline(companyId, teamId);
    const now = new Date();

    if (existing) {
      const updated = await db
        .update(reviewPipelineTemplates)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
          ...(data.steps !== undefined ? { steps: data.steps } : {}),
          updatedAt: now,
        })
        .where(eq(reviewPipelineTemplates.id, existing.id))
        .returning()
        .then((rows) => rows[0]);

      if (data.enabled === true && teamId) {
        await ensureInReviewStatus(companyId, teamId);
      }

      return updated;
    }

    const result = await db
      .insert(reviewPipelineTemplates)
      .values({
        companyId,
        teamId,
        name: data.name ?? "Default Pipeline",
        enabled: data.enabled ?? true,
        steps: data.steps ?? [],
        isDefault: true,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

    // Ensure in_review workflow status exists when pipeline is enabled
    if (result.enabled) {
      await ensureInReviewStatus(companyId, teamId);
    }

    return result;
  }

  /** Add "In Review" status to team workflow if it doesn't exist yet. */
  async function ensureInReviewStatus(_companyId: string, teamId: string) {
    const existing = await db
      .select()
      .from(teamWorkflowStatuses)
      .where(
        and(
          eq(teamWorkflowStatuses.teamId, teamId),
          eq(teamWorkflowStatuses.slug, "in_review"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) return;

    // Find the max position in "started" category to insert after
    const startedStatuses = await db
      .select()
      .from(teamWorkflowStatuses)
      .where(
        and(
          eq(teamWorkflowStatuses.teamId, teamId),
          eq(teamWorkflowStatuses.category, "started"),
        ),
      );

    const maxPosition = startedStatuses.reduce(
      (max, s) => Math.max(max, (s as Record<string, unknown>).position as number ?? 0),
      0,
    );

    await db.insert(teamWorkflowStatuses).values({
      teamId,
      slug: "in_review",
      name: "In Review",
      category: "started",
      position: maxPosition + 1,
    });
  }

  // --- Review Runs ---

  async function createRun(params: {
    companyId: string;
    workProductId: string;
    issueId: string;
    pipelineTemplateId: string;
    steps: ReviewStepConfig[];
    triggeredBy: string;
  }) {
    // Cancel existing running/failed runs for the same workProduct
    const existingRuns = await db
      .select()
      .from(reviewRuns)
      .where(
        and(
          eq(reviewRuns.companyId, params.companyId),
          eq(reviewRuns.workProductId, params.workProductId),
          inArray(reviewRuns.status, ["running", "failed"]),
        ),
      );

    if (existingRuns.length > 0) {
      const ids = existingRuns.map((r) => r.id);
      await db
        .update(reviewRuns)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(inArray(reviewRuns.id, ids));
    }

    // Create new run
    const run = await db
      .insert(reviewRuns)
      .values({
        companyId: params.companyId,
        workProductId: params.workProductId,
        issueId: params.issueId,
        pipelineTemplateId: params.pipelineTemplateId,
        status: "running",
        triggeredBy: params.triggeredBy,
        startedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]);

    // Create review_checks for each step
    const checks = await db
      .insert(reviewChecks)
      .values(
        params.steps.map((step) => ({
          reviewRunId: run.id,
          stepSlug: step.slug,
          stepName: step.name,
          stepType: step.type,
          executor: step.executor,
          status: "pending",
        })),
      )
      .returning();

    await logActivity(db, {
      companyId: params.companyId,
      actorType: "system",
      actorId: params.triggeredBy,
      action: "review_started",
      entityType: "review_run",
      entityId: run.id,
      details: { workProductId: params.workProductId, issueId: params.issueId },
    });

    return { run, checks };
  }

  async function getRunsByIssue(companyId: string, issueId: string) {
    const runs = await db
      .select()
      .from(reviewRuns)
      .where(
        and(eq(reviewRuns.companyId, companyId), eq(reviewRuns.issueId, issueId)),
      )
      .orderBy(reviewRuns.createdAt);

    const runIds = runs.map((r) => r.id);
    if (runIds.length === 0) return [];

    const allChecks = await db
      .select()
      .from(reviewChecks)
      .where(inArray(reviewChecks.reviewRunId, runIds));

    return runs.map((run) => ({
      ...run,
      checks: allChecks.filter((c) => c.reviewRunId === run.id),
    }));
  }

  async function getRunById(runId: string) {
    const run = await db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    if (!run) throw notFound("Review run not found");

    const checks = await db
      .select()
      .from(reviewChecks)
      .where(eq(reviewChecks.reviewRunId, runId));

    return { ...run, checks };
  }

  // --- Check updates ---

  async function updateCheck(
    checkId: string,
    data: {
      status: string;
      summary?: string | null;
      details?: Record<string, unknown> | null;
      checkedByAgentId?: string | null;
      checkedByUserId?: string | null;
    },
  ) {
    const now = new Date();
    const check = await db
      .update(reviewChecks)
      .set({
        status: data.status,
        ...(data.summary !== undefined ? { summary: data.summary } : {}),
        ...(data.details !== undefined ? { details: data.details } : {}),
        ...(data.checkedByAgentId !== undefined
          ? { checkedByAgentId: data.checkedByAgentId }
          : {}),
        ...(data.checkedByUserId !== undefined
          ? { checkedByUserId: data.checkedByUserId }
          : {}),
        checkedAt: now,
      })
      .where(eq(reviewChecks.id, checkId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!check) throw notFound("Review check not found");

    // Check if all checks in the run are done
    const allChecks = await db
      .select()
      .from(reviewChecks)
      .where(eq(reviewChecks.reviewRunId, check.reviewRunId));

    const doneStatuses = new Set(["passed", "failed", "skipped"]);
    const allDone = allChecks.every((c) => doneStatuses.has(c.status));

    if (!allDone) {
      return { check, runCompleted: false };
    }

    // Determine run status
    const anyFailed = allChecks.some((c) => c.status === "failed");
    const runStatus = anyFailed ? "failed" : "passed";

    // Update run
    const run = await db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.id, check.reviewRunId))
      .then((rows) => rows[0]);

    if (!run) throw notFound("Review run not found");

    await db
      .update(reviewRuns)
      .set({ status: runStatus, completedAt: now })
      .where(eq(reviewRuns.id, run.id));

    // Create approval record
    const approval = await db
      .insert(approvals)
      .values({
        companyId: run.companyId,
        type: "pr_review",
        status: "pending",
        payload: { reviewRunId: run.id, workProductId: run.workProductId },
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);

    // Link approval to issue via issue_approvals
    await db.insert(issueApprovals).values({
      companyId: run.companyId,
      issueId: run.issueId,
      approvalId: approval.id,
    });

    await logActivity(db, {
      companyId: run.companyId,
      actorType: "system",
      actorId: "review-pipeline",
      action: runStatus === "passed" ? "review_passed" : "review_failed",
      entityType: "review_run",
      entityId: run.id,
      details: { workProductId: run.workProductId, issueId: run.issueId, runStatus },
    });

    return { check, runCompleted: true, runStatus, approval };
  }

  // --- Approve/Reject ---

  async function findLinkedApproval(runId: string) {
    const allApprovals = await db
      .select()
      .from(approvals)
      .where(eq(approvals.type, "pr_review"));

    const linked = allApprovals.find((a) => {
      const payload = a.payload as Record<string, unknown>;
      return payload.reviewRunId === runId;
    });

    if (!linked) throw notFound("Linked approval not found for review run");
    return linked;
  }

  async function approveRun(runId: string, userId: string) {
    const approval = await findLinkedApproval(runId);
    const now = new Date();
    const updatedApproval = await db
      .update(approvals)
      .set({
        status: "approved",
        decidedByUserId: userId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(approvals.id, approval.id))
      .returning()
      .then((rows) => rows[0]);

    // --- GitHub merge logic ---
    const run = await db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.id, runId))
      .then((rows) => rows[0]);
    if (!run) throw notFound("Review run not found");

    // Get work product (PR) URL
    const workProduct = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, run.workProductId))
      .then((rows) => rows[0] ?? null);

    if (workProduct?.url && workProduct.type === "pull_request") {
      // Get issue to find projectId
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, run.issueId))
        .then((rows) => rows[0] ?? null);

      if (issue?.projectId) {
        // Get project environment config
        const env = await db
          .select()
          .from(projectEnvironments)
          .where(
            and(
              eq(projectEnvironments.companyId, run.companyId),
              eq(projectEnvironments.projectId, issue.projectId),
              eq(projectEnvironments.isDefault, true),
            ),
          )
          .then((rows) => rows[0] ?? null);

        const githubConfig = env?.config?.github;
        if (githubConfig) {
          // Resolve GitHub token from company_secrets
          const secret = await db
            .select()
            .from(companySecrets)
            .where(
              and(
                eq(companySecrets.companyId, run.companyId),
                eq(companySecrets.name, "github_token"),
              ),
            )
            .then((rows) => rows[0] ?? null);

          if (secret) {
            const secretVersion = await db
              .select()
              .from(companySecretVersions)
              .where(
                and(
                  eq(companySecretVersions.secretId, secret.id),
                  eq(companySecretVersions.version, secret.latestVersion),
                ),
              )
              .then((rows) => rows[0] ?? null);

            if (secretVersion) {
              // Decrypt via the provider system
              const provider = getSecretProvider(secret.provider as SecretProvider);
              const token = await provider.resolveVersion({
                material: secretVersion.material as Record<string, unknown>,
                externalRef: secret.externalRef,
              });

              const prNumber = extractPrNumber(workProduct.url);
              const mergeMethod = env.config?.merge?.method ?? "squash";

              const mergeRes = await fetch(
                `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/pulls/${prNumber}/merge`,
                {
                  method: "PUT",
                  headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                  },
                  body: JSON.stringify({ merge_method: mergeMethod }),
                },
              );

              if (!mergeRes.ok) {
                const errBody = (await mergeRes.json().catch(() => ({}))) as Record<string, unknown>;
                throw unprocessable(
                  `GitHub merge failed: ${errBody.message ?? mergeRes.statusText}`,
                );
              }

              // Update work product status to merged
              await db
                .update(issueWorkProducts)
                .set({ status: "merged", updatedAt: now })
                .where(eq(issueWorkProducts.id, workProduct.id));

              // Update issue status to completed-category status
              const issueRow = await db
                .select({ teamId: issues.teamId })
                .from(issues)
                .where(eq(issues.id, run.issueId))
                .then((rows) => rows[0] ?? null);

              let completedSlug = "done";
              if (issueRow?.teamId) {
                const completedStatus = await db
                  .select({ slug: teamWorkflowStatuses.slug })
                  .from(teamWorkflowStatuses)
                  .where(
                    and(
                      eq(teamWorkflowStatuses.teamId, issueRow.teamId),
                      eq(teamWorkflowStatuses.category, "completed"),
                    ),
                  )
                  .limit(1)
                  .then((rows) => rows[0] ?? null);
                if (completedStatus) completedSlug = completedStatus.slug;
              }

              await db
                .update(issues)
                .set({ status: completedSlug, completedAt: now, updatedAt: now })
                .where(eq(issues.id, run.issueId));
            }
          }
        }
      }
    }

    // Activity log
    await logActivity(db, {
      companyId: run.companyId,
      actorType: "user",
      actorId: userId,
      action: "pr_approved",
      entityType: "review_run",
      entityId: runId,
      details: { workProductId: run.workProductId, issueId: run.issueId },
    });

    return updatedApproval;
  }

  async function rejectRun(runId: string, userId: string, decisionNote: string) {
    const approval = await findLinkedApproval(runId);
    const now = new Date();
    const result = await db
      .update(approvals)
      .set({
        status: "rejected",
        decidedByUserId: userId,
        decisionNote: decisionNote,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(approvals.id, approval.id))
      .returning()
      .then((rows) => rows[0]);

    const run = await db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    if (run) {
      // Revert issue status to in_progress (started category)
      const issueRow = await db
        .select({ teamId: issues.teamId })
        .from(issues)
        .where(eq(issues.id, run.issueId))
        .then((rows) => rows[0] ?? null);

      let startedSlug = "in_progress";
      if (issueRow?.teamId) {
        const startedStatus = await db
          .select({ slug: teamWorkflowStatuses.slug })
          .from(teamWorkflowStatuses)
          .where(
            and(
              eq(teamWorkflowStatuses.teamId, issueRow.teamId),
              eq(teamWorkflowStatuses.category, "started"),
              // Prefer in_progress over in_review for revert
            ),
          )
          .then((rows) => rows.find((r) => r.slug === "in_progress") ?? rows[0] ?? null);
        if (startedStatus) startedSlug = startedStatus.slug;
      }

      await db
        .update(issues)
        .set({ status: startedSlug, updatedAt: new Date() })
        .where(eq(issues.id, run.issueId));

      await logActivity(db, {
        companyId: run.companyId,
        actorType: "user",
        actorId: userId,
        action: "pr_rejected",
        entityType: "review_run",
        entityId: runId,
        details: { workProductId: run.workProductId, issueId: run.issueId, decisionNote },
      });
    }

    return result;
  }

  return {
    getTeamPipeline,
    upsertTeamPipeline,
    createRun,
    getRunsByIssue,
    getRunById,
    updateCheck,
    approveRun,
    rejectRun,
  };
}
