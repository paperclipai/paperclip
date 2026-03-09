import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const METRIC_SENT = "email_notifications_sent";
const METRIC_FAILED = "email_notification_failures";

// ---------------------------------------------------------------------------
// Known event types for allowlist validation
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES = new Set([
  "company.created",
  "company.updated",
  "project.created",
  "project.updated",
  "project.workspace_created",
  "project.workspace_updated",
  "project.workspace_deleted",
  "issue.created",
  "issue.updated",
  "issue.comment.created",
  "agent.created",
  "agent.updated",
  "agent.status_changed",
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
  "approval.created",
  "approval.decided",
  "cost_event.created",
  "activity.logged",
]);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PluginConfig {
  provider: "resend" | "sendgrid";
  apiKeySecretRef: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string[];
  subjectPrefix: string;
  allowlist: string[];
}

// ---------------------------------------------------------------------------
// Event labels and colors
// ---------------------------------------------------------------------------

interface EventStyle {
  label: string;
  color: string;
}

const EVENT_STYLES: Record<string, EventStyle> = {
  "agent.run.started": { label: "Agent Run Started", color: "#3b82f6" },
  "agent.run.finished": { label: "Agent Run Finished", color: "#22c55e" },
  "agent.run.failed": { label: "Agent Run Failed", color: "#ef4444" },
  "agent.run.cancelled": { label: "Agent Run Cancelled", color: "#6b7280" },
  "agent.status_changed": { label: "Agent Status Changed", color: "#3b82f6" },
  "issue.created": { label: "Issue Created", color: "#f59e0b" },
  "issue.comment.created": { label: "Issue Comment Added", color: "#3b82f6" },
  "approval.created": { label: "Approval Requested", color: "#f59e0b" },
  "approval.decided": { label: "Approval Decided", color: "#22c55e" },
  "cost_event.created": { label: "Cost Event", color: "#6b7280" },
};

// ---------------------------------------------------------------------------
// Email request builders (provider-specific)
// ---------------------------------------------------------------------------

interface EmailRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function buildResendRequest(
  apiKey: string,
  from: string,
  to: string[],
  subject: string,
  html: string,
  text: string,
): EmailRequest {
  return {
    url: "https://api.resend.com/emails",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  };
}

