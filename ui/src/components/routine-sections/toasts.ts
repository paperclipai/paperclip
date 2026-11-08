import { describeError } from "../../api/errors";
import type { ToastInput } from "../../context/ToastContext";

// Routine operations own their titles and action copy, rather than replacing
// them with the generic error classifier's title.
const FAILURE_COPY = {
  save: {
    title: "work:copy.failedToSaveRoutine_34cf35",
    action: "work:copy.saveTheRoutine_0cd92f",
  },
  run: {
    title: "work:copy.routineRunFailed_296c7c",
    action: "work:copy.startTheRoutineRun_b7d489",
  },
  status: {
    title: "work:copy.failedToUpdateRoutine_658553",
    action: "work:copy.updateTheRoutine_b91df2",
  },
  createTrigger: {
    title: "work:copy.failedToAddTrigger_3c4a07",
    action: "work:copy.createTheTrigger_800ccc",
  },
  updateTrigger: {
    title: "work:copy.failedToUpdateTrigger_4707ca",
    action: "work:copy.updateTheTrigger_4347d3",
  },
  deleteTrigger: {
    title: "work:copy.failedToDeleteTrigger_86096d",
    action: "work:copy.deleteTheTrigger_03274f",
  },
  rotateTriggerSecret: {
    title: "work:copy.failedToRotateWebhookSecret_1caaab",
    action: "work:copy.rotateTheWebhookSecret_1c6f8b",
  },
} as const;

type Translate = (key: string) => string;

export function routineFailureToast(
  operation: keyof typeof FAILURE_COPY,
  cause: unknown,
  translate: Translate,
): ToastInput {
  const { title, action } = FAILURE_COPY[operation];
  return {
    // Keep enqueue-time strings for storage/dedupe and the original cause for
    // render-time localization. Neither path mutates or translates raw errors.
    title: translate(title),
    body: describeError(cause, { action: translate(action) }).body,
    presentation: {
      title: { key: title },
      error: { cause, action: { key: action } },
    },
    tone: "error",
  };
}

export function routineSaveConflictToast(translate: Translate): ToastInput {
  const title = "work:copy.routineChanged_cd400e";
  const body = "work:copy.someoneElseUpdatedThisRoutineReloadToSeeThe_be054f";
  return {
    title: translate(title),
    body: translate(body),
    presentation: {
      title: { key: title },
      body: { key: body },
    },
    tone: "warn",
  };
}
