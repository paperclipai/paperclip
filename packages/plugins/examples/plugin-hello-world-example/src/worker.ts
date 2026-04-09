import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const PLUGIN_NAME = "hello-world-example";
const HEALTH_MESSAGE = "Company Pulse widget ready";
const OPEN_ISSUE_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);
const ACTIVE_GOAL_STATUSES = new Set(["planned", "active", "in_progress"]);

function countMatchingStatus(
  records: Array<{ status?: string | null }>,
  allowedStatuses: ReadonlySet<string>,
): number {
  return records.reduce((count, record) => {
    const status = typeof record.status === "string" ? record.status : "";
    return count + (allowedStatuses.has(status) ? 1 : 0);
  }, 0);
}

/**
 * Worker lifecycle hooks for the Hello World reference plugin.
 * This stays intentionally small so new authors can copy the shape quickly.
 */
const plugin = definePlugin({
  /**
   * Called when the host starts the plugin worker.
   */
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup complete`);

    ctx.data.register("company-pulse", async (params: Record<string, unknown>) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!companyId) {
        return {
          companyId: null,
          counts: {
            projects: 0,
            issues: 0,
            openIssues: 0,
            goals: 0,
            activeGoals: 0,
            agents: 0,
            activeAgents: 0,
          },
          summary: "Select a company to load operational data.",
        };
      }

      const [projects, issues, goals, agents] = await Promise.all([
        ctx.projects.list({ companyId, limit: 200, offset: 0 }),
        ctx.issues.list({ companyId, limit: 200, offset: 0 }),
        ctx.goals.list({ companyId, limit: 200, offset: 0 }),
        ctx.agents.list({ companyId, limit: 200, offset: 0 }),
      ]);

      const openIssues = countMatchingStatus(issues, OPEN_ISSUE_STATUSES);
      const activeGoals = countMatchingStatus(goals, ACTIVE_GOAL_STATUSES);
      const activeAgents = agents.reduce((count, agent) => {
        const status = typeof agent.status === "string" ? agent.status : "";
        return count + (status === "active" || status === "running" || status === "pending_approval" ? 1 : 0);
      }, 0);

      return {
        companyId,
        counts: {
          projects: projects.length,
          issues: issues.length,
          openIssues,
          goals: goals.length,
          activeGoals,
          agents: agents.length,
          activeAgents,
        },
        summary:
          openIssues > 0
            ? `${openIssues} open issues need attention across ${projects.length} projects.`
            : `No open issues right now across ${projects.length} projects.`,
      };
    });
  },

  /**
   * Called by the host health probe endpoint.
   */
  async onHealth() {
    return { status: "ok", message: HEALTH_MESSAGE };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
