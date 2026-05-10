import type { WakeKind } from "@paperclipai/db";

// Priority: manual (0) > event (1) > self_trigger (2) > cron (3)
export const WAKE_KIND_PRIORITY: Record<WakeKind, number> = {
  manual: 0,
  event: 1,
  self_trigger: 2,
  cron: 3,
};

export function mapSourceToWakeKind(source: string | undefined | null): WakeKind {
  switch (source) {
    case "on_demand":
      return "manual";
    case "assignment":
    case "automation":
      return "event";
    case "self_trigger":
      return "self_trigger";
    case "timer":
    default:
      return "cron";
  }
}
