import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginConfig } from "./config-schema.js";
import { bootstrapCompany } from "./bootstrap.js";
import {
  handleIssueUpdated,
  handleCommentCreated,
  handleApprovalCreated,
} from "./triggers.js";

const plugin = definePlugin({
  async setup(ctx) {
    const config = (await ctx.config.get()) as PluginConfig | null;
    if (!config || !config.companies?.length) {
      ctx.logger.warn("pushover_watch_no_companies_configured");
      return;
    }

    const enabledCompanyIds = new Set(
      config.companies.filter((c) => c.enabled !== false).map((c) => c.companyId),
    );

    for (const company of config.companies) {
      if (company.enabled === false) continue;
      await bootstrapCompany(ctx, company);
    }

    ctx.events.on("issue.updated", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleIssueUpdated(ctx, config, event as any);
    });

    ctx.events.on("issue.comment.created", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleCommentCreated(ctx, config, event as any);
    });

    ctx.events.on("approval.created", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleApprovalCreated(ctx, config, event as any);
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
