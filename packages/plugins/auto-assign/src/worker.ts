import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

interface AutoAssignConfig {
  prefixMap?: Record<string, string>;
}

/**
 * Match the first emoji-like character(s) at the start of a string.
 * Covers most common emoji including compound sequences (flags, skin tones, ZWJ).
 */
const LEADING_EMOJI_RE =
  /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/u;

function extractLeadingEmoji(title: string): string | null {
  const trimmed = title.trimStart();
  const m = trimmed.match(LEADING_EMOJI_RE);
  return m ? m[0] : null;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("auto-assign plugin setup");

    // ---------------------------------------------------------------
    // issue.created — assign if title has emoji prefix & no assignee
    // ---------------------------------------------------------------
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;

      const config = (await ctx.config.get()) as AutoAssignConfig;
      const prefixMap = config.prefixMap ?? {};
      if (Object.keys(prefixMap).length === 0) return;

      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) return;

      // Already assigned → skip
      if (issue.assigneeAgentId) return;

      const emoji = extractLeadingEmoji(issue.title);
      if (!emoji) return;

      const targetAgentId = prefixMap[emoji];
      if (!targetAgentId) return;

      ctx.logger.info("auto-assigning issue.created", {
        issueId,
        emoji,
        targetAgentId,
      });

      await ctx.issues.update(
        issueId,
        { assigneeAgentId: targetAgentId },
        companyId,
      );
    });

    // ---------------------------------------------------------------
    // issue.updated — re-assign if assignee was cleared (non-null → null)
    // ---------------------------------------------------------------
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;

      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      // Only act when assigneeAgentId was explicitly changed to null
      const previous = payload._previous as Record<string, unknown> | undefined;
      if (!previous || !("assigneeAgentId" in previous)) return;

      // Previous must have been non-null (was assigned before)
      if (!previous.assigneeAgentId) return;

      const config = (await ctx.config.get()) as AutoAssignConfig;
      const prefixMap = config.prefixMap ?? {};
      if (Object.keys(prefixMap).length === 0) return;

      // Fetch current issue to get title and confirm assignee is null
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) return;
      if (issue.assigneeAgentId) return; // re-assigned by someone else already

      const emoji = extractLeadingEmoji(issue.title);
      if (!emoji) return;

      const targetAgentId = prefixMap[emoji];
      if (!targetAgentId) return;

      ctx.logger.info("auto-re-assigning issue.updated", {
        issueId,
        emoji,
        targetAgentId,
        previousAssignee: previous.assigneeAgentId,
      });

      await ctx.issues.update(
        issueId,
        { assigneeAgentId: targetAgentId },
        companyId,
      );
    });
  },

  async onHealth() {
    return { status: "ok", message: "auto-assign plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
