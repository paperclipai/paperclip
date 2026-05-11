import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginJobContext,
  type PluginHealthDiagnostics,
  type ToolResult,
} from "@paperclipai/plugin-sdk";

import {
  HigherGovClient,
  deduplicateByOpportunityId,
  applyHardFilters,
  scoreOpportunity,
  scoreBatch,
  HubSpotClient,
  DEFAULT_MIN_SCORE,
} from "@paperclipai/govbids";
import type { NormalizedOpportunity, ScoredOpportunity } from "@paperclipai/govbids";

import { JOB_KEYS, TOOL_NAMES, STATE_KEYS } from "./constants.js";
import { buildIssueDescription, scoreToPriority } from "./issue-builder.js";

interface GovBidsConfig {
  higherGovApiKeyRef: string;
  claudeApiKeyRef: string;
  hubspotApiKeyRef?: string;
  minQualificationScore?: number;
  dailyScanEnabled?: boolean;
  projectId?: string;
  parentIssueId?: string;
}

async function getConfig(ctx: PluginContext): Promise<GovBidsConfig> {
  return (await ctx.config.get()) as unknown as GovBidsConfig;
}

// ── Plugin Definition ──────────────────────────────────────────────

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    await registerJobs(ctx);
    await registerToolHandlers(ctx);
    await registerEventHandlers(ctx);
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return {
      status: "ok",
      message: "GovBids pipeline plugin ready",
      details: {},
    };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const typed = config as unknown as GovBidsConfig;

    if (!typed.higherGovApiKeyRef) {
      errors.push("higherGovApiKeyRef is required");
    }
    if (!typed.claudeApiKeyRef) {
      errors.push("claudeApiKeyRef is required");
    }

    return {
      ok: errors.length === 0,
      warnings: [],
      errors,
    };
  },
});

