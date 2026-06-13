import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";
import { GH_CLOSED_STATUSES, GH_EVENTS, LABEL_TO_PRIORITY, PRIORITY_TO_LABEL, WEBHOOK_KEYS } from "./constants.js";
import { verifyGitHubSignature } from "./verify.js";
import { isDuplicateDelivery, markOutboundEcho } from "./echo.js";
import {
  getIssueMapping,
  getIssueMappingReverse,
  setIssueMapping,
  getPrMapping,
  setPrMapping,
  getMilestoneMapping,
  setMilestoneMapping,
  markOutboundIssueEcho,
  consumeOutboundIssueEcho,
} from "./mapping.js";
import { createGitHubIssue, updateGitHubIssue, createGitHubComment, syncGitHubPriorityLabels } from "./github-api.js";

type GitHubConfig = {
  webhookSecret: string;
  githubTokenRef?: string;
  owner: string;
  repo: string;
  defaultProjectId?: string;
  triggerAgentIds?: string[];
  watchedRepos?: string[];
  prCreatesIssue?: boolean;
};

let currentContext: PluginContext | null = null;

async function getConfig(ctx: PluginContext): Promise<GitHubConfig> {
  return await ctx.config.get() as GitHubConfig;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

// ---------------------------------------------------------------------------
// Inbound: GitHub → Paperclip
// ---------------------------------------------------------------------------

async function handleIssuesEvent(
  ctx: PluginContext,
  config: GitHubConfig,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const action = readString(payload.action);
  const ghIssue = payload.issue as Record<string, unknown> | undefined;
  if (!ghIssue) return;

  const ghNumber = readNumber(ghIssue.number);
  if (ghNumber === null) return;

  const repository = payload.repository as Record<string, unknown> | undefined;
  const owner = readString((repository?.owner as Record<string, unknown> | undefined)?.login ?? config.owner);
  const repo = readString(repository?.name ?? config.repo);

  if (await isDuplicateDelivery(ctx, deliveryId)) return;

  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id;
  if (!companyId) return;

  if (action === "opened") {
    // Suppress issues:opened webhooks that we ourselves triggered by pushing to GitHub.
    // The outbound handler writes a marker keyed by owner/repo/ghNumber after a
    // successful createGitHubIssue call; we consume it here (single-use).
    if (await consumeOutboundIssueEcho(ctx, owner, repo, ghNumber)) {
      // Mapping was already stored by the outbound handler; nothing more to do.
      return;
    }
    const issue = await ctx.issues.create({
      companyId,
      projectId: config.defaultProjectId,
      title: readString(ghIssue.title),
      description: readString(ghIssue.body),
    });
    // Mark the new Paperclip issue ID so the outbound issue.created handler
    // skips pushing it back to GitHub (preventing a duplicate issue loop).
    await markOutboundEcho(ctx, issue.id);
    await setIssueMapping(ctx, owner, repo, ghNumber, issue.id);
    return;
  }

  const mapping = await getIssueMapping(ctx, owner, repo, ghNumber);
  if (!mapping) return;

  if (GH_CLOSED_STATUSES.has(action)) {
    await ctx.issues.update(mapping.paperclipIssueId, { status: "done" as Issue["status"] }, companyId);
    return;
  }

  if (action === "edited") {
    const patch: Partial<Pick<Issue, "title" | "description">> = {};
    if (ghIssue.title !== undefined) patch.title = readString(ghIssue.title);
    if (ghIssue.body !== undefined) patch.description = readString(ghIssue.body);
    await ctx.issues.update(mapping.paperclipIssueId, patch, companyId);
    return;
  }

  if (action === "labeled" || action === "unlabeled") {
    // Re-derive priority from the full label set on the issue (not just the event label)
    // to handle rapid label changes correctly.
    const labels = ghIssue.labels as Array<Record<string, unknown>> | undefined ?? [];
    const priorityLabel = labels.map(l => readString(l.name)).find(n => n in LABEL_TO_PRIORITY);
    const priority = priorityLabel ? LABEL_TO_PRIORITY[priorityLabel] as Issue["priority"] : null;
    await ctx.issues.update(mapping.paperclipIssueId, { priority }, companyId);
  }
}

async function handleIssueCommentEvent(
  ctx: PluginContext,
  config: GitHubConfig,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const action = readString(payload.action);
  if (action !== "created") return;

  const ghIssue = payload.issue as Record<string, unknown> | undefined;
  if (!ghIssue) return;

  const ghNumber = readNumber(ghIssue.number);
  if (ghNumber === null) return;

  const repository = payload.repository as Record<string, unknown> | undefined;
  const owner = readString((repository?.owner as Record<string, unknown> | undefined)?.login ?? config.owner);
  const repo = readString(repository?.name ?? config.repo);

  const comment = payload.comment as Record<string, unknown> | undefined;
  const body = readString(comment?.body);
  if (!body) return;

  if (await isDuplicateDelivery(ctx, deliveryId)) return;

  const mapping = await getIssueMapping(ctx, owner, repo, ghNumber);
  if (!mapping) return;

  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id;
  if (!companyId) return;

  const comment = await ctx.issues.createComment(mapping.paperclipIssueId, body, companyId);
  // Mark the new comment ID so the outbound issue.comment.created handler
  // suppresses it and avoids an infinite comment loop.
  if (comment?.id) {
    await markOutboundEcho(ctx, `outbound:${comment.id}`);
  }
}

async function handleMilestoneEvent(
  ctx: PluginContext,
  config: GitHubConfig,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const action = readString(payload.action);
  if (action !== "created" && action !== "edited" && action !== "closed" && action !== "deleted") return;

  const milestone = payload.milestone as Record<string, unknown> | undefined;
  if (!milestone) return;

  const milestoneNumber = readNumber(milestone.number);
  if (milestoneNumber === null) return;

  const repository = payload.repository as Record<string, unknown> | undefined;
  const owner = readString((repository?.owner as Record<string, unknown> | undefined)?.login ?? config.owner);
  const repo = readString(repository?.name ?? config.repo);

  if (await isDuplicateDelivery(ctx, deliveryId)) return;

  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id;
  if (!companyId) return;

  const title = readString(milestone.title);
  const description = readString(milestone.description);

  if (action === "created") {
    const goal = await ctx.goals.create({ companyId, title, description: description || undefined, level: "task" });
    await setMilestoneMapping(ctx, owner, repo, milestoneNumber, goal.id);
    return;
  }

  const mapping = await getMilestoneMapping(ctx, owner, repo, milestoneNumber);
  if (!mapping) return;

  if (action === "edited") {
    await ctx.goals.update(mapping.paperclipGoalId, { title, description: description || undefined }, companyId);
    return;
  }

  if (action === "closed") {
    await ctx.goals.update(mapping.paperclipGoalId, { status: "achieved" }, companyId);
    return;
  }

  if (action === "deleted") {
    await ctx.goals.update(mapping.paperclipGoalId, { status: "cancelled" }, companyId);
  }
}

async function handlePullRequestEvent(
  ctx: PluginContext,
  config: GitHubConfig,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  const action = readString(payload.action);
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr) return;

  const prNumber = readNumber(pr.number);
  if (prNumber === null) return;

  const repository = payload.repository as Record<string, unknown> | undefined;
  const owner = readString((repository?.owner as Record<string, unknown> | undefined)?.login ?? config.owner);
  const repo = readString(repository?.name ?? config.repo);

  if (await isDuplicateDelivery(ctx, deliveryId)) return;

  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id;
  if (!companyId) return;

  if (action === "opened") {
    if (!config.prCreatesIssue) return;
    const issue = await ctx.issues.create({
      companyId,
      projectId: config.defaultProjectId,
      title: readString(pr.title),
      description: readString(pr.body),
    });
    await setPrMapping(ctx, owner, repo, prNumber, issue.id);
    return;
  }

  const mapping = await getPrMapping(ctx, owner, repo, prNumber);
  if (!mapping) return;

  // closed with merged = done; closed without merged = also done (rejected/abandoned)
  if (action === "closed") {
    await ctx.issues.update(mapping.paperclipIssueId, { status: "done" as Issue["status"] }, companyId);
  }
}

