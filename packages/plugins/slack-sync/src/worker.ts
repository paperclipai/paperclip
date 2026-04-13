import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginJobContext,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import { SlackClient } from "./slack-client.js";
import { WEBHOOK_KEY, JOB_KEY } from "./manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlackSyncConfig {
  slackBotToken?: string;
  channelPrefix?: string;
  inviteUserIds?: string[];
}

// State keys (scoped to project or issue)
const STATE = {
  channelId: "slack-channel-id",
  messageTs: "slack-message-ts",
  contextMessageTs: "slack-context-message-ts",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ctx: PluginContext | null = null;

async function getSlack(): Promise<{ client: SlackClient; prefix: string }> {
  if (!ctx) throw new Error("Plugin not initialized");
  const config = (await ctx.config.get()) as SlackSyncConfig;
  if (!config.slackBotToken) throw new Error("slackBotToken not configured");
  // Support both direct token and secret ref
  const token = config.slackBotToken.startsWith("xoxb-")
    ? config.slackBotToken
    : await ctx.secrets.resolve(config.slackBotToken);
  return {
    client: new SlackClient(token),
    prefix: config.channelPrefix ?? "proj-",
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60); // Slack channel name limit is 80 chars
}

function issueStatusEmoji(status: string): string {
  switch (status) {
    case "todo":
      return "\u{1f4cb}"; // clipboard
    case "in_progress":
      return "\u{1f6a7}"; // construction
    case "in_review":
      return "\u{1f50d}"; // magnifying glass
    case "done":
      return "\u2705"; // check mark
    case "cancelled":
      return "\u274c"; // cross mark
    default:
      return "\u{1f4a0}"; // diamond
  }
}

function formatSlackQuote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function formatIssueAnchorMessage(issue: {
  title: string;
}): string {
  return issue.title.replace(/\s+/g, " ").trim();
}

function formatIssueThreadMessage(issue: {
  identifier: string;
  title: string;
  status: string;
  priority: string;
  description?: string | null;
}, opts?: { heading?: string }): string {
  const emoji = issueStatusEmoji(issue.status);
  const lines = opts?.heading ? [opts.heading] : [];
  lines.push(
    `${emoji} *${issue.identifier}* — ${issue.title}`,
    `Status: \`${issue.status}\` | Priority: \`${issue.priority}\``,
  );
  if (issue.description) {
    lines.push("*Description*", formatSlackQuote(issue.description));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Ensure a Slack channel exists for a project (idempotent)
// ---------------------------------------------------------------------------

async function ensureProjectChannel(
  projectId: string,
  projectName: string,
  projectUrlKey: string,
  companyId: string,
): Promise<string> {
  if (!ctx) throw new Error("Plugin not initialized");
  const { client, prefix } = await getSlack();

  // Check if we already have a channel ID stored
  const existing = await ctx.state.get({
    scopeKind: "project",
    scopeId: projectId,
    stateKey: STATE.channelId,
  });
  if (typeof existing === "string") return existing;

  // Try to find or create the channel
  const channelName = `${prefix}${slugify(projectUrlKey || projectName)}`;

  let channel = await client.findChannel(channelName);
  if (!channel) {
    channel = await client.createChannel(channelName);
    ctx.logger.info("Created Slack channel", {
      channelId: channel.id,
      channelName,
      projectId,
    });
  }

  // Set topic
  await client.setTopic(
    channel.id,
    `Paperclip project: ${projectName}`,
  );

  // Auto-invite configured users
  const config = (await ctx.config.get()) as SlackSyncConfig;
  if (config.inviteUserIds && config.inviteUserIds.length > 0) {
    await client.inviteUsers(channel.id, config.inviteUserIds);
  }

  // Persist mapping
  await ctx.state.set(
    { scopeKind: "project", scopeId: projectId, stateKey: STATE.channelId },
    channel.id,
  );

  return channel.id;
}

// ---------------------------------------------------------------------------
// Render project context as Slack message body
// ---------------------------------------------------------------------------

function renderContextMessage(project: {
  name: string;
  description?: string | null;
  context?: string | null;
}): string {
  const lines = [
    `:pushpin: *Project Context — ${project.name}*`,
    "_由 Paperclip 自動同步；編輯請在 Slack @maltbot 請它改，或直接改 Paperclip UI_",
    "",
  ];
  if (project.description) {
    lines.push(project.description);
    lines.push("");
  }
  if (project.context) {
    lines.push(project.context);
  } else {
    lines.push("_(尚未設定 context)_");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sync project context to the Slack channel's pinned message
// Idempotent: creates on first call, updates on subsequent calls.
// ---------------------------------------------------------------------------

async function syncContextPin(
  projectId: string,
  companyId: string,
): Promise<void> {
  if (!ctx) throw new Error("Plugin not initialized");

  const project = await ctx.projects.get(projectId, companyId);
  if (!project) return;

  const channelId = (await ctx.state.get({
    scopeKind: "project",
    scopeId: projectId,
    stateKey: STATE.channelId,
  })) as string | null;
  if (!channelId) return; // no channel bound yet

  const body = renderContextMessage(
    project as unknown as Parameters<typeof renderContextMessage>[0],
  );
  const { client } = await getSlack();

  const existingTs = (await ctx.state.get({
    scopeKind: "project",
    scopeId: projectId,
    stateKey: STATE.contextMessageTs,
  })) as string | null;

  if (existingTs) {
    try {
      ctx.logger.info("Context pin updating", {
        projectId,
        channelId,
        existingTs,
        bodyBytes: Buffer.byteLength(body, "utf8"),
      });
      await client.updateMessage(channelId, existingTs, body);
      ctx.logger.info("Context pin updated", { projectId, channelId });
      return;
    } catch (e) {
      // message may have been deleted — fall through to repost
      ctx.logger.warn("Context pin update failed; will repost", {
        projectId,
        channelId,
        existingTs,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const msg = await client.postMessage(channelId, body);
  const pinned = await client.pinMessage(channelId, msg.ts);
  if (!pinned) {
    ctx.logger.warn(
      "pins.add failed (likely missing pins:write scope); context message posted but not pinned",
      { projectId, channelId, ts: msg.ts },
    );
  }
  await ctx.state.set(
    {
      scopeKind: "project",
      scopeId: projectId,
      stateKey: STATE.contextMessageTs,
    },
    msg.ts,
  );
  ctx.logger.info("Context pin created", { projectId, channelId, ts: msg.ts });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(context) {
    ctx = context;
    ctx.logger.info("slack-sync plugin setup");

    // ----- project.created -----
    ctx.events.on("project.created", async (event: PluginEvent) => {
      const projectId = event.entityId;
      const companyId = event.companyId;
      if (!projectId || !companyId) return;

      const project = await ctx!.projects.get(projectId, companyId);
      if (!project) return;

      const channelId = await ensureProjectChannel(
        projectId,
        project.name,
        (project as unknown as Record<string, unknown>).urlKey as string ?? project.name,
        companyId,
      );

      ctx!.logger.info("project.created → Slack channel ready", {
        projectId,
        channelId,
      });

      // Post + pin the context message so the channel has a canonical
      // "what is this project about" anchor that stays in sync with Paperclip.
      try {
        await syncContextPin(projectId, companyId);
      } catch (e) {
        ctx!.logger.warn("project.created: syncContextPin failed", {
          projectId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });

    // ----- project.updated -----
    ctx.events.on("project.updated", async (event: PluginEvent) => {
      const projectId = event.entityId;
      const companyId = event.companyId;
      if (!projectId || !companyId) return;

      // Only re-render if fields that appear in the pinned message changed.
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const touched =
        "context" in payload || "description" in payload || "name" in payload;
      if (!touched) return;

      try {
        await syncContextPin(projectId, companyId);
      } catch (e) {
        ctx!.logger.warn("project.updated: syncContextPin failed", {
          projectId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });

    // ----- issue.created -----
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;

      const issue = await ctx!.issues.get(issueId, companyId);
      if (!issue || !issue.projectId) return;

      // Idempotency: if we've already posted a thread anchor for this issue, skip.
      const existingTs = (await ctx!.state.get({
        scopeKind: "issue",
        scopeId: issueId,
        stateKey: STATE.messageTs,
      })) as string | null;
      if (existingTs) {
        ctx!.logger.info("issue.created → skip, anchor already posted", {
          issueId,
          existingTs,
        });
        return;
      }

      // Get project channel
      const channelId = (await ctx!.state.get({
        scopeKind: "project",
        scopeId: issue.projectId,
        stateKey: STATE.channelId,
      })) as string | null;
      if (!channelId) return; // Project has no Slack channel

      const { client } = await getSlack();
      const msg = await client.postMessage(
        channelId,
        formatIssueAnchorMessage(issue as unknown as Parameters<typeof formatIssueAnchorMessage>[0]),
      );

      const pinned = await client.pinMessage(channelId, msg.ts);
      if (!pinned) {
        ctx!.logger.warn(
          "pins.add failed (likely missing pins:write scope); issue message posted but not pinned",
          { issueId, channelId, ts: msg.ts },
        );
      }

      // Store message ts for future updates
      await ctx!.state.set(
        { scopeKind: "issue", scopeId: issueId, stateKey: STATE.messageTs },
        `${channelId}:${msg.ts}`,
      );

      await client.postMessage(
        channelId,
        formatIssueThreadMessage(
          issue as unknown as Parameters<typeof formatIssueThreadMessage>[0],
        ),
        { threadTs: msg.ts },
      );

      ctx!.logger.info("issue.created → posted pinned title anchor", {
        issueId,
        channelId,
        ts: msg.ts,
      });
    });

    // ----- issue.updated -----
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;

      const stored = (await ctx!.state.get({
        scopeKind: "issue",
        scopeId: issueId,
        stateKey: STATE.messageTs,
      })) as string | null;
      if (!stored) return;

      const [channelId, messageTs] = stored.split(":");
      if (!channelId || !messageTs) return;

      const issue = await ctx!.issues.get(issueId, companyId);
      if (!issue) return;

      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const titleChanged = "title" in payload;

      const { client } = await getSlack();
      if (titleChanged) {
        await client.updateMessage(
          channelId,
          messageTs,
          formatIssueAnchorMessage(issue as unknown as Parameters<typeof formatIssueAnchorMessage>[0]),
        );
      }

      await client.postMessage(
        channelId,
        formatIssueThreadMessage(
          issue as unknown as Parameters<typeof formatIssueThreadMessage>[0],
          { heading: ":memo: Issue updated" },
        ),
        { threadTs: messageTs },
      );

      ctx!.logger.info("issue.updated → synced to Slack thread", {
        issueId,
        channelId,
        titleChanged,
      });

      // Notify the originating Slack thread when issue is marked done
      const statusChangedToDone =
        issue.status === "done" && payload._previous &&
        (payload._previous as Record<string, unknown>).status !== "done";
      if (statusChangedToDone) {
        const meta = (issue as unknown as Record<string, unknown>).metadata as
          | Record<string, unknown>
          | null
          | undefined;
        const sourceChannel = meta?.sourceChannel as string | undefined;
        const sourceThreadTs = meta?.sourceThreadTs as string | undefined;
        if (sourceChannel && sourceThreadTs) {
          await client.postMessage(
            sourceChannel,
            `✅ ${(issue as unknown as { identifier: string }).identifier} ${issue.title} 已完成`,
            { threadTs: sourceThreadTs },
          );
          ctx!.logger.info("issue.updated → done notification sent to source thread", {
            issueId,
            sourceChannel,
            sourceThreadTs,
          });
        }
      }
    });

    // ----- issue.comment.created -----
    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      const issueId = event.entityId;
      const companyId = event.companyId;
      if (!issueId || !companyId) return;

      const stored = (await ctx!.state.get({
        scopeKind: "issue",
        scopeId: issueId,
        stateKey: STATE.messageTs,
      })) as string | null;
      if (!stored) return;

      const [channelId, messageTs] = stored.split(":");
      if (!channelId || !messageTs) return;

      // Get the latest comment
      const comments = await ctx!.issues.listComments(issueId, companyId);
      const latest = comments[comments.length - 1];
      if (!latest) return;

      const { client } = await getSlack();
      await client.postMessage(channelId, latest.body, {
        threadTs: messageTs,
      });

      ctx!.logger.info("issue.comment.created → thread reply", {
        issueId,
        channelId,
      });
    });

    // ----- Init sync job -----
    ctx.jobs.register(JOB_KEY, async (_job: PluginJobContext) => {
      ctx!.logger.info("Running initial sync — scanning all projects");

      // Use companyId from the most recent event or config.
      // For init sync, list projects without company filter (SDK supports it).
      const config = (await ctx!.config.get()) as SlackSyncConfig & { companyId?: string };
      const companyId = config.companyId ?? "15653bc9-07c7-44c3-bd19-5e67ba0e9ff5";

      const projects = await ctx!.projects.list({ companyId });

      let created = 0;
      let skipped = 0;

      for (const project of projects) {
        const existing = await ctx!.state.get({
          scopeKind: "project",
          scopeId: project.id,
          stateKey: STATE.channelId,
        });
        if (existing) {
          skipped++;
          continue;
        }

        await ensureProjectChannel(
          project.id,
          project.name,
          (project as unknown as Record<string, unknown>).urlKey as string ?? project.name,
          companyId,
        );
        created++;
      }

      ctx!.logger.info("Initial sync complete", { created, skipped });
    });
  },

  // ----- Slack Events webhook -----
  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_KEY) {
      throw new Error(`Unknown webhook endpoint: ${input.endpointKey}`);
    }

    const body = input.parsedBody as Record<string, unknown> | undefined;
    if (!body) return;

    // Slack URL verification challenge
    if (body.type === "url_verification") {
      // The plugin webhook system should return the challenge.
      // For now, log it — Paperclip's webhook handler may need adjustment.
      ctx?.logger.info("Slack URL verification", {
        challenge: body.challenge,
      });
      return;
    }

    // Event callback — app_mention handling is delegated to OpenClaw Slack
    // adapter (channel-pm). This plugin now only handles url_verification.
    if (body.type !== "event_callback") return;
    return;
  },

  async onHealth() {
    return { status: "ok", message: "slack-sync plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
