import type { CreateRoutineFromTask, Routine, RoutineFromTaskResult, SuggestRoutineInteraction } from "@paperclipai/shared";
import { api } from "./client";

/** Routine offers on finished tasks (experimental `enableResponsibilities`). */
export const routineSuggestionsApi = {
  accept: (issueId: string, interactionId: string, timezone: string) =>
    api.post<{ interaction: SuggestRoutineInteraction; routine: Routine }>(
      `/issues/${issueId}/routine-suggestions/${interactionId}/accept`,
      { timezone },
    ),
  /** A person turns a task into a routine, without an agent's offer. */
  repeatAsRoutine: (issueId: string, body: CreateRoutineFromTask) =>
    api.post<RoutineFromTaskResult>(`/issues/${encodeURIComponent(issueId)}/repeat-as-routine`, body),
  decline: (issueId: string, interactionId: string) =>
    api.post<SuggestRoutineInteraction>(
      `/issues/${issueId}/routine-suggestions/${interactionId}/decline`,
      {},
    ),
};