// ── Job Handlers ───────────────────────────────────────────────────

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(
    JOB_KEYS.dailyScan,
    async (job: PluginJobContext) => {
      const config = await getConfig(ctx);

      if (!config.dailyScanEnabled) {
        ctx.logger.info("Daily scan disabled in config, skipping");
        return;
      }

      // Resolve API keys from secrets
      const higherGovKey = await ctx.secrets.resolve(config.higherGovApiKeyRef);
      const claudeKey = await ctx.secrets.resolve(config.claudeApiKeyRef);
      const minScore = config.minQualificationScore ?? DEFAULT_MIN_SCORE;

      // Get last captured date from state
      const lastCaptured = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.lastCapturedDate,
      })) as string | null;

      ctx.logger.info("Starting daily opportunity scan", {
        since: lastCaptured,
        minScore,
      });

      // Fetch from HigherGov
      const client = new HigherGovClient({ apiKey: higherGovKey });
      const { opportunities, apiCallsUsed } =
        await client.fetchAllKeywordSearches({
          capturedAfter: lastCaptured ?? undefined,
        });

      // Dedup and filter
      const deduped = deduplicateByOpportunityId(opportunities);
      const { kept, dropped } = applyHardFilters(deduped);

      ctx.logger.info("Fetch and filter complete", {
        fetched: opportunities.length,
        deduped: deduped.length,
        kept: kept.length,
        dropped: dropped.length,
      });

      // Score with Claude
      const scored = await scoreBatch(kept, { apiKey: claudeKey });
      const qualified = scored.filter((o) => o.score >= minScore);

      ctx.logger.info("Scoring complete", {
        scored: scored.length,
        qualified: qualified.length,
      });

      // Create issues for qualified opportunities
      for (const opp of qualified) {
        // Check if we already tracked this opportunity via plugin entities
        const existing = await ctx.entities.list({
          entityType: "govbid-opportunity",
          externalId: opp.id,
        });

        if (existing.length > 0) {
          ctx.logger.debug("Issue already exists for opportunity", {
            oppId: opp.id,
          });
          continue;
        }

        const issue = await ctx.issues.create({
          companyId: "",
          projectId: config.projectId,
          parentId: config.parentIssueId,
          title: `[GovBid:${opp.id}] ${opp.title} — ${opp.agency}`.slice(0, 200),
          description: buildIssueDescription(opp),
          priority: scoreToPriority(opp.score),
        });

        // Track this opportunity in plugin entities for dedup
        await ctx.entities.upsert({
          entityType: "govbid-opportunity",
          scopeKind: "instance",
          externalId: opp.id,
          title: opp.title,
          status: "created",
          data: { issueId: issue.id, score: opp.score },
        });

        // Store full opportunity data as an issue document
        await ctx.issues.documents.upsert({
          issueId: issue.id,
          key: "opportunity-data",
          companyId: "",
          title: "HigherGov Opportunity Data",
          body: JSON.stringify(opp, null, 2),
          format: "json",
        });

        ctx.logger.info("Created issue for opportunity", {
          issueId: issue.id,
          oppId: opp.id,
          score: opp.score,
          category: opp.serviceCategory,
        });
      }

      // Update state
      if (opportunities.length > 0) {
        const latestCapture = opportunities
          .filter((o) => o.capturedDate)
          .sort(
            (a, b) =>
              new Date(b.capturedDate!).getTime() -
              new Date(a.capturedDate!).getTime(),
          )[0]?.capturedDate;
        if (latestCapture) {
          await ctx.state.set(
            { scopeKind: "instance", stateKey: STATE_KEYS.lastCapturedDate },
            latestCapture,
          );
        }
      }

      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.lastRunStats },
        {
          runDate: new Date().toISOString(),
          jobRunId: job.runId,
          fetched: opportunities.length,
          deduped: deduped.length,
          kept: kept.length,
          scored: scored.length,
          qualified: qualified.length,
          issuesCreated: qualified.length,
          apiCallsUsed,
        },
      );

      await ctx.metrics.write("govbids.scan.opportunities_fetched", opportunities.length, {});
      await ctx.metrics.write("govbids.scan.qualified", qualified.length, {});
      await ctx.metrics.write("govbids.scan.api_calls", apiCallsUsed, {});
    },
  );
}

// ── Tool Handlers ──────────────────────────────────────────────────

