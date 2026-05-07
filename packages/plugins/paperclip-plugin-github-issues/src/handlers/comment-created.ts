// src/handlers/comment-created.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { issueOriginKind, issueOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleCommentCreated(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, issueOriginKind(), issueOriginId(repo, payload.issue.number),
  );
  if (!issueId) return;

  const wakePayload = {
    action: "comment_created",
    commentId: payload.comment.id,
    author: payload.comment.user.login,
    repo,
  };
  const body = [
    `**GitHub comment by @${payload.comment.user.login}:**`,
    "",
    payload.comment.body,
    "",
    payload.comment.html_url,
    "",
    "```json:wake_payload",
    JSON.stringify(wakePayload, null, 2),
    "```",
  ].join("\n");

  await ctx.issues.createComment(issueId, body, config.companyId);
  await ctx.issues.requestWakeup(issueId, config.companyId, {
    reason: "github_comment_created",
    idempotencyKey: `gh-comment:${payload.comment.id}`,
  });
}