async function handlePullRequestReviewEvent(
  ctx: PluginContext,
  config: GitHubConfig,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  if (await isDuplicateDelivery(ctx, deliveryId)) return;

  const repository = payload.repository as Record<string, unknown> | undefined;
  const repoFullName = readString(repository?.full_name);
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const prTitle = readString(pr?.title);

  const agentIds = config.triggerAgentIds ?? [];
  if (agentIds.length === 0) return;

  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id;
  if (!companyId) return;

  for (const agentId of agentIds) {
    await ctx.agents.invoke(agentId, companyId, {
      prompt: `GitHub pull_request_review: ${repoFullName} — ${prTitle}`,
      reason: "github:pull_request_review",
    });
  }
}

async function handlePushEvent(
  ctx: PluginContext,
  config: GitHubConfig,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  if (await isDuplicateDelivery(ctx, deliveryId)) return;

  const repository = payload.repository as Record<string, unknown> | undefined;
  const repoFullName = readString(repository?.full_name);
  const ref = readString(payload.ref);

  const agentIds = config.triggerAgentIds ?? [];
  if (agentIds.length === 0) return;

  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id;
  if (!companyId) return;

  for (const agentId of agentIds) {
    await ctx.agents.invoke(agentId, companyId, {
      prompt: `GitHub push: ${repoFullName} — ${ref}`,
      reason: "github:push",
    });
  }
}