async function registerToolHandlers(ctx: PluginContext): Promise<void> {
  // Tool: Search opportunities ad-hoc
  ctx.tools.register(
    TOOL_NAMES.searchOpportunities,
    {
      displayName: "Search Government Opportunities",
      description: "Search HigherGov for matching state & local contract opportunities.",
      parametersSchema: {
        type: "object",
        properties: {
          keywords: { type: "string" },
          maxResults: { type: "number", default: 20 },
        },
        required: ["keywords"],
      },
    },
    async (params): Promise<ToolResult> => {
      const config = await getConfig(ctx);
      const higherGovKey = await ctx.secrets.resolve(config.higherGovApiKeyRef);
      const { keywords, maxResults = 20 } = params as { keywords: string; maxResults?: number };

      const client = new HigherGovClient({ apiKey: higherGovKey });
      const { results } = await client.searchOpportunities({
        keywords,
        pageSize: Math.min(maxResults, 100),
      });

      return {
        content: `Found ${results.length} opportunities matching "${keywords}"`,
        data: results.slice(0, maxResults),
      };
    },
  );

  // Tool: Score a single opportunity from an issue
  ctx.tools.register(
    TOOL_NAMES.scoreOpportunity,
    {
      displayName: "Score Government Opportunity",
      description: "Score an opportunity stored in a Paperclip issue.",
      parametersSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const config = await getConfig(ctx);
      const claudeKey = await ctx.secrets.resolve(config.claudeApiKeyRef);
      const { issueId } = params as { issueId: string };

      const oppDoc = await ctx.issues.documents.get(issueId, "opportunity-data", runCtx.companyId);

      if (!oppDoc) {
        return { error: "No opportunity data found on this issue" };
      }

      const opp = JSON.parse(oppDoc.body) as NormalizedOpportunity;
      const scored = await scoreOpportunity(opp, { apiKey: claudeKey });

      // Update the issue document with the scored data
      await ctx.issues.documents.upsert({
        issueId,
        key: "opportunity-data",
        companyId: runCtx.companyId,
        title: "HigherGov Opportunity Data",
        body: JSON.stringify(scored, null, 2),
        format: "json",
      });

      return {
        content: `Scored ${scored.title}: ${scored.score}/100 (${scored.serviceCategory})`,
        data: {
          score: scored.score,
          breakdown: scored.scoreBreakdown,
          category: scored.serviceCategory,
          reasoning: scored.reasoning,
          disqualifiers: scored.disqualifiers,
        },
      };
    },
  );

  // Tool: Push to HubSpot
  ctx.tools.register(
    TOOL_NAMES.pushToHubspot,
    {
      displayName: "Push Opportunity to HubSpot",
      description: "Push a qualified opportunity to HubSpot as a Deal.",
      parametersSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const config = await getConfig(ctx);
      if (!config.hubspotApiKeyRef) {
        return { error: "HubSpot API key not configured" };
      }

      const hubspotKey = await ctx.secrets.resolve(config.hubspotApiKeyRef);
      const { issueId } = params as { issueId: string };

      const oppDoc = await ctx.issues.documents.get(issueId, "opportunity-data", runCtx.companyId);

      if (!oppDoc) {
        return { error: "No opportunity data found on this issue" };
      }

      const opp = JSON.parse(oppDoc.body) as ScoredOpportunity;
      if (!opp.score) {
        return { error: "Opportunity has not been scored yet" };
      }

      const client = new HubSpotClient({ apiKey: hubspotKey });
      const exists = await client.checkDealExists(opp.id);
      if (exists) {
        return {
          content: `Deal already exists in HubSpot for opportunity ${opp.id}`,
          data: { skipped: true },
        };
      }

      const deal = await client.createDeal(opp);

      // Add a comment to the issue noting the HubSpot push
      await ctx.issues.createComment(
        issueId,
        `Pushed to HubSpot as Deal ${deal.id}`,
        runCtx.companyId,
      );

      return {
        content: `Created HubSpot deal ${deal.id} for "${opp.title}"`,
        data: deal,
      };
    },
  );

  // Tool: Get pipeline summary
  ctx.tools.register(
    TOOL_NAMES.getOpportunitySummary,
    {
      displayName: "Get Opportunity Pipeline Summary",
      description: "Summary of recent pipeline runs and quota usage.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (): Promise<ToolResult> => {
      const lastRunStats = await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.lastRunStats,
      });

      const lastCaptured = await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.lastCapturedDate,
      });

      return {
        content: lastRunStats
          ? `Last scan: ${(lastRunStats as Record<string, unknown>).runDate}. ${(lastRunStats as Record<string, unknown>).qualified} qualified opportunities found.`
          : "No scans have been run yet.",
        data: {
          lastRunStats,
          lastCapturedDate: lastCaptured,
        },
      };
    },
  );
}

// ── Event Handlers ─────────────────────────────────────────────────

async function registerEventHandlers(ctx: PluginContext): Promise<void> {
  ctx.events.on("issue.updated", async (event) => {
    // Check if a GovBid issue was marked as "done" — could trigger HubSpot push
    const payload = event.payload as Record<string, unknown>;
    if (payload.status === "done" && typeof payload.title === "string" && payload.title.startsWith("[GovBid:")) {
      ctx.logger.info("GovBid issue completed, consider pushing to HubSpot", {
        issueId: event.entityId,
      });
    }
  });
}

export default plugin;
runWorker(plugin, import.meta.url);
