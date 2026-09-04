export function isTerminalIssueStatus(status: string | null | undefined): boolean {
  return status === "done" || status === "cancelled";
}

export type ShouldFoldTerminalSourceInput = {
  sourceIssueStatus: string | null | undefined;
  hasSameRunTerminalEvidence: boolean;
};

/**
 * A terminal source issue folds the watchdog run only when durable,
 * same-run evidence shows the issue already reached that terminal status
 * from an action inside this run. A terminal status alone is not enough
 * evidence; a different run or a different actor could have closed it.
 */
export function shouldFoldTerminalSource(input: ShouldFoldTerminalSourceInput): boolean {
  return isTerminalIssueStatus(input.sourceIssueStatus) && input.hasSameRunTerminalEvidence;
}
