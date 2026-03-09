import type { NotificationEvent } from "@paperclipai/shared";

export const type = "discord";
export const label = "Discord";

const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal",
]);

const PRIVATE_IP_PREFIXES = [
  "10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.",
  "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.",
  "172.29.", "172.30.", "172.31.", "192.168.", "169.254.",
];

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(hostname)) return true;
    if (PRIVATE_IP_PREFIXES.some((prefix) => hostname.startsWith(prefix))) return true;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
    return false;
  } catch {
    return true;
  }
}

const EVENT_COLORS: Record<string, number> = {
  "agent.run.finished": 0x2ecc71,   // green
  "agent.run.failed": 0xe74c3c,     // red
  "agent.run.cancelled": 0x95a5a6,  // gray
  "agent.status_changed": 0x3498db, // blue
  "approval.created": 0xf1c40f,     // yellow
  "approval.decided": 0xf1c40f,     // yellow
  "issue.created": 0x3498db,        // blue
  "issue.updated": 0x3498db,        // blue
  "issue.comment.created": 0x3498db, // blue
  "cost_event.created": 0x9b59b6,   // purple
};

const EVENT_LABELS: Record<string, string> = {
  "agent.run.finished": "Agent Run Finished",
  "agent.run.failed": "Agent Run Failed",
  "agent.run.cancelled": "Agent Run Cancelled",
  "agent.status_changed": "Agent Status Changed",
  "approval.created": "Approval Requested",
  "approval.decided": "Approval Decided",
  "issue.created": "Issue Created",
  "issue.updated": "Issue Updated",
  "issue.comment.created": "New Comment",
  "cost_event.created": "Cost Event",
};

function buildEmbed(event: NotificationEvent) {
  const color = EVENT_COLORS[event.type] ?? 0x3498db;
  const title = EVENT_LABELS[event.type] ?? event.type;

  const fields = [
    { name: "Actor", value: `${event.actor.type}: ${event.actor.id}`, inline: true },
    { name: "Entity", value: `${event.entity.type}: ${event.entity.id}`, inline: true },
  ];

  const status = event.payload.status as string | undefined;
  if (status) {
    fields.push({ name: "Status", value: status, inline: true });
  }

  const error = event.payload.error as string | undefined;
  if (error) {
    fields.push({ name: "Error", value: error.slice(0, 1024), inline: false });
  }

  return {
    embeds: [
      {
        title,
        color,
        fields,
        timestamp: event.occurredAt,
        footer: { text: "Paperclip" },
      },
    ],
  };
}

export async function send(
  event: NotificationEvent,
  config: Record<string, unknown>,
): Promise<void> {
  const webhookUrl = config.webhookUrl as string;
  if (!webhookUrl || isBlockedUrl(webhookUrl)) throw new Error("Blocked or invalid Discord webhook URL");

  const body = JSON.stringify(buildEmbed(event));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Discord webhook returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function testConnection(
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const webhookUrl = config.webhookUrl as string;
  if (!webhookUrl) return { ok: false, error: "Missing webhookUrl in config" };
  if (isBlockedUrl(webhookUrl)) return { ok: false, error: "URL is blocked (private/internal address)" };

  const body = JSON.stringify({
    embeds: [
      {
        title: "Connection Test",
        description: "Paperclip notification channel connected successfully.",
        color: 0x2ecc71,
        timestamp: new Date().toISOString(),
        footer: { text: "Paperclip" },
      },
    ],
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
