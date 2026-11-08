import { t, useTranslation } from "@/i18n";
import { useCallback } from "react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { IssueRetryNowOutcome, IssueRetryNowResponse } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

export type RetryNowError = {
  message: string;
  outcomeMessage: string | null;
  status: number | null;
};

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (typeof error.message === "string" && error.message.trim().length > 0) return error.message;
    return t("display:copy_a6d06c8a0914", { value0: error.status });
  }
  if (error instanceof Error && error.message) return error.message;
  return t("display:copy_f1a6e788ad5b");
}

export const RETRY_NOW_OUTCOME_HEADLINE: Record<IssueRetryNowOutcome, string> = {
  get "promoted"() { return t("display:copy_14409ffab9dc"); },
  get "already_promoted"() { return t("display:copy_59e7664344bf"); },
  get "waiting"() { return t("display:copy_f92abbb89f33"); },
  get "no_scheduled_retry"() { return t("display:copy_6a23eb60f0b3"); },
  get "gate_suppressed"() { return t("display:copy_55cf6175d564"); },
};

export function useRetryNowMutation(
  issueId: string | null | undefined,
): UseMutationResult<IssueRetryNowResponse, unknown, void, unknown> & {
  lastError: RetryNowError | null;
} {
  useTranslation("display");
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const mutation = useMutation({
    mutationFn: () => {
      if (!issueId) throw new Error("Missing issue id");
      return issuesApi.retryScheduledRetryNow(issueId);
    },
    onSuccess: (response) => {
      if (issueId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
      }
      if (response.outcome === "promoted") {
        pushToast({
          title: RETRY_NOW_OUTCOME_HEADLINE.promoted,
          body: response.message,
          tone: "success",
        });
      } else if (response.outcome === "gate_suppressed") {
        pushToast({
          title: RETRY_NOW_OUTCOME_HEADLINE.gate_suppressed,
          body: response.message,
          tone: "error",
        });
      }
    },
    onError: (error) => {
      pushToast({
        get "title"() { return t("display:copy_55cf6175d564"); },
        body: readErrorMessage(error),
        tone: "error",
      });
    },
  });

  const reset = mutation.reset;
  const wrappedReset = useCallback(() => reset(), [reset]);

  const lastError: RetryNowError | null = (() => {
    if (mutation.error) {
      const apiError = mutation.error instanceof ApiError ? mutation.error : null;
      return {
        message: readErrorMessage(mutation.error),
        outcomeMessage: null,
        status: apiError?.status ?? null,
      };
    }
    if (mutation.data && mutation.data.outcome === "gate_suppressed") {
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
  } as UseMutationResult<IssueRetryNowResponse, unknown, void, unknown> & {
    lastError: RetryNowError | null;
  };
}
