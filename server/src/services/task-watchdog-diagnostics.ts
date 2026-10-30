export function createIncompleteTaskWatchdogScanReporter(
  warn: (details: { incomplete: number; newIncompleteIssueIds: string[] }, message: string) => void,
) {
  let previousIncompleteIssueIds = new Set<string>();
  return (result: { incomplete: number; incompleteIssueIds: string[] }, phase: "startup" | "periodic") => {
    const currentIssueIds = new Set(result.incompleteIssueIds);
    const newIncompleteIssueIds = [...currentIssueIds].filter((id) => !previousIncompleteIssueIds.has(id));
    previousIncompleteIssueIds = currentIssueIds;
    if (newIncompleteIssueIds.length === 0) return;
    warn(
      { incomplete: result.incomplete, newIncompleteIssueIds },
      `${phase} task-watchdog reconciliation found incomplete subtree scans`,
    );
  };
}

