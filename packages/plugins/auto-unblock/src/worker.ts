import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("auto-unblock plugin setup");

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;

      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      const currentStatus = payload.status as string | undefined;
      const previous = payload._previous as Record<string, unknown> | undefined;
      const previousStatus = previous?.status as string | undefined;

      // Only act when status changed TO done or cancelled
      if (!currentStatus || !previousStatus) return;
      if (currentStatus !== "done" && currentStatus !== "cancelled") return;
      if (currentStatus === previousStatus) return;

      // Get the completed child issue
      const childIssue = await ctx.issues.get(issueId, companyId);
      if (!childIssue) return;

      // Must have a parent
      if (!childIssue.parentId) return;

      // Get parent issue — only act if parent is blocked
      const parentIssue = await ctx.issues.get(childIssue.parentId, companyId);
      if (!parentIssue) return;
      if (parentIssue.status !== "blocked") return;

      // List all issues for the company and filter for siblings (same parentId)
      const allIssues = await ctx.issues.list({ companyId, limit: 1000 });
      const siblings = allIssues.filter(
        (issue) => issue.parentId === parentIssue.id && issue.id !== childIssue.id,
      );

      const pendingSiblings = siblings.filter(
        (issue) => issue.status !== "done" && issue.status !== "cancelled",
      );

      if (pendingSiblings.length === 0) {
        // All siblings resolved → unblock parent
        await ctx.issues.update(
          parentIssue.id,
          { status: "todo" },
          companyId,
        );
        await ctx.issues.createComment(
          parentIssue.id,
          `\u{1F513} Auto-unblocked: all child issues resolved. Last resolved: ${childIssue.identifier} (${currentStatus}).`,
          companyId,
        );

        ctx.logger.info("auto-unblocked parent issue", {
          parentId: parentIssue.id,
          childId: childIssue.id,
          childStatus: currentStatus,
        });
      } else {
        // Some siblings still pending → comment only
        const pendingIdentifiers = pendingSiblings
          .map((issue) => issue.identifier)
          .join(", ");
        await ctx.issues.createComment(
          parentIssue.id,
          `\u{1F513} Dependency ${childIssue.identifier} resolved (${currentStatus}). Still waiting on ${pendingSiblings.length} other issue(s): ${pendingIdentifiers}`,
          companyId,
        );

        ctx.logger.info("child resolved but siblings still pending", {
          parentId: parentIssue.id,
          childId: childIssue.id,
          pendingCount: pendingSiblings.length,
        });
      }
    });
  },

  async onHealth() {
    return { status: "ok", message: "auto-unblock plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
