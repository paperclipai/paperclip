import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { GitHubClient } from "./github/client.js";
import { clearTokenCache } from "./github/auth.js";
import { validateWebhookSignature } from "./github/webhook.js";
import type { GitHubSyncConfig, GitHubWebhookPayload } from "./github/types.js";
import { processGitHubIssue } from "./sync/inbound.js";
import { handleIssueUpdated } from "./sync/outbound.js";
import { discoverRepos, initialSync, pollAllRepos } from "./sync/poll.js";
import { isDeliveryProcessed, isOwnSyncEvent, markDeliveryProcessed } from "./sync/dedup.js";
import { getIssueForPR, getGithubRefForIssue } from "./sync/mapping.js";
import { ACTION_KEYS, DATA_KEYS, JOB_KEYS, STATE_KEYS, WEBHOOK_KEYS } from "./constants.js";

function getConfig(raw: Record<string, unknown>): GitHubSyncConfig {
  return {
    githubAppId: raw.githubAppId as string,
    githubInstallationId: raw.githubInstallationId as string,
    privateKeySecret: raw.privateKeySecret as string,
    orgName: raw.orgName as string,
    companyId: raw.companyId as string,
    pollIntervalMinutes: (raw.pollIntervalMinutes as number) ?? 5,
    syncLabelsPrefix: (raw.syncLabelsPrefix as string) ?? "agent:",
    webhookSecretRef: raw.webhookSecretRef as string,
  };
}

let currentCtx: PluginContext | null = null;
let ghClient: GitHubClient | null = null;
let pluginConfig: GitHubSyncConfig | null = null;
let initialized = false;

async function ensureInitialized(ctx: PluginContext): Promise<{ config: GitHubSyncConfig; client: GitHubClient }> {
  if (!pluginConfig || !ghClient) {
    const rawConfig = await ctx.config.get();
    pluginConfig = getConfig(rawConfig);
    ghClient = new GitHubClient(ctx, pluginConfig);
  }

  if (!initialized) {
    const repos = (await ctx.state.get({ scopeKind: "instance", stateKey: STATE_KEYS.repos })) as string[] | null;
    if (!repos || repos.length === 0) {
      await initialSync(ctx, pluginConfig, ghClient);
    }
    initialized = true;
  }

  return { config: pluginConfig, client: ghClient };
}

