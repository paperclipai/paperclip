import type { NotificationEvent } from "@paperclipai/shared";
import * as webhook from "@paperclipai/notifier-webhook";
import * as discord from "@paperclipai/notifier-discord";
import * as ntfy from "@paperclipai/notifier-ntfy";

export interface NotificationChannelBackend {
  type: string;
  label: string;
  send(event: NotificationEvent, config: Record<string, unknown>): Promise<void>;
  testConnection(config: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

const backendsByType = new Map<string, NotificationChannelBackend>([
  [webhook.type, webhook],
  [discord.type, discord],
  [ntfy.type, ntfy],
]);

export function getBackend(type: string): NotificationChannelBackend | undefined {
  return backendsByType.get(type);
}

export function listBackendTypes(): string[] {
  return Array.from(backendsByType.keys());
}
