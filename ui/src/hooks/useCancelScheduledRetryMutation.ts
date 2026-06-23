import { useCallback } from "react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  IssueCancelScheduledRetryOutcome,
  IssueCancelScheduledRetryResponse,
} from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

export type CancelScheduledRetryError = {
  message: string;
  outcomeMessage: string | null;
  status: number | null;
};

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (typeof error.message === "string" && error.message.trim().length > 0) return error.message;
    return `Request failed (${error.status})`;
  }
  if (error instanceof Error && error.message) return error.message;
  return "The request failed. Try again in a moment.";
}

export const CANCEL_SCHEDULED_RETRY_OUTCOME_HEADLINE: Record<IssueCancelScheduledRetryOutcome, string> = {
  cancelled: "Retry cancelled",
  already_cancelled: "Retry already cancelled",
  already_promoted: "Retry already running",
  no_scheduled_retry: "No scheduled retry",
};

export function useCancelScheduledRetryMutation(
  issueId: string | null | undefined,
): UseMutationResult<IssueCancelScheduledRetryResponse, unknown, void, unknown> & {
  lastError: CancelScheduledRetryError | null;
} {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const mutation = useMutation({
    mutationFn: () => {
      if (!issueId) throw new Error("Missing issue id");
      return issuesApi.cancelScheduledRetry(issueId);
    },
    onSuccess: (response) => {
      if (issueId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
      }
      if (response.outcome === "cancelled" || response.outcome === "already_cancelled") {
        pushToast({
          title: CANCEL_SCHEDULED_RETRY_OUTCOME_HEADLINE[response.outcome],
          body: response.message,
          tone: "success",
        });
      } else if (response.outcome === "already_promoted" || response.outcome === "no_scheduled_retry") {
        pushToast({
          title: CANCEL_SCHEDULED_RETRY_OUTCOME_HEADLINE[response.outcome],
          body: response.message,
          tone: "error",
        });
      }
    },
    onError: (error) => {
      pushToast({
        title: "Couldn't cancel retry",
        body: readErrorMessage(error),
        tone: "error",
      });
    },
  });

  const reset = mutation.reset;
  const wrappedReset = useCallback(() => reset(), [reset]);

  const lastError: CancelScheduledRetryError | null = (() => {
    if (mutation.error) {
      const apiError = mutation.error instanceof ApiError ? mutation.error : null;
      return {
        message: readErrorMessage(mutation.error),
        outcomeMessage: null,
        status: apiError?.status ?? null,
      };
    }
    if (
      mutation.data
      && (mutation.data.outcome === "already_promoted" || mutation.data.outcome === "no_scheduled_retry")
    ) {
      return {
        message: mutation.data.message,
        outcomeMessage: mutation.data.message,
        status: null,
      };
    }
    return null;
  })();

  return {
    ...mutation,
    reset: wrappedReset,
    lastError,
  } as UseMutationResult<IssueCancelScheduledRetryResponse, unknown, void, unknown> & {
    lastError: CancelScheduledRetryError | null;
  };
}
