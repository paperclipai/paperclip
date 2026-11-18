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

/** What a paused or draft routine skips; null when it would not run on its own anyway. */
export function routinePausedNotice({
  state,
  hasWebhooks,
  hasSchedule,
}: {
  state: RoutineAutomationState;
  hasWebhooks: boolean;
  hasSchedule: boolean;
}): string | null {
  if (state !== "paused" && state !== "draft") return null;
  if (hasWebhooks && hasSchedule) return "Scheduled runs are skipped and webhook events are ignored until this routine is on.";
  if (hasWebhooks) return "Webhook events are ignored until this routine is on. The sending app gets an error.";
  if (hasSchedule) return "Scheduled runs are skipped until this routine is on.";
  return null;
}

/** The line beside the status switch: when the routine runs next, or why it does not. */
export function routineStatusDetail({
  state,
  nextRun,
  hasEnabledWebhook,
  hasStandingCheck,
  now,
}: {
  state: RoutineAutomationState;
  nextRun: Date | null;
  hasEnabledWebhook: boolean;
  hasStandingCheck: boolean;
  now?: Date;
}): string | null {
  if (state === "draft") return null;
  if (state === "archived") return "No longer runs";
  if (state === "paused") return "Run now still works";
  if (nextRun) return `Next run ${formatNextRun(nextRun, now)}`;
  if (hasEnabledWebhook) return "Runs when a webhook arrives";
  if (hasStandingCheck) return "Checked each time the agent wakes up";
  return "Only runs when you start it";
}

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

/** Which status the webhook dialog shows; each key has one entry in WEBHOOK_STATUS_COPY. */
export type WebhookStatusKey =
  | WebhookHealth
  | "setup_testing"
  | "test_received"
  | "test_rejected"
  | "ignored_while_paused";

export function webhookStatusKey(
  trigger: RoutineTrigger,
  { routineActive, testing }: { routineActive: boolean; testing: boolean },
): WebhookStatusKey {
  const health = webhookHealth(trigger);
  // Only test deliveries count: a webhook put back into test mode still carries its last real delivery.
  const testDelivery = trigger.setupPending && trigger.lastWebhookDelivery?.test ? trigger.lastWebhookDelivery : null;
  if (testDelivery?.status === "received") return "test_received";
  if (testDelivery?.status === "rejected") return "test_rejected";
  if (!routineActive && health !== "setup" && health !== "testing") return "ignored_while_paused";
  if (health === "setup" && testing) return "setup_testing";
  return health;
}

export const WEBHOOK_STATUS_COPY: Record<WebhookStatusKey, { title: string; detail: string }> = {
  setup: { title: "Waiting for a test event", detail: "Send one from your app. Test events never start the routine." },
  setup_testing: {
    title: "Waiting for a test event",
    detail: "Send one from your app. It won’t start the routine. Real events are ignored until you finish testing.",
  },
  testing: {
    title: "Testing",
    detail: "Send an event from your app. It won’t start the routine. Real events are ignored until you finish testing.",
  },
  waiting: { title: "Ready", detail: "The next event starts this routine." },
  receiving: { title: "Receiving events", detail: "Each event starts this routine." },
  rejected: {
    title: "The last event was rejected",
    detail: "The key didn’t match. Replace the key, then paste the new one into your app.",
  },
  test_rejected: {
    title: "The last event was rejected",
    detail: "The key didn’t match. Replace the key, then paste the new one into your app.",
  },
  test_received: { title: "Test event received", detail: "The connection works. No task was created." },
  ignored_while_paused: {
    title: "Ignoring events while the routine is paused",
    detail: "Turn the routine on to start it from this webhook. Until then the sending app gets an error.",
  },
  paused: { title: "Paused", detail: "Events are ignored until you resume this webhook." },
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
