// src/handlers/workflow-run.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { prOriginKind, prOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleWorkflowRun(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const prs = payload.workflow_run?.pull_requests ?? [];
  if (prs.length === 0) return;
  const prNumber = prs[0].number;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, prOriginKind(), prOriginId(repo, prNumber),
  );
  if (!issueId) return;

  const wakePayload = {
    action: "ci_green",
    headSha: payload.workflow_run.head_sha,
    runId: payload.workflow_run.id,
    prNumber,
    repo,
    runUrl: payload.workflow_run.html_url,
  };
  const body = [
    `**CI green** — workflow run ${payload.workflow_run.id} succeeded for PR #${prNumber}.`,
    "",
    `head_sha: \`${payload.workflow_run.head_sha}\``,
    payload.workflow_run.html_url,
    "",
    "```json:wake_payload",
    JSON.stringify(wakePayload, null, 2),
    "```",
  ].join("\n");

  await ctx.issues.createComment(issueId, body, config.companyId);
  await ctx.issues.requestWakeup(issueId, config.companyId, {
    reason: "ci_green",
    idempotencyKey: `gh-ci:${payload.workflow_run.id}`,
  });
}
