import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  createOpenBrainClient,
  type OpenBrainClient,
} from "./open-brain-client.js";
import {
  buildDoneThought,
  buildBlockedThought,
  buildDelegationThought,
} from "./thought-builder.js";

interface PluginConfig {
  openBrainEndpoint: string;
  openBrainApiKey?: string;
  captureOnDone: boolean;
  captureOnBlocked: boolean;
  captureOnDelegation: boolean;
}

const DEFAULT_CONFIG: PluginConfig = {
  openBrainEndpoint: "http://127.0.0.1:3010",
  captureOnDone: true,
  captureOnBlocked: true,
  captureOnDelegation: true,
};

async function resolveConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(raw as Partial<PluginConfig>) };
}

async function resolveAgentName(
  ctx: PluginContext,
  agentId: string | null,
  companyId: string,
): Promise<string | undefined> {
  if (!agentId) return undefined;
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    return agent?.name ?? undefined;
  } catch {
    return undefined;
  }
}

async function getLatestComment(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
) {
  try {
    const comments = await ctx.issues.listComments(issueId, companyId);
    return comments.length > 0 ? comments[comments.length - 1] : null;
  } catch {
    return null;
  }
}

async function handleIssueUpdated(
  ctx: PluginContext,
  client: OpenBrainClient,
  event: PluginEvent,
): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const config = await resolveConfig(ctx);
  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) return;

  // Track previous status to detect actual transitions (not just any field edit)
  const lastStatusKey = "last-status";
  const previousStatus = await ctx.state.get({
    scopeKind: "issue",
    scopeId: issueId,
    stateKey: lastStatusKey,
  });

  // Update stored status
  await ctx.state.set(
    { scopeKind: "issue", scopeId: issueId, stateKey: lastStatusKey },
    issue.status,
  );

  // Only fire on actual status transitions
  if (previousStatus === issue.status) {
    return;
  }

  // Clear dedup keys when leaving done/blocked so recapture works on re-entry
  if (previousStatus === "done" || previousStatus === "blocked") {
    await ctx.state.set(
      { scopeKind: "issue", scopeId: issueId, stateKey: `captured-${previousStatus}` },
      null,
    );
  }

  const isDone = issue.status === "done" && config.captureOnDone;
  const isBlocked = issue.status === "blocked" && config.captureOnBlocked;

  if (!isDone && !isBlocked) return;

  // Dedup: check if we already captured for this status transition
  const stateKey = `captured-${issue.status}`;
  const alreadyCaptured = await ctx.state.get({
    scopeKind: "issue",
    scopeId: issueId,
    stateKey,
  });
  if (alreadyCaptured) {
    ctx.logger.info("Already captured for this status, skipping", {
      issueId,
      status: issue.status,
    });
    return;
  }

  const latestComment = await getLatestComment(ctx, issueId, event.companyId);
  const agentName = await resolveAgentName(
    ctx,
    issue.assigneeAgentId,
    event.companyId,
  );

  const thought = isDone
    ? buildDoneThought(issue, latestComment, agentName)
    : buildBlockedThought(issue, latestComment, agentName);

  await client.captureThought(thought);

  await ctx.state.set(
    { scopeKind: "issue", scopeId: issueId, stateKey },
    new Date().toISOString(),
  );

  ctx.logger.info("Captured thought for issue status change", {
    issueId,
    identifier: issue.identifier,
    status: issue.status,
  });
}

async function handleIssueCreated(
  ctx: PluginContext,
  client: OpenBrainClient,
  event: PluginEvent,
): Promise<void> {
  const config = await resolveConfig(ctx);
  if (!config.captureOnDelegation) return;

  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) return;

  // Delegation signal: has both parentId and assigneeAgentId
  if (!issue.parentId || !issue.assigneeAgentId) return;

  const assigneeName =
    (await resolveAgentName(ctx, issue.assigneeAgentId, event.companyId)) ??
    "unknown agent";

  let parentIssue: { identifier: string | null; title: string } | null = null;
  try {
    parentIssue = await ctx.issues.get(issue.parentId, event.companyId);
  } catch {
    // parent may not be accessible
  }

  const thought = buildDelegationThought(issue, parentIssue, assigneeName);
  await client.captureThought(thought);

  ctx.logger.info("Captured delegation thought", {
    issueId,
    identifier: issue.identifier,
    parentId: issue.parentId,
    assigneeAgentId: issue.assigneeAgentId,
  });
}

async function createClientFromConfig(ctx: PluginContext): Promise<{ client: OpenBrainClient; config: PluginConfig } | null> {
  const config = await resolveConfig(ctx);
  if (!config.openBrainEndpoint) return null;
  const client = createOpenBrainClient(ctx.http, ctx.logger, {
    endpoint: config.openBrainEndpoint,
    apiKey: config.openBrainApiKey,
  });
  return { client, config };
}

const plugin = definePlugin({
  async setup(ctx) {
    const config = await resolveConfig(ctx);

    if (!config.openBrainEndpoint) {
      ctx.logger.warn(
        "openBrainEndpoint not configured, plugin will not capture thoughts",
      );
      return;
    }

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      try {
        const resolved = await createClientFromConfig(ctx);
        if (!resolved) return;
        await handleIssueUpdated(ctx, resolved.client, event);
      } catch (err) {
        ctx.logger.error("Failed to handle issue.updated", {
          issueId: event.entityId,
          error: String(err),
        });
      }
    });

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      try {
        const resolved = await createClientFromConfig(ctx);
        if (!resolved) return;
        await handleIssueCreated(ctx, resolved.client, event);
      } catch (err) {
        ctx.logger.error("Failed to handle issue.created", {
          issueId: event.entityId,
          error: String(err),
        });
      }
    });

    ctx.data.register("health", async () => ({
      status: "ok",
      endpoint: config.openBrainEndpoint,
      captureOnDone: config.captureOnDone,
      captureOnBlocked: config.captureOnBlocked,
      captureOnDelegation: config.captureOnDelegation,
      checkedAt: new Date().toISOString(),
    }));

    ctx.logger.info("open-brain-capture plugin initialized", {
      endpoint: config.openBrainEndpoint,
      captureOnDone: config.captureOnDone,
      captureOnBlocked: config.captureOnBlocked,
      captureOnDelegation: config.captureOnDelegation,
    });
  },

  async onHealth() {
    return { status: "ok", message: "open-brain-capture worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
