import { definePlugin, type PluginEvent, type PluginContext } from "@paperclipai/plugin-sdk";

import { HonchoClient, peerIdForComment, sessionIdForIssue } from "./honcho.js";
import { PLUGIN_ID } from "./manifest.js";

interface InstanceConfig {
  honchoBaseUrl: string;
  honchoWorkspace: string;
  honchoApiToken?: string;
}

async function readConfig(ctx: PluginContext): Promise<InstanceConfig> {
  const raw = (await ctx.config.get().catch(() => ({}))) as Partial<InstanceConfig>;
  return {
    honchoBaseUrl: raw.honchoBaseUrl ?? "http://agentic-honcho-api:8000",
    honchoWorkspace: raw.honchoWorkspace ?? "ordillect-brain",
    honchoApiToken: raw.honchoApiToken,
  };
}

const worker = definePlugin({
  async setup(ctx) {
    const cfg = await readConfig(ctx);
    const honcho = new HonchoClient({
      baseUrl: cfg.honchoBaseUrl,
      workspace: cfg.honchoWorkspace,
      token: cfg.honchoApiToken,
    });

    // Ensure the target workspace exists on boot. Idempotent.
    await honcho.ensureWorkspace().catch((err) => {
      ctx.logger.error("brain-mirror: workspace ensure failed", { error: String(err) });
    });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      try {
        await mirrorComment(ctx, honcho, event);
      } catch (err) {
        ctx.logger.error("brain-mirror: mirror failed", {
          error: String(err),
          eventId: event.eventId,
        });
      }
    });

    ctx.logger.info("brain-mirror: subscribed to issue.comment.created", {
      workspace: cfg.honchoWorkspace,
    });
  },
});

async function mirrorComment(
  ctx: PluginContext,
  honcho: HonchoClient,
  event: PluginEvent,
): Promise<void> {
  const issueId = event.entityId;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const commentId = typeof payload.commentId === "string" ? payload.commentId : undefined;
  if (!issueId || !commentId) return;

  const comments = await ctx.issues.listComments(issueId, event.companyId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  const sessionId = sessionIdForIssue(issueId);
  const peerId = peerIdForComment({
    authorType: comment.authorType,
    authorAgentId: comment.authorAgentId,
    authorUserId: comment.authorUserId,
  });

  await honcho.ensureSession(sessionId, {
    issue_id: issueId,
    issue_identifier: issue?.identifier ?? null,
    issue_title: issue?.title ?? null,
    plugin: PLUGIN_ID,
  });
  await honcho.ensurePeer(peerId, {
    source: PLUGIN_ID,
    author_type: comment.authorType ?? null,
    author_agent_id: comment.authorAgentId ?? null,
    author_user_id: comment.authorUserId ?? null,
  });
  await honcho.addSessionPeers(sessionId, [peerId]);

  await honcho.postMessage(sessionId, {
    peerId,
    content: comment.body,
    metadata: {
      paperclip_comment_id: comment.id,
      paperclip_issue_id: issueId,
      paperclip_issue_identifier: issue?.identifier ?? null,
      created_at: comment.createdAt instanceof Date
        ? comment.createdAt.toISOString()
        : String(comment.createdAt ?? ""),
      author_type: comment.authorType ?? null,
      run_id: comment.createdByRunId ?? null,
    },
  });

  ctx.logger.info("brain-mirror: mirrored comment", {
    issueId,
    sessionId,
    peerId,
    commentId,
  });
}

export default worker;
