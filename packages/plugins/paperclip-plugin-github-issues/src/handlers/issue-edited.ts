// src/handlers/issue-edited.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { issueOriginKind, issueOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleIssueEdited(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, issueOriginKind(), issueOriginId(repo, payload.issue.number),
  );
  if (!issueId) return;

  const wakePayload = { action: "edited", issueNumber: payload.issue.number, repo, title: payload.issue.title };
  const body = [
    `**GitHub edit:** ${payload.issue.title}`,
    "",
    payload.issue.body ?? "",
    "",
    payload.issue.html_url,
    "",
    "```json:wake_payload",
    JSON.stringify(wakePayload, null, 2),
    "```",
  ].join("\n");

  await ctx.issues.createComment(issueId, body, config.companyId);
  await ctx.issues.requestWakeup(issueId, config.companyId, {
    reason: "github_issue_updated",
    idempotencyKey: `gh-edit:${repo}#${payload.issue.number}:${payload.issue.updated_at ?? Date.now()}`,
  });
}
