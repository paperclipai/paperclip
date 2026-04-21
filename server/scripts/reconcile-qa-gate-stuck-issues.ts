import { and, eq } from "drizzle-orm";
import { createDb, companies, issues } from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";
import { loadConfig } from "../src/config.js";
import { executionWorkspaceService, issueMergeService, issueService, logActivity, projectService } from "../src/services/index.js";
import { finalizeQaValidatedIssueFromComment } from "../src/services/issue-qa-finalization.js";
import {
  buildIssueQaGate,
  qaCommentHasQaPassMarker,
  qaCommentHasReleaseConfirmedMarker,
  selectLatestRelevantQaComment,
} from "../src/services/qa-gate.js";
import { resolveCompanyReleaseGateQaAgent } from "../src/services/release-gate-qa.js";

const NON_DONE_DISPOSITION_REGEX = /\bwont\s+fix\b|\bcan't\s+reproduce\b|\bcant\s+reproduce\b|\bnon-reproducible\b|\bno action required\b/i;

function resolveDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;

  const config = loadConfig();
  if (config.databaseUrl?.trim()) return config.databaseUrl.trim();
  if (config.databaseMode === "embedded-postgres") {
    return `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  }
  return null;
}

function readFlag(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1]?.trim() || null;
}

function hasNonDoneDisposition(body: string | null | undefined) {
  return NON_DONE_DISPOSITION_REGEX.test(body ?? "");
}

async function persistExecutionWorkspaceMergeStatus(
  executionWorkspacesSvc: ReturnType<typeof executionWorkspaceService>,
  workspace: Awaited<ReturnType<ReturnType<typeof executionWorkspaceService>["getById"]>>,
  mergeStatus: Awaited<ReturnType<ReturnType<typeof issueMergeService>["attemptQaPassAutoMerge"]>> extends { status: infer T } ? T : never,
) {
  if (!workspace || !mergeStatus) return workspace;
  const metadata = {
    ...((workspace.metadata as Record<string, unknown> | null) ?? {}),
    merge: {
      state: mergeStatus.state,
      targetBranch: mergeStatus.targetBranch,
      sourceBranch: mergeStatus.sourceBranch,
      repoRoot: mergeStatus.repoRoot,
      reason: mergeStatus.reason,
      mergedCommit: mergeStatus.mergedCommit,
      mergedAt: mergeStatus.mergedAt?.toISOString() ?? null,
      lastAttemptedAt: mergeStatus.lastAttemptedAt?.toISOString() ?? null,
    },
  };
  return await executionWorkspacesSvc.update(workspace.id, { metadata });
}

async function main() {
  const dbUrl = resolveDatabaseUrl();
  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");
  const issuePrefix = readFlag("--issue-prefix");
  const companyIdFlag = readFlag("--company-id");

  if (!dbUrl) {
    console.error("Unable to resolve a database connection string for QA gate reconciliation.");
    process.exit(1);
  }
  if (!issuePrefix && !companyIdFlag) {
    console.error("Usage: tsx server/scripts/reconcile-qa-gate-stuck-issues.ts (--issue-prefix <prefix> | --company-id <uuid>) [--apply] [--json]");
    process.exit(1);
  }

  const db = createDb(dbUrl);
  try {
    const company = await db
      .select({
        id: companies.id,
        name: companies.name,
        issuePrefix: companies.issuePrefix,
      })
      .from(companies)
      .where(
        companyIdFlag
          ? eq(companies.id, companyIdFlag)
          : eq(companies.issuePrefix, issuePrefix!),
      )
      .then((rows) => rows[0] ?? null);

    if (!company) {
      console.error("Company not found for QA gate reconciliation.");
      process.exit(1);
    }

    const issuesSvc = issueService(db);
    const projectsSvc = projectService(db);
    const executionWorkspacesSvc = executionWorkspaceService(db);
    const issueMerge = issueMergeService();
    const qaResolution = await resolveCompanyReleaseGateQaAgent(db, company.id);
    const qaAgentId = qaResolution.releaseGateQaAgent?.id ?? null;

    if (!qaAgentId) {
      console.error("No authorized release-gate QA owner is currently resolvable for this company.");
      process.exit(1);
    }

    const candidateIssues = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionState: issues.executionState,
        parentId: issues.parentId,
        identifier: issues.identifier,
        title: issues.title,
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        workflowTemplateKey: issues.workflowTemplateKey,
        workflowLaneRole: issues.workflowLaneRole,
      })
      .from(issues)
      .where(and(eq(issues.companyId, company.id), eq(issues.status, "in_review")));

    const report = [];
    for (const issue of candidateIssues) {
      const comments = await issuesSvc.listComments(issue.id, { order: "desc", limit: 500 });
      const qaComments = comments.filter((comment) => comment.authorAgentId === qaAgentId);
      const selectedComment = selectLatestRelevantQaComment(qaComments);
      const qaGate = buildIssueQaGate({
        issue: { status: issue.status as IssueStatus },
        assigneeRole: "qa",
        qaComments,
        latestDecisionOutcome:
          issue.executionState && typeof issue.executionState === "object"
            ? ((issue.executionState as { lastDecisionOutcome?: unknown }).lastDecisionOutcome as any) ?? null
            : null,
      });
      const hasCanonicalMarkers = selectedComment
        ? qaCommentHasQaPassMarker(selectedComment.body) && qaCommentHasReleaseConfirmedMarker(selectedComment.body)
        : false;
      const hasNonDoneQaDisposition = selectedComment ? hasNonDoneDisposition(selectedComment.body) : false;
      const isWorkflowIssue = Boolean(issue.workflowTemplateKey || issue.workflowLaneRole);
      const eligible =
        !isWorkflowIssue
        &&
        issue.assigneeAgentId === qaAgentId
        && !issue.assigneeUserId
        && hasCanonicalMarkers
        && !hasNonDoneQaDisposition
        && qaGate.canShip;

      const entry: Record<string, unknown> = {
        identifier: issue.identifier ?? issue.id,
        issueId: issue.id,
        eligible,
        isWorkflowIssue,
        hasNonDoneQaDisposition,
        selectedCommentId: selectedComment?.id ?? null,
        selectedCommentCreatedAt: selectedComment?.createdAt ?? null,
        canShip: qaGate.canShip,
        missingRequirements: qaGate.missingRequirements,
      };

      if (!eligible || !apply || !selectedComment) {
        report.push(entry);
        continue;
      }

      const result = await finalizeQaValidatedIssueFromComment({
        db,
        issue,
        comment: selectedComment,
        actor: {
          actorType: "agent",
          actorId: qaAgentId,
          agentId: qaAgentId,
          runId: null,
        },
        logActivity,
        resolveReleaseGateQaAgent: async (companyId) => await resolveCompanyReleaseGateQaAgent(db, companyId),
        issues: {
          update: async (issueId, patch) => await issuesSvc.update(issueId, patch),
          addComment: async (issueId, body, actor) => await issuesSvc.addComment(issueId, body, actor),
          listComments: async (issueId) => await issuesSvc.listComments(issueId, { order: "desc", limit: 500 }),
        },
        issueMerge,
        projects: {
          getById: async (projectId) => await projectsSvc.getById(projectId),
        },
        executionWorkspaces: {
          getById: async (workspaceId) => await executionWorkspacesSvc.getById(workspaceId),
        },
        persistExecutionWorkspaceMergeStatus: async (workspace, mergeStatus) =>
          await persistExecutionWorkspaceMergeStatus(executionWorkspacesSvc, workspace, mergeStatus),
      });

      report.push({
        ...entry,
        applied: result.issue.status === "done",
        finalStatus: result.issue.status,
        mergeStatus: result.mergeStatus?.state ?? null,
      });
    }

    const summary = {
      companyId: company.id,
      companyName: company.name,
      issuePrefix: company.issuePrefix,
      mode: apply ? "apply" : "dry-run",
      scanned: report.length,
      eligible: report.filter((entry) => entry.eligible === true).length,
      applied: report.filter((entry) => entry.applied === true).length,
      results: report,
    };

    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(
        `mode=${summary.mode} company=${company.issuePrefix} scanned=${summary.scanned} eligible=${summary.eligible} applied=${summary.applied}`,
      );
      for (const entry of report) {
        const identifier = String(entry.identifier);
        const status = entry.applied === true ? "closed" : entry.eligible === true ? "ready" : "skipped";
        console.log(`${identifier}\t${status}\t${JSON.stringify(entry.missingRequirements ?? [])}`);
      }
      if (!apply) {
        console.log("Re-run with --apply to close eligible issues.");
      }
    }
  } finally {
    await db.$client.end().catch(() => {});
  }
}

void main();
