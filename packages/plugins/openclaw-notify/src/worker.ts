import { definePlugin, runWorker, type PluginContext, type PluginEvent } from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginConfig {
  webhookUrl: string;
  webhookToken: string;
  notifyOnStatusChange: boolean;
  notifyOnComment: boolean;
  notifyOnBlock: boolean;
  dedupeWindowSeconds: number;
}

interface IssueUpdatedPayload {
  id?: string;
  identifier?: string;
  title?: string;
  status?: string;
  previousStatus?: string;
  _previous?: string;
  assigneeAgentId?: string | null;
  companyId?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface CommentCreatedPayload {
  id: string;
  issueId: string;
  content?: string;
  authorAgentId?: string | null;
  createdAt?: string;
}

interface DedupeEntry {
  lastNotifiedAt: number;
  lastKey: string;
}

// In-process dedupe map: issueId → last notification info
const dedupeMap = new Map<string, DedupeEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ATTENTION_KEYWORDS = [
  "needs your call",
  "needs jon",
  "approval",
  "decision",
  "blocked",
  "blocking",
  "your input",
  "waiting on you",
  "ready for review",
  "needs review",
  "please review",
  "done",
  "complete",
  "shipped",
];

function commentNeedsAttention(content: string): boolean {
  const lower = content.toLowerCase();
  return ATTENTION_KEYWORDS.some((kw) => lower.includes(kw));
}

function isDuplicate(issueId: string, key: string, windowSeconds: number): boolean {
  const entry = dedupeMap.get(issueId);
  if (!entry) return false;
  const ageMs = Date.now() - entry.lastNotifiedAt;
  return entry.lastKey === key && ageMs < windowSeconds * 1000;
}

function markNotified(issueId: string, key: string): void {
  dedupeMap.set(issueId, { lastNotifiedAt: Date.now(), lastKey: key });
}

async function getConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = (await ctx.config.get()) as Partial<PluginConfig>;
  return {
    webhookUrl: raw.webhookUrl ?? "http://127.0.0.1:18789/hooks/wake",
    webhookToken: raw.webhookToken ?? "",
    notifyOnStatusChange: raw.notifyOnStatusChange ?? true,
    notifyOnComment: raw.notifyOnComment ?? true,
    notifyOnBlock: raw.notifyOnBlock ?? true,
    dedupeWindowSeconds: raw.dedupeWindowSeconds ?? 30,
  };
}

async function fireWebhook(
  ctx: PluginContext,
  config: PluginConfig,
  text: string,
  mode: "now" | "next-heartbeat" = "now",
): Promise<void> {
  if (!config.webhookToken) {
    ctx.logger.warn("[openclaw-notify] webhookToken not configured — skipping notification");
    return;
  }

  try {
    const res = await ctx.http.fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.webhookToken}`,
      },
      body: JSON.stringify({ text, mode }),
    });

    if (res.status >= 200 && res.status < 300) {
      ctx.logger.info(`[openclaw-notify] Webhook fired OK: ${text.slice(0, 80)}`);
    } else {
      ctx.logger.warn(`[openclaw-notify] Webhook returned ${res.status} for: ${text.slice(0, 80)}`);
    }
  } catch (err) {
    ctx.logger.error(`[openclaw-notify] Webhook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleIssueUpdated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);
  const payload = event.payload as IssueUpdatedPayload;

  // event.entityId is the issue ID; payload has identifier, status, _previous
  const issueId = event.entityId ?? payload.id;
  const identifier = payload.identifier;
  const status = payload.status;
  const previousStatus = payload._previous ?? payload.previousStatus;

  if (!status || !issueId) return;

  // Fetch title from the issues API for a better notification message
  let issueTitle = "";
  try {
    const issue = await ctx.issues.get(issueId, event.companyId);
    issueTitle = issue?.title ? ` "${issue.title}"` : "";
  } catch {
    // Non-fatal
  }

  const issueRef = identifier ? `[${identifier}]` : `[${issueId.slice(0, 8)}]`;

  // ── Status changed ───────────────────────────────────────────────────────
  if (config.notifyOnStatusChange) {
    const changed = !previousStatus || status !== previousStatus;
    if (!changed) return;

    const dedupeKey = `status:${previousStatus ?? "??"}→${status}`;
    if (!isDuplicate(issueId, dedupeKey, config.dedupeWindowSeconds)) {
      markNotified(issueId, dedupeKey);

      const isBlocked = status === "blocked";
      const fromPart = previousStatus ? ` (was: ${previousStatus})` : "";
      const text = isBlocked
        ? `🚨 Paperclip BLOCKED: ${issueRef}${issueTitle} — needs immediate attention.`
        : `📌 Paperclip: ${issueRef}${issueTitle} → ${status}${fromPart}`;

      await fireWebhook(ctx, config, text, "now");
    }
  }
}

async function handleCommentCreated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const config = await getConfig(ctx);
  if (!config.notifyOnComment) return;

  const payload = event.payload as CommentCreatedPayload;
  const { issueId, content } = payload;

  if (!content || !commentNeedsAttention(content)) return;

  const dedupeKey = `comment:${payload.id}`;
  if (isDuplicate(issueId, dedupeKey, config.dedupeWindowSeconds)) return;
  markNotified(issueId, dedupeKey);

  // Try to get issue details for a better notification
  let issueRef = `[${issueId.slice(0, 8)}]`;
  let issueTitle = "";
  try {
    const issue = await ctx.issues.get(issueId, event.companyId);
    if (issue) {
      issueRef = issue.identifier ? `[${issue.identifier}]` : issueRef;
      issueTitle = issue.title ? ` "${issue.title}"` : "";
    }
  } catch {
    // Non-fatal — proceed with partial info
  }

  const preview = content.slice(0, 200).replace(/\n/g, " ");
  const text = `💬 Paperclip comment needs attention on ${issueRef}${issueTitle}: "${preview}"`;

  await fireWebhook(ctx, config, text, "now");
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("[openclaw-notify] Plugin setup — registering event handlers");

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      try {
        await handleIssueUpdated(ctx, event);
      } catch (err) {
        ctx.logger.error(`[openclaw-notify] Error handling issue.updated: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      try {
        await handleCommentCreated(ctx, event);
      } catch (err) {
        ctx.logger.error(`[openclaw-notify] Error handling issue.comment.created: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ctx.logger.info("[openclaw-notify] Event handlers registered — ready");
  },

  async onHealth() {
    return { status: "ok", message: "OpenClaw Notify plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
