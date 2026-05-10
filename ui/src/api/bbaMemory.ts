export type BbaMemoryRunOutcome = "success" | "failure" | "partial" | null;

export interface BbaMemoryRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  source: string;
  trigger: string | null;
  outcome: BbaMemoryRunOutcome;
  failureClass: string | null;
  durationMs: number | null;
  meta: Record<string, unknown> | null;
}

export interface RecentRunsResponse {
  companyId: string;
  limit: number;
  total: number;
  runs: BbaMemoryRun[];
}

export async function fetchRecentBbaRuns(
  companyId: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<RecentRunsResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  const url = `/api/companies/${encodeURIComponent(companyId)}/bba-memory/recent-runs${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { credentials: "include", signal: options.signal });
  if (!res.ok) {
    throw new Error(`fetchRecentBbaRuns failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<RecentRunsResponse>;
}
