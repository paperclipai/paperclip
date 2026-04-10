import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./manifest.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface BoardNotifyConfig {
  resendApiKeyRef: string;
  fromAddress: string;
  toAddress: string;
  notifyOnAssign: boolean;
  notifyOnBlocked: boolean;
  paperclipBaseUrl: string;
}

const DEFAULT_CONFIG: BoardNotifyConfig = {
  resendApiKeyRef: "",
  fromAddress: "paperclip@notify.digerstudios.com",
  toAddress: "rudy@digerstudios.com",
  notifyOnAssign: true,
  notifyOnBlocked: true,
  paperclipBaseUrl: "",
};

interface IssueContext {
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  latestComment: string;
  commentAuthor: string;
  issueUrl: string;
}

async function getConfig(ctx: PluginContext): Promise<BoardNotifyConfig> {
  const raw = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(raw as Partial<BoardNotifyConfig>) };
}

// ---------------------------------------------------------------------------
// Resend helper
// ---------------------------------------------------------------------------

async function sendEmail(
  ctx: PluginContext,
  config: BoardNotifyConfig,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!config.resendApiKeyRef) {
    ctx.logger.warn("No Resend API key configured — skipping notification");
    return false;
  }

  let apiKey: string;
  try {
    apiKey = await ctx.secrets.resolve(config.resendApiKeyRef);
  } catch (err) {
    ctx.logger.error("Failed to resolve Resend API key secret", { err: String(err) });
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.fromAddress,
        to: [config.toAddress],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      ctx.logger.error("Resend API returned an error", { status: res.status, body });
      return false;
    }

    ctx.logger.info("Notification email sent", { to: config.toAddress, subject });
    return true;
  } catch (err) {
    ctx.logger.error("Failed to send email via Resend", { err: String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Issue context fetcher
// ---------------------------------------------------------------------------

async function fetchIssueContext(
  ctx: PluginContext,
  event: PluginEvent,
  config: BoardNotifyConfig,
): Promise<IssueContext> {
  const p = event.payload as Record<string, unknown>;
  const identifier = (p.identifier as string) ?? "";
  const prefix = identifier.split("-")[0] ?? "";

  // Build issue URL
  const baseUrl = config.paperclipBaseUrl.replace(/\/+$/, "");
  const issueUrl = baseUrl ? `${baseUrl}/${prefix}/issues/${identifier}` : "";

  // Fetch full issue and latest comment
  let title = (p.title as string) ?? identifier;
  let description = "";
  let status = (p.status as string) ?? "unknown";
  let priority = (p.priority as string) ?? "";
  let latestComment = "";
  let commentAuthor = "";

  try {
    const issue = await ctx.issues.get(event.entityId ?? "", event.companyId);
    if (issue) {
      title = issue.title || title;
      description = (issue.description ?? "").slice(0, 500);
      status = issue.status || status;
      priority = issue.priority || priority;
    }
  } catch {
    ctx.logger.warn("Could not fetch issue details for notification", {});
  }

  try {
    const comments = await ctx.issues.listComments(event.entityId ?? "", event.companyId);
    if (comments.length > 0) {
      const last = comments[comments.length - 1]!;
      latestComment = (last.body ?? "").slice(0, 800);
      commentAuthor = last.authorAgentId
        ? `Agent ${last.authorAgentId.slice(0, 8)}`
        : last.authorUserId
          ? "Board"
          : "System";
    }
  } catch {
    ctx.logger.warn("Could not fetch comments for notification", {});
  }

  return { identifier, title, description, status, priority, latestComment, commentAuthor, issueUrl };
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

const STYLES = {
  wrapper: 'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;',
  heading: 'margin: 0 0 16px; font-size: 20px; font-weight: 600;',
  table: 'border-collapse: collapse; width: 100%; margin-bottom: 16px;',
  labelCell: 'padding: 6px 12px 6px 0; color: #666; font-size: 14px; vertical-align: top; white-space: nowrap;',
  valueCell: 'padding: 6px 0; font-size: 14px;',
  commentBox: 'background: #f5f5f5; border-left: 3px solid #d1d5db; padding: 12px 16px; margin: 16px 0; border-radius: 4px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;',
  commentAuthor: 'font-weight: 600; margin-bottom: 4px; font-size: 13px; color: #444;',
  button: 'display: inline-block; background: #111; color: #fff; padding: 10px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px; margin-top: 8px;',
  footer: 'color: #999; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;',
  priorityBadge: (p: string) => {
    const colors: Record<string, string> = {
      critical: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#65a30d',
    };
    const bg = colors[p] ?? '#888';
    return `display: inline-block; background: ${bg}; color: #fff; padding: 2px 8px; border-radius: 3px; font-size: 12px; font-weight: 500; text-transform: uppercase;`;
  },
} as const;

function stripMarkdownLinks(md: string): string {
  return md.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + '…';
}

function assignedEmailHtml(ic: IssueContext): string {
  return `
    <div style="${STYLES.wrapper}">
      <h2 style="${STYLES.heading}">📋 Issue assigned to you</h2>
      <table style="${STYLES.table}">
        <tr><td style="${STYLES.labelCell}">Issue</td><td style="${STYLES.valueCell}"><strong>${escapeHtml(ic.identifier)}</strong></td></tr>
        <tr><td style="${STYLES.labelCell}">Title</td><td style="${STYLES.valueCell}">${escapeHtml(ic.title)}</td></tr>
        <tr><td style="${STYLES.labelCell}">Status</td><td style="${STYLES.valueCell}">${escapeHtml(ic.status)}</td></tr>
        ${ic.priority ? `<tr><td style="${STYLES.labelCell}">Priority</td><td style="${STYLES.valueCell}"><span style="${STYLES.priorityBadge(ic.priority)}">${escapeHtml(ic.priority)}</span></td></tr>` : ''}
      </table>
      ${ic.description ? `<p style="font-size: 14px; color: #444; line-height: 1.5; margin: 0 0 16px;">${escapeHtml(truncate(stripMarkdownLinks(ic.description), 300))}</p>` : ''}
      ${ic.latestComment ? `
        <div style="margin-bottom: 16px;">
          <div style="${STYLES.commentAuthor}">Latest from ${escapeHtml(ic.commentAuthor)}:</div>
          <div style="${STYLES.commentBox}">${escapeHtml(truncate(stripMarkdownLinks(ic.latestComment), 600))}</div>
        </div>
      ` : ''}
      ${ic.issueUrl ? `<a href="${escapeHtml(ic.issueUrl)}" style="${STYLES.button}">View Issue →</a>` : ''}
      <p style="${STYLES.footer}">Paperclip Board Notifications</p>
    </div>
  `;
}

function blockedEmailHtml(ic: IssueContext): string {
  return `
    <div style="${STYLES.wrapper}">
      <h2 style="${STYLES.heading}">⚠️ Board action needed</h2>
      <table style="${STYLES.table}">
        <tr><td style="${STYLES.labelCell}">Issue</td><td style="${STYLES.valueCell}"><strong>${escapeHtml(ic.identifier)}</strong></td></tr>
        <tr><td style="${STYLES.labelCell}">Title</td><td style="${STYLES.valueCell}">${escapeHtml(ic.title)}</td></tr>
        ${ic.priority ? `<tr><td style="${STYLES.labelCell}">Priority</td><td style="${STYLES.valueCell}"><span style="${STYLES.priorityBadge(ic.priority)}">${escapeHtml(ic.priority)}</span></td></tr>` : ''}
      </table>
      ${ic.latestComment ? `
        <div style="margin-bottom: 16px;">
          <div style="${STYLES.commentAuthor}">Latest from ${escapeHtml(ic.commentAuthor)}:</div>
          <div style="${STYLES.commentBox}">${escapeHtml(truncate(stripMarkdownLinks(ic.latestComment), 600))}</div>
        </div>
      ` : ''}
      ${ic.issueUrl ? `<a href="${escapeHtml(ic.issueUrl)}" style="${STYLES.button}">View Issue →</a>` : ''}
      <p style="${STYLES.footer}">Paperclip Board Notifications</p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function isAssignedToUser(event: PluginEvent): boolean {
  const p = event.payload as Record<string, unknown>;
  // assigneeUserId is set and changed from previous value
  if (!p.assigneeUserId) return false;
  const prev = p._previous as Record<string, unknown> | undefined;
  if (!prev) return false;
  return prev.assigneeUserId !== p.assigneeUserId;
}

function isNewlyBlocked(event: PluginEvent): boolean {
  const p = event.payload as Record<string, unknown>;
  if (p.status !== "blocked") return false;
  const prev = p._previous as Record<string, unknown> | undefined;
  if (!prev) return false;
  return prev.status !== "blocked";
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info(`${PLUGIN_ID} setup complete`);

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const config = await getConfig(ctx);

      // 1. Issue assigned to board user
      if (config.notifyOnAssign && isAssignedToUser(event)) {
        const ic = await fetchIssueContext(ctx, event, config);
        await sendEmail(
          ctx,
          config,
          `[Paperclip] ${ic.identifier} assigned to you — ${truncate(ic.title, 60)}`,
          assignedEmailHtml(ic),
        );
      }

      // 2. Issue newly blocked — board action may be needed
      if (config.notifyOnBlocked && isNewlyBlocked(event)) {
        const ic = await fetchIssueContext(ctx, event, config);
        await sendEmail(
          ctx,
          config,
          `[Paperclip] ⚠ ${ic.identifier} blocked — ${truncate(ic.title, 60)}`,
          blockedEmailHtml(ic),
        );
      }
    });

    // Also catch new issues created directly assigned to a user
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const config = await getConfig(ctx);
      if (!config.notifyOnAssign) return;

      const p = event.payload as Record<string, unknown>;
      if (!p.assigneeUserId) return;

      const ic = await fetchIssueContext(ctx, event, config);
      await sendEmail(
        ctx,
        config,
        `[Paperclip] ${ic.identifier} assigned to you — ${truncate(ic.title, 60)}`,
        assignedEmailHtml(ic),
      );
    });
  },

  async onHealth() {
    return { status: "ok", message: "Board notify plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