function buildSendGridRequest(
  apiKey: string,
  from: string,
  to: string[],
  subject: string,
  html: string,
  text: string,
): EmailRequest {
  return {
    url: "https://api.sendgrid.com/v3/mail/send",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: to.map((email) => ({ email })) }],
      from: { email: from },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// Email template rendering
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtmlEmail(
  event: { eventType: string; actorId?: string; actorType?: string; entityId?: string; entityType?: string; occurredAt: string; payload: unknown },
  style: EventStyle,
): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const status = typeof payload.status === "string" ? payload.status : undefined;
  const error = typeof payload.error === "string" ? payload.error.slice(0, 1024) : undefined;

  const rows: string[] = [];
  if (event.actorType || event.actorId) {
    rows.push(`<tr><td style="padding:4px 12px;color:#6b7280;font-weight:600">Actor</td><td style="padding:4px 12px">${escapeHtml(`${event.actorType ?? "unknown"} (${event.actorId ?? "unknown"})`)}</td></tr>`);
  }
  if (event.entityType || event.entityId) {
    rows.push(`<tr><td style="padding:4px 12px;color:#6b7280;font-weight:600">Entity</td><td style="padding:4px 12px">${escapeHtml(`${event.entityType ?? "unknown"} (${event.entityId ?? "unknown"})`)}</td></tr>`);
  }
  if (status) {
    rows.push(`<tr><td style="padding:4px 12px;color:#6b7280;font-weight:600">Status</td><td style="padding:4px 12px">${escapeHtml(status)}</td></tr>`);
  }
  if (error) {
    rows.push(`<tr><td style="padding:4px 12px;color:#6b7280;font-weight:600">Error</td><td style="padding:4px 12px;color:#ef4444">${escapeHtml(error)}</td></tr>`);
  }
  rows.push(`<tr><td style="padding:4px 12px;color:#6b7280;font-weight:600">Occurred</td><td style="padding:4px 12px">${escapeHtml(event.occurredAt)}</td></tr>`);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;color:#111827">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden">
    <tr>
      <td style="padding:16px 20px;background:${style.color};color:#ffffff;font-size:16px;font-weight:600">
        ${escapeHtml(style.label)}
      </td>
    </tr>
    <tr>
      <td style="padding:12px 8px">
        <table role="presentation" width="100%" style="font-size:14px;line-height:1.5">
          ${rows.join("\n          ")}
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:12px 20px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center">
        Paperclip &mdash; Agent Control Plane
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderPlainTextEmail(
  event: { eventType: string; actorId?: string; actorType?: string; entityId?: string; entityType?: string; occurredAt: string; payload: unknown },
  style: EventStyle,
): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const status = typeof payload.status === "string" ? payload.status : undefined;
  const error = typeof payload.error === "string" ? payload.error.slice(0, 1024) : undefined;

  const lines: string[] = [style.label, ""];
  if (event.actorType || event.actorId) {
    lines.push(`Actor: ${event.actorType ?? "unknown"} (${event.actorId ?? "unknown"})`);
  }
  if (event.entityType || event.entityId) {
    lines.push(`Entity: ${event.entityType ?? "unknown"} (${event.entityId ?? "unknown"})`);
  }
  if (status) lines.push(`Status: ${status}`);
  if (error) lines.push(`Error: ${error}`);
  lines.push(`Occurred: ${event.occurredAt}`);
  lines.push("", "---", "Paperclip — Agent Control Plane");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    const getParsedConfig = async (): Promise<PluginConfig> => {
      const config = await ctx.config.get();
      const provider = asString(config.provider);
      return {
        provider: provider === "sendgrid" ? "sendgrid" : "resend",
        apiKeySecretRef: asString(config.apiKeySecretRef),
        fromAddress: asString(config.fromAddress),
        fromName: asString(config.fromName) || "Paperclip",
        toAddresses: asStringArray(config.toAddresses),
        subjectPrefix: asString(config.subjectPrefix) || "[Paperclip]",
        allowlist: asStringArray(config.eventAllowlist),
      };
    };

    const sendEmail = async (
      config: PluginConfig,
      subject: string,
      html: string,
      text: string,
    ): Promise<boolean> => {
      if (!config.apiKeySecretRef) {
        ctx.logger.warn("email notifier skipped: apiKeySecretRef missing");
        return false;
      }
      if (config.toAddresses.length === 0) {
        ctx.logger.warn("email notifier skipped: no recipients configured");
        return false;
      }

      try {
        const apiKey = await ctx.secrets.resolve(config.apiKeySecretRef);
        // Strip newlines from subject prefix to prevent header injection
        const safeSubject = subject.replace(/[\r\n]/g, "");
        const from =
          config.fromName && config.fromName !== config.fromAddress
            ? `${config.fromName} <${config.fromAddress}>`
            : config.fromAddress;

        const request =
          config.provider === "sendgrid"
            ? buildSendGridRequest(apiKey, config.fromAddress, config.toAddresses, safeSubject, html, text)
            : buildResendRequest(apiKey, from, config.toAddresses, safeSubject, html, text);

        const response = await ctx.http.fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`${config.provider} responded with ${response.status}: ${body.slice(0, 256)}`);
        }

        await ctx.metrics.write(METRIC_SENT, 1);
        return true;
      } catch (error) {
        await ctx.metrics.write(METRIC_FAILED, 1);
        ctx.logger.error("email notifier delivery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    };

    const handleEvent = (
      eventName: string,
      afterSend?: (event: any, config: PluginConfig) => Promise<void>,
    ) => {
      ctx.events.on(eventName as any, async (event) => {
        const config = await getParsedConfig();

        if (
          config.allowlist.length > 0 &&
          !config.allowlist.includes(event.eventType)
        ) {
          return;
        }

        const style = EVENT_STYLES[event.eventType] ?? {
          label: event.eventType,
          color: "#6b7280",
        };

        const subject = `${config.subjectPrefix} ${style.label}`;
        const html = renderHtmlEmail(event, style);
        const text = renderPlainTextEmail(event, style);
        const delivered = await sendEmail(config, subject, html, text);

        if (delivered && afterSend) {
          await afterSend(event, config);
        }
      });
    };

    // --- Register event handlers ---

    handleEvent("agent.run.started");

    handleEvent("agent.run.finished", async (e) => {
      await ctx.activity.log({
        companyId: e.companyId,
        message: `Forwarded agent run completion (${e.entityId}) via email`,
        entityType: "run",
        entityId: e.entityId,
      });
    });

    handleEvent("agent.run.failed");
    handleEvent("agent.run.cancelled");
    handleEvent("agent.status_changed");
    handleEvent("issue.created");
    handleEvent("issue.comment.created");
    handleEvent("approval.created");
    handleEvent("approval.decided");
    handleEvent("cost_event.created");
  },

  async onValidateConfig(config) {
    const errors: string[] = [];

    const provider = asString(config.provider);
    if (provider && provider !== "resend" && provider !== "sendgrid") {
      errors.push('provider must be "resend" or "sendgrid"');
    }

    if (!asString(config.apiKeySecretRef)) {
      errors.push("apiKeySecretRef is required");
    }

    const fromAddress = asString(config.fromAddress);
    if (!fromAddress) {
      errors.push("fromAddress is required");
    } else if (!isValidEmail(fromAddress)) {
      errors.push("fromAddress must be a valid email address");
    }

    const toAddresses = asStringArray(config.toAddresses);
    if (toAddresses.length === 0) {
      errors.push("at least one recipient is required in toAddresses");
    } else if (toAddresses.length > 20) {
      errors.push("toAddresses supports a maximum of 20 recipients");
    } else {
      const invalid = toAddresses.filter((addr) => !isValidEmail(addr));
      if (invalid.length > 0) {
        errors.push(`invalid email addresses: ${invalid.join(", ")}`);
      }
    }

    const allowlist = asStringArray(config.eventAllowlist);
    const unknown = allowlist.filter((e) => !KNOWN_EVENT_TYPES.has(e));
    if (unknown.length > 0) {
      errors.push(`unrecognized event types in eventAllowlist: ${unknown.join(", ")}`);
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "Email notifier plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
