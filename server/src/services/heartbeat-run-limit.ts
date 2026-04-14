export function countLiveRunLimitRelevantRuns<T extends { status: string | null | undefined }>(runs: T[]) {
  return runs.filter((run) => run.status === "running").length;
}

export function hasReachedLiveRunLimit<T extends { status: string | null | undefined }>(
  runs: T[],
  limit: number,
) {
  return countLiveRunLimitRelevantRuns(runs) >= limit;
}
