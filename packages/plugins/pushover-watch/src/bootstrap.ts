import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CompanyConfig, CachedIssueState } from "./config-schema.js";

const OPEN_STATUSES: ReadonlyArray<CachedIssueState["status"]> = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
];

export async function bootstrapCompany(
  ctx: PluginContext,
  company: CompanyConfig,
): Promise<void> {
  const marker = await ctx.state.get({
    scopeKind: "company",
    scopeId: company.companyId,
    stateKey: "pushover-watch:bootstrap-done",
  });
  if (marker) {
    ctx.logger.info("pushover_watch_bootstrap_skipped", {
      companyId: company.companyId,
    });
    return;
  }

  let totalSeeded = 0;
  for (const status of OPEN_STATUSES) {
    const issues = await ctx.issues.list({
      companyId: company.companyId,
      status,
      limit: 1000,
    });
    for (const issue of issues) {
      const cached: CachedIssueState = {
        status: issue.status as CachedIssueState["status"],
        assigneeAgentId: issue.assigneeAgentId ?? null,
        assigneeUserId: issue.assigneeUserId ?? null,
        updatedAt:
          issue.updatedAt instanceof Date
            ? issue.updatedAt.toISOString()
            : String(issue.updatedAt),
      };
      await ctx.state.set(
        {
          scopeKind: "issue",
          scopeId: issue.id,
          stateKey: "pushover-watch:last-seen",
        },
        cached,
      );
      totalSeeded += 1;
    }
  }

  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: company.companyId,
      stateKey: "pushover-watch:bootstrap-done",
    },
    { at: new Date().toISOString() },
  );

  ctx.logger.info("pushover_watch_bootstrap_done", {
    companyId: company.companyId,
    seeded: totalSeeded,
  });
}
