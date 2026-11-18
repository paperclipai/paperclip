import type { RoutineDetail, RoutineTrigger } from "@paperclipai/shared";
import { describeSchedule } from "@/components/ScheduleEditor";

export type RoutineAutomationState = "active" | "paused" | "draft" | "archived";

/** A routine without a default agent cannot run automatically, whatever its saved status. */
export function routineAutomationState(routine: Pick<RoutineDetail, "status" | "assigneeAgentId">): RoutineAutomationState {
  if (routine.status === "archived") return "archived";
  if (!routine.assigneeAgentId) return "draft";
  return routine.status === "active" ? "active" : "paused";
}

export const ROUTINE_STATE_LABELS: Record<RoutineAutomationState, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  archived: "Archived",
};

export function nextScheduledRun(triggers: readonly RoutineTrigger[]): Date | null {
  return triggers
    .filter((trigger) => trigger.kind === "schedule" && trigger.enabled && trigger.nextRunAt)
    .map((trigger) => new Date(trigger.nextRunAt as Date))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
}

/** "today at 9:36 AM", "tomorrow at 2:00 PM", otherwise a short dated form. */
export function formatNextRun(date: Date, now: Date = new Date()): string {
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const day = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${day} at ${time}`;
}

export function describeScheduleTrigger(trigger: Pick<RoutineTrigger, "cronExpression">): string {
  return trigger.cronExpression ? describeSchedule(trigger.cronExpression) : "Schedule";
}

export function webhookTitle(trigger: Pick<RoutineTrigger, "signingMode" | "label">): string {
  const kind = trigger.signingMode === "github_hmac" ? "GitHub webhook" : "Webhook";
  return trigger.label ? `${kind} · ${trigger.label}` : kind;
}

export type WebhookHealth = "setup" | "testing" | "paused" | "rejected" | "receiving" | "waiting";

/** A webhook that went live before and was put back into test mode (it has a real delivery on record). */
export function webhookRetesting(trigger: Pick<RoutineTrigger, "setupPending" | "lastWebhookDelivery">): boolean {
  const delivery = trigger.lastWebhookDelivery;
  if (!trigger.setupPending || !delivery) return false;
  return delivery.test ? delivery.previous != null : true;
}

export function webhookHealth(trigger: RoutineTrigger): WebhookHealth {
  if (trigger.setupPending) return webhookRetesting(trigger) ? "testing" : "setup";
  if (!trigger.enabled) return "paused";
  if (trigger.lastWebhookDelivery?.status === "rejected") return "rejected";
  if (trigger.lastWebhookDelivery?.status === "received" && !trigger.lastWebhookDelivery.test) return "receiving";
  return "waiting";
}

export const WEBHOOK_HEALTH_LABELS: Record<WebhookHealth, string> = {
  setup: "Setup unfinished",
  testing: "Testing · events don’t run",
  paused: "Paused",
  rejected: "Key rejected",
  receiving: "Receiving events",
  waiting: "Waiting for the first event",
};

/** Plain-language lines for saved run rules that differ from the defaults. Empty for most routines. */
export function customRunRules(
  routine: Pick<RoutineDetail, "concurrencyPolicy" | "catchUpPolicy" | "activityGatePolicy" | "activityGateScope">,
): string[] {
  const rules: string[] = [];
  if (routine.concurrencyPolicy === "always_enqueue") rules.push("Queues every run, even while one is still working");
  if (routine.concurrencyPolicy === "skip_if_active") rules.push("Skips a run while one is still working");
  if (routine.catchUpPolicy === "enqueue_missed_with_cap") rules.push("Catches up on runs missed while paused");
  if (routine.activityGatePolicy === "require_external_activity") {
    rules.push(
      routine.activityGateScope === "project"
        ? "Skips scheduled runs when nothing changed in its project"
        : "Skips scheduled runs when nothing changed",
    );
  }
  return rules;
}

/** First paragraph of the instructions; a leading heading keeps the paragraph under it. */
export function instructionsPreview(markdown: string): { preview: string; truncated: boolean } {
  const blocks = markdown.trim().split(/\n\s*\n/);
  if (blocks.length <= 1) return { preview: markdown.trim(), truncated: false };
  const take = /^#{1,6}\s/.test(blocks[0] ?? "") ? 2 : 1;
  return { preview: blocks.slice(0, take).join("\n\n"), truncated: blocks.length > take };
}