const plugin = definePlugin({
  async setup(ctx) {
    currentCtx = ctx;
    ctx.logger.info("GitHub Sync plugin starting");

    // Job: Periodic polling
    ctx.jobs.register(JOB_KEYS.poll, async () => {
      const { config, client } = await ensureInitialized(ctx);
      await pollAllRepos(ctx, config, client);

      const pollCount = ((await ctx.state.get({ scopeKind: "instance", stateKey: "poll-count" })) ?? 0) as number;
      if (pollCount % 12 === 0) {
        await discoverRepos(ctx, config, client);
      }
      await ctx.state.set({ scopeKind: "instance", stateKey: "poll-count" }, pollCount + 1);
    });

    // Events: Outbound sync
    ctx.events.on("issue.updated", async (event) => {
      try {
        const { config, client } = await ensureInitialized(ctx);
        if (event.companyId !== config.companyId) return;
        await handleIssueUpdated(ctx, config, client, event);
      } catch (err) {
        ctx.logger.error("Error in outbound sync (updated)", { error: String(err) });
        await ctx.metrics.write("github_sync.errors", 1, { type: "outbound" });
      }
    });

    ctx.events.on("issue.created", async (event) => {
      try {
        const { config } = await ensureInitialized(ctx);
        if (event.companyId !== config.companyId) return;
        ctx.logger.debug("Issue created event received", { entityId: event.entityId });
      } catch (err) {
        ctx.logger.error("Error in outbound sync (created)", { error: String(err) });
      }
    });

    // Data: UI endpoints
    ctx.data.register(DATA_KEYS.syncStatus, async () => {
      const { config } = await ensureInitialized(ctx);
      const repos = ((await ctx.state.get({ scopeKind: "instance", stateKey: STATE_KEYS.repos })) ?? []) as string[];
      const unlinkedRepos = ((await ctx.state.get({ scopeKind: "instance", stateKey: STATE_KEYS.unlinkedRepos })) ?? []) as string[];
      const rateLimit = (await ctx.state.get({ scopeKind: "instance", stateKey: STATE_KEYS.rateLimit })) as { remaining: number; resetAt: number } | null;
      return { connected: true, orgName: config.orgName, trackedRepos: repos.length, unlinkedRepos, rateLimit };
    });

    ctx.data.register(DATA_KEYS.issueGithubInfo, async (params) => {
      const issueId = params.issueId as string;
      if (!issueId) return null;
      const githubRef = await getGithubRefForIssue(ctx, issueId);
      if (!githubRef) return null;
      const [repoFullName, number] = githubRef.split("#");
      const prRef = (await ctx.state.get({ scopeKind: "instance", stateKey: `issue:${issueId}:prRef` })) as string | null;
      const updatedAt = (await ctx.state.get({ scopeKind: "instance", stateKey: `issue:${githubRef}:updatedAt` })) as string | null;
      return {
        githubRef, repoFullName, issueNumber: parseInt(number, 10),
        issueUrl: `https://github.com/${repoFullName}/issues/${number}`,
        prRef, prUrl: prRef ? `https://github.com/${prRef.split("#")[0]}/pull/${prRef.split("#")[1]}` : null,
        lastSyncedAt: updatedAt,
      };
    });

    // Actions: UI actions
    ctx.actions.register(ACTION_KEYS.forceSyncNow, async () => {
      const { config, client } = await ensureInitialized(ctx);
      await pollAllRepos(ctx, config, client);
      return { success: true };
    });

    ctx.actions.register(ACTION_KEYS.testConnection, async () => {
      const { client } = await ensureInitialized(ctx);
      return client.verifyConnection();
    });

    ctx.logger.info("GitHub Sync plugin ready");
  },

  async onWebhook(input: PluginWebhookInput) {
    if (!currentCtx) throw new Error("Plugin not initialized");
    const ctx = currentCtx;
    const { config, client } = await ensureInitialized(ctx);

    if (input.endpointKey !== WEBHOOK_KEYS.githubEvents) {
      ctx.logger.warn("Unknown webhook endpoint", { endpointKey: input.endpointKey });
      return;
    }

    const valid = await validateWebhookSignature(ctx, config, input.rawBody, input.headers["x-hub-signature-256"]);
    if (!valid) {
      ctx.logger.warn("Invalid webhook signature");
      await ctx.metrics.write("github_sync.errors", 1, { type: "webhook_auth" });
      return;
    }

    const deliveryId = Array.isArray(input.headers["x-github-delivery"]) ? input.headers["x-github-delivery"][0] : input.headers["x-github-delivery"];
    if (deliveryId && (await isDeliveryProcessed(ctx, deliveryId))) {
      ctx.logger.debug("Duplicate delivery, skipping", { deliveryId });
      return;
    }

    const payload = input.parsedBody as GitHubWebhookPayload;

    if (payload.issue?.body) {
      const githubRef = `${payload.repository.full_name}#${payload.issue.number}`;
      if (await isOwnSyncEvent(ctx, githubRef, payload.issue.body)) {
        ctx.logger.debug("Own sync event, skipping", { githubRef });
        if (deliveryId) await markDeliveryProcessed(ctx, deliveryId);
        return;
      }
    }

    const eventType = Array.isArray(input.headers["x-github-event"]) ? input.headers["x-github-event"][0] : input.headers["x-github-event"];

    if (eventType === "issues" && payload.issue) {
      await processGitHubIssue(ctx, config, client, payload.repository.full_name, payload.issue);
    }

    if (eventType === "pull_request" && payload.pull_request) {
      if (payload.action === "closed" && payload.pull_request.merged) {
        const prRef = `${payload.repository.full_name}#${payload.pull_request.number}`;
        const issueId = await getIssueForPR(ctx, prRef);
        if (issueId) {
          const issue = await ctx.issues.get(issueId, config.companyId);
          if (issue && issue.status === "in_review") {
            await ctx.issues.update(issueId, { status: "done" }, config.companyId);
            await ctx.activity.log({ companyId: config.companyId, message: `PR ${prRef} merged via webhook, issue marked done`, entityType: "issue", entityId: issueId });
          }
        }
      }
    }

    if (deliveryId) await markDeliveryProcessed(ctx, deliveryId);
    await ctx.metrics.write("github_sync.api_calls", 1, { source: "webhook" });
  },

  async onHealth() {
    if (!pluginConfig || !ghClient) {
      return { status: "degraded" as const, message: "Not yet initialized" };
    }
    const result = await ghClient.verifyConnection();
    if (!result.ok) {
      return { status: "error" as const, message: `GitHub connection failed: ${result.error}` };
    }
    return { status: "ok" as const, message: "Connected to GitHub" };
  },

  async onConfigChanged(newConfig: Record<string, unknown>) {
    pluginConfig = getConfig(newConfig);
    ghClient = null;
    clearTokenCache();
    initialized = false;
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const errors: string[] = [];
    for (const field of ["githubAppId", "githubInstallationId", "privateKeySecret", "orgName", "companyId", "webhookSecretRef"]) {
      if (!config[field] || typeof config[field] !== "string") errors.push(`${field} is required`);
    }
    const poll = config.pollIntervalMinutes;
    if (poll !== undefined && (typeof poll !== "number" || poll < 1 || poll > 30)) errors.push("pollIntervalMinutes must be between 1 and 30");
    return { ok: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
