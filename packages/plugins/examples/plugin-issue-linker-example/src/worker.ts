import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("issue-linker-example plugin setup");

    // getData: search issues by query text
    ctx.data.register("searchIssues", async (params: Record<string, unknown>) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const query = typeof params.query === "string" ? params.query.toLowerCase().trim() : "";
      if (!companyId) return { issues: [] };

      const all = await ctx.issues.list({ companyId, limit: 200 });
      const filtered = query
        ? all.filter(
            (i) =>
              i.title.toLowerCase().includes(query) ||
              (i.identifier ?? "").toLowerCase().includes(query),
          )
        : all;
      return {
        issues: filtered.slice(0, 20).map((i) => ({
          id: i.id,
          identifier: i.identifier ?? "",
          title: i.title,
          status: i.status,
          priority: i.priority,
        })),
      };
    });

    // performAction: link selected issue as blocker of the current issue
    ctx.actions.register("linkIssue", async (params: Record<string, unknown>) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const sourceIssueId = typeof params.sourceIssueId === "string" ? params.sourceIssueId : "";
      const targetIssueId = typeof params.targetIssueId === "string" ? params.targetIssueId : "";
      if (!companyId || !sourceIssueId || !targetIssueId) {
        throw new Error("Missing required params: companyId, sourceIssueId, targetIssueId");
      }
      await ctx.issues.relations.addBlockers(sourceIssueId, [targetIssueId], companyId);
      return { ok: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: "issue-linker-example ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
