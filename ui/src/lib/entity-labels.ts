import { t } from "@/i18n";

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
