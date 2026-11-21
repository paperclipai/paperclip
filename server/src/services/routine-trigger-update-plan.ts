import type { RoutineWebhookDelivery, UpdateRoutineTrigger } from "@paperclipai/shared";

/** The trigger fields a plan reads, as stored. */
export interface TriggerUpdatePlanState {
  kind: string;
  setupPending: boolean;
  lastWebhookDelivery: RoutineWebhookDelivery | null;
}

/** What one `PATCH /routine-triggers/:id` does to test mode, delivery status, the revision and the activity log. */
export interface TriggerUpdatePlan {
  startsTesting: boolean;
  finishesTesting: boolean;
  /** Ending a test puts back the last real delivery (or null), so no stale test result stays behind. */
  restoredDelivery: { value: RoutineWebhookDelivery | null } | null;
  changeSummary: string;
  activityAction: string;
}

/** The activity action for a trigger update body; also used when the service is not reached. */
export function triggerUpdateActivityAction(patch: Pick<UpdateRoutineTrigger, "archived" | "setupPending">): string {
  if (patch.archived === true) return "routine.trigger_removed";
  if (patch.archived === false) return "routine.trigger_restored";
  if (patch.setupPending === true) return "routine.trigger_test_started";
  if (patch.setupPending === false) return "routine.trigger_setup_finished";
  return "routine.trigger_updated";
}

/** Pure plan for a trigger update, so the service and the route's activity entry cannot drift. */
export function planTriggerUpdate(
  patch: Pick<UpdateRoutineTrigger, "archived" | "setupPending">,
  current: TriggerUpdatePlanState,
): TriggerUpdatePlan {
  const startsTesting = patch.setupPending === true && !current.setupPending;
  const finishesTesting = patch.setupPending === false && current.setupPending;
  const last = current.lastWebhookDelivery;
  // A test delivery always records `previous` (null when there was no real delivery).
  const restoredDelivery = finishesTesting && last?.test && "previous" in last ? { value: last.previous ?? null } : null;
  const changeSummary = startsTesting
    ? "Started testing webhook"
    : finishesTesting
      ? restoredDelivery?.value ? "Finished testing webhook" : "Finished webhook setup or test"
      : `Updated ${current.kind} trigger`;
  return { startsTesting, finishesTesting, restoredDelivery, changeSummary, activityAction: triggerUpdateActivityAction(patch) };
}
