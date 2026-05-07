import type { PluginConfig } from "../types.js";
import { hasEligibleLabel } from "../label-gate.js";
import { resolveProjectId } from "../repo-resolver.js";
import { issueOriginKind, issueOriginId } from "../origin-ref.js";
import { findIssueByOrigin } from "../lookup.js";

export async function handleIssueOpened(payload: any, ctx: any, config: PluginConfig): Promise<void> {
  const repo = payload.repository.full_name as string;
  const projectId = resolveProjectId(repo, config.repoToProject);
  if (!projectId) return;

  if (!hasEligibleLabel(payload.issue.labels, config.labelGate)) return;

  const originKind = issueOriginKind();
  const originId = issueOriginId(repo, payload.issue.number);

  const existing = await findIssueByOrigin(ctx.issues, config.companyId, originKind, originId);
  if (existing) return;

  await ctx.issues.create({
    companyId: config.companyId,
    projectId,
    title: payload.issue.title,
    description: `${payload.issue.body ?? ""}\n\n---\nFonte: ${payload.issue.html_url}`,
    assigneeAgentId: config.ceoAgentId,
    originKind,
    originId,
    status: "todo",
  });
}
