export interface ObservableRunState {
  status?: string | null;
  errorCode?: string | null;
}

export function isNonExecutingReviewFenceRun(run: ObservableRunState) {
  return (
    run.status === "cancelled" &&
    run.errorCode === "issue_continuation_waiting_on_review"
  );
}

export function numberedPlanStepCount(body: string | null | undefined) {
  return (body ?? "").split(/\r?\n/).filter((line) => {
    const normalized = line
      .replaceAll("**", "")
      .replaceAll("__", "")
      .replaceAll("`", "");
    return /^\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:step\s+)?\d+(?:[.)]|\s*[-—:])(?:\s|$)/i.test(
      normalized,
    );
  }).length;
}
