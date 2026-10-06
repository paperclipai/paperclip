import { t } from "@/i18n";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";

const STATUS_FALLBACKS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
  in_queue: "In queue",
};

export function entityStatusLabel(status: string): string {
  const key = `status.${status}`;
  const translated = t(key);
  if (translated !== key) return translated;
  const fallback = STATUS_FALLBACKS[status];
  if (fallback) return fallback;
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function entityPriorityLabel(priority: string): string {
  const key = `priority.${priority}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return priority.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function agentRoleLabel(role: string): string {
  const key = `agentRoles.${role}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return AGENT_ROLE_LABELS[role as keyof typeof AGENT_ROLE_LABELS] ?? role;
}

export const localizedAgentRoleLabels: Record<string, string> = new Proxy(AGENT_ROLE_LABELS, {
  get(target, property, receiver) {
    if (typeof property !== "string") return Reflect.get(target, property, receiver);
    return agentRoleLabel(property);
  },
});
