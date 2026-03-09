import type { NotificationEvent } from "@paperclipai/shared";

export const type = "ntfy";
export const label = "ntfy.sh";

const DEFAULT_SERVER = "https://ntfy.sh";

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

const EVENT_PRIORITIES: Record<string, string> = {
  "agent.run.failed": "urgent",
  "approval.created": "high",
  "agent.run.finished": "default",
  "agent.run.cancelled": "default",
  "agent.status_changed": "low",
  "approval.decided": "default",
  "issue.created": "default",
  "issue.updated": "low",
  "issue.comment.created": "low",
  "cost_event.created": "low",
};

const EVENT_TAGS: Record<string, string> = {
  "agent.run.finished": "white_check_mark",
  "agent.run.failed": "x",
  "agent.run.cancelled": "no_entry_sign",
  "agent.status_changed": "arrows_counterclockwise",
  "approval.created": "raised_hand",
  "approval.decided": "ballot_box_with_check",
  "issue.created": "pencil",
  "issue.updated": "pencil2",
  "issue.comment.created": "speech_balloon",
  "cost_event.created": "moneybag",
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

export async function send(
  event: NotificationEvent,
  config: Record<string, unknown>,
): Promise<void> {
  const topic = config.topic as string;
  if (!topic) throw new Error("Missing topic in config");

  const server = (config.server as string) || DEFAULT_SERVER;
  const url = `${server.replace(/\/$/, "")}/${encodeURIComponent(topic)}`;
  if (isBlockedUrl(url)) throw new Error("Blocked or invalid ntfy server URL");

  const title = EVENT_LABELS[event.type] ?? event.type;
  const priority = EVENT_PRIORITIES[event.type] ?? "default";
  const tags = EVENT_TAGS[event.type] ?? "bell";

  const parts = [`Actor: ${event.actor.type} (${event.actor.id})`];
  const status = event.payload.status as string | undefined;
  if (status) parts.push(`Status: ${status}`);
  const error = event.payload.error as string | undefined;
  if (error) parts.push(`Error: ${error.slice(0, 256)}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: title,
        Priority: priority,
        Tags: tags,
      },
      body: parts.join("\n"),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ntfy returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function testConnection(
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const topic = config.topic as string;
  if (!topic) return { ok: false, error: "Missing topic in config" };

  const server = (config.server as string) || DEFAULT_SERVER;
  const url = `${server.replace(/\/$/, "")}/${encodeURIComponent(topic)}`;
  if (isBlockedUrl(url)) return { ok: false, error: "URL is blocked (private/internal address)" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: "Paperclip Connection Test",
        Priority: "low",
        Tags: "white_check_mark",
      },
      body: "Notification channel connected successfully.",
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
