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
}

const DEFAULT_CONFIG: BoardNotifyConfig = {
  resendApiKeyRef: "",
  fromAddress: "paperclip@notify.digerstudios.com",
  toAddress: "rudy@digerstudios.com",
  notifyOnAssign: true,
  notifyOnBlocked: true,
};

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
// Email templates
// ---------------------------------------------------------------------------

function assignedEmailHtml(event: PluginEvent): string {
  const p = event.payload as Record<string, unknown>;
  const identifier = (p.identifier as string) ?? "";
  const title = (p.title as string) ?? identifier;
  const status = (p.status as string) ?? "unknown";
  const priority = (p.priority as string) ?? "";

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px;">
      <h2 style="margin: 0 0 8px;">Issue assigned to you</h2>
      <table style="border-collapse: collapse; width: 100%; margin-bottom: 16px;">
        <tr><td style="padding: 4px 8px; color: #666;">Issue</td><td style="padding: 4px 8px; font-weight: 600;">${identifier}</td></tr>
        <tr><td style="padding: 4px 8px; color: #666;">Title</td><td style="padding: 4px 8px;">${escapeHtml(title)}</td></tr>
        <tr><td style="padding: 4px 8px; color: #666;">Status</td><td style="padding: 4px 8px;">${status}</td></tr>
        ${priority ? `<tr><td style="padding: 4px 8px; color: #666;">Priority</td><td style="padding: 4px 8px;">${priority}</td></tr>` : ""}
      </table>
      <p style="color: #888; font-size: 13px;">Sent by Paperclip Board Notifications</p>
    </div>
  `;
}

function blockedEmailHtml(event: PluginEvent): string {
  const p = event.payload as Record<string, unknown>;
  const identifier = (p.identifier as string) ?? "";
  const title = (p.title as string) ?? identifier;
  const priority = (p.priority as string) ?? "";

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px;">
      <h2 style="margin: 0 0 8px; color: #b91c1c;">⚠ Board action needed</h2>
      <table style="border-collapse: collapse; width: 100%; margin-bottom: 16px;">
        <tr><td style="padding: 4px 8px; color: #666;">Issue</td><td style="padding: 4px 8px; font-weight: 600;">${identifier}</td></tr>
        <tr><td style="padding: 4px 8px; color: #666;">Title</td><td style="padding: 4px 8px;">${escapeHtml(title)}</td></tr>
        ${priority ? `<tr><td style="padding: 4px 8px; color: #666;">Priority</td><td style="padding: 4px 8px;">${priority}</td></tr>` : ""}
      </table>
      <p style="margin-top: 12px;">An issue has been marked <strong>blocked</strong> and may require board intervention. Check the issue comments for details.</p>
      <p style="color: #888; font-size: 13px;">Sent by Paperclip Board Notifications</p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
        const p = event.payload as Record<string, unknown>;
        const identifier = (p.identifier as string) ?? event.entityId ?? "";
        await sendEmail(
          ctx,
          config,
          `[Paperclip] ${identifier} assigned to you`,
          assignedEmailHtml(event),
        );
      }

      // 2. Issue newly blocked — board action may be needed
      if (config.notifyOnBlocked && isNewlyBlocked(event)) {
        const p = event.payload as Record<string, unknown>;
        const identifier = (p.identifier as string) ?? event.entityId ?? "";
        await sendEmail(
          ctx,
          config,
          `[Paperclip] ⚠ ${identifier} blocked — board action needed`,
          blockedEmailHtml(event),
        );
      }
    });

    // Also catch new issues created directly assigned to a user
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const config = await getConfig(ctx);
      if (!config.notifyOnAssign) return;

      const p = event.payload as Record<string, unknown>;
      if (!p.assigneeUserId) return;

      const identifier = (p.identifier as string) ?? event.entityId ?? "";
      await sendEmail(
        ctx,
        config,
        `[Paperclip] ${identifier} assigned to you`,
        assignedEmailHtml(event),
      );
    });
  },

  async onHealth() {
    return { status: "ok", message: "Board notify plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
