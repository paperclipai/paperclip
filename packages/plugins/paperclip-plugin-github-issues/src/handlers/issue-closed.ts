// src/handlers/issue-closed.ts
import type { PluginConfig } from "../types.js";
import { resolveProjectId } from "../repo-resolver.js";
import { issueOriginKind, issueOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleIssueClosed(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  if (!resolveProjectId(repo, config.repoToProject)) return;

  const issueId = await findIssueByOrigin(
    ctx.issues, config.companyId, issueOriginKind(), issueOriginId(repo, payload.issue.number),
  );
  if (!issueId) return;

  await ctx.issues.update(issueId, { status: "done" }, config.companyId);
}