// ---------------------------------------------------------------------------
// Outbound: Paperclip → GitHub
// ---------------------------------------------------------------------------

async function registerOutboundHandlers(ctx: PluginContext): Promise<void> {
  ctx.events.on("issue.created", async (event: PluginEvent) => {
    const config = await getConfig(ctx);
    if (!config.githubTokenRef) return;

    const payload = event.payload as Record<string, unknown>;
    const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
    if (!issueId) return;

    // Suppress echoes from inbound GitHub events
    if (await isDuplicateDelivery(ctx, issueId)) return;

    const issue = await ctx.issues.get(issueId, event.companyId);
    if (!issue) return;

    const token = await ctx.secrets.resolve(config.githubTokenRef);

    const ghIssue = await createGitHubIssue(ctx, token, config.owner, config.repo, {
      title: issue.title,
      body: issue.description ?? undefined,
    });

    // Mark echo AFTER a successful API call so that a failed call does not
    // silently block retries (BUG 3 fix). The key is owner/repo/ghNumber so
    // the inbound handler can match it by the real GitHub issue number (BUG 1 fix).
    await markOutboundIssueEcho(ctx, config.owner, config.repo, ghIssue.number);

    // Store reverse mapping so updates can find the GH issue number
    await setIssueMapping(ctx, config.owner, config.repo, ghIssue.number, issueId);
  });

  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    const config = await getConfig(ctx);
    if (!config.githubTokenRef) return;

    const payload = event.payload as Record<string, unknown>;
    const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
    if (!issueId) return;

    if (await isDuplicateDelivery(ctx, `outbound:${issueId}`)) return;

    const issue = await ctx.issues.get(issueId, event.companyId);
    if (!issue) return;

    const reverse = await getIssueMappingReverse(ctx, issueId);
    if (!reverse) return; // Issue not synced to GitHub — skip silently.

    const token = await ctx.secrets.resolve(config.githubTokenRef);
    const patch: { title?: string; body?: string; state?: "open" | "closed" } = {
      title: issue.title,
      body: issue.description ?? undefined,
    };
    if (issue.status === "done") patch.state = "closed";

    await updateGitHubIssue(ctx, token, reverse.owner, reverse.repo, reverse.ghNumber, patch);

    // Sync priority label if present
    const priorityLabel = issue.priority ? PRIORITY_TO_LABEL[issue.priority] ?? null : null;
    await syncGitHubPriorityLabels(ctx, token, reverse.owner, reverse.repo, reverse.ghNumber, priorityLabel);
  });

  ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
    const config = await getConfig(ctx);
    if (!config.githubTokenRef) return;

    const payload = event.payload as Record<string, unknown>;
    const commentId = typeof payload.commentId === "string" ? payload.commentId : null;
    const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
    const body = typeof payload.body === "string" ? payload.body : null;
    if (!commentId || !issueId || !body) return;

    if (await isDuplicateDelivery(ctx, `outbound:${commentId}`)) return;

    const reverse = await getIssueMappingReverse(ctx, issueId);
    if (!reverse) return; // Issue not synced to GitHub — skip silently.

    const token = await ctx.secrets.resolve(config.githubTokenRef);
    await createGitHubComment(ctx, token, reverse.owner, reverse.repo, reverse.ghNumber, body);
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    await registerOutboundHandlers(ctx);
  },

  async onHealth() {
    return { status: "ok", message: "GitHub connector ready" };
  },

  async onValidateConfig(config) {
    const typed = config as Partial<GitHubConfig>;
    const errors: string[] = [];

    if (!typed.webhookSecret || typed.webhookSecret.trim().length === 0) {
      errors.push("webhookSecret is required");
    }
    if (!typed.owner || typed.owner.trim().length === 0) {
      errors.push("owner is required");
    }
    if (!typed.repo || typed.repo.trim().length === 0) {
      errors.push("repo is required");
    }

    return { ok: errors.length === 0, errors, warnings: [] };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEYS.github) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }

    const ctx = currentContext;
    if (!ctx) throw new Error("Plugin context not initialised");

    const config = await getConfig(ctx);

    // Verify HMAC-SHA256 signature before any processing
    const signature = readString(input.headers?.["x-hub-signature-256"]);
    if (!verifyGitHubSignature(input.rawBody, config.webhookSecret, signature)) {
      // Do not log the payload on invalid signature
      ctx.logger.warn("GitHub webhook: signature verification failed — delivery rejected");
      return;
    }

    const event = readString(input.headers?.["x-github-event"]);
    const deliveryId = readString(input.headers?.["x-github-delivery"] ?? input.requestId);
    const payload = input.parsedBody as Record<string, unknown> ?? {};

    // Repository filter: if watchedRepos is configured, only process matching repos
    const watchedRepos = config.watchedRepos ?? [];
    if (watchedRepos.length > 0) {
      const repository = payload.repository as Record<string, unknown> | undefined;
      const fullName = readString(repository?.full_name);
      if (!watchedRepos.includes(fullName)) return;
    }

    switch (event) {
      case GH_EVENTS.issues:
        await handleIssuesEvent(ctx, config, payload, deliveryId);
        break;
      case GH_EVENTS.issueComment:
        await handleIssueCommentEvent(ctx, config, payload, deliveryId);
        break;
      case GH_EVENTS.milestone:
        await handleMilestoneEvent(ctx, config, payload, deliveryId);
        break;
      case GH_EVENTS.pullRequest:
        await handlePullRequestEvent(ctx, config, payload, deliveryId);
        break;
      case GH_EVENTS.pullRequestReview:
        await handlePullRequestReviewEvent(ctx, config, payload, deliveryId);
        break;
      case GH_EVENTS.push:
        await handlePushEvent(ctx, config, payload, deliveryId);
        break;
      default:
        ctx.logger.info(`GitHub connector: ignoring unhandled event "${event}"`);
    }
  },

  async onShutdown() {
    currentContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
