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

export interface BbaStatsSummary {
  companyId: string;
  windowDays: number;
  totalRuns: number;
  successCount: number;
  failureCount: number;
  partialCount: number;
  successRatePct: number | null;
  topFailureClasses: Array<{ class: string; count: number }>;
}

export async function fetchBbaStats(
  companyId: string,
  options: { windowDays?: number; signal?: AbortSignal } = {},
): Promise<BbaStatsSummary> {
  const params = new URLSearchParams();
  if (options.windowDays) params.set("windowDays", String(options.windowDays));
  const qs = params.toString();
  const url = `/api/companies/${encodeURIComponent(companyId)}/bba-memory/stats-summary${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { credentials: "include", signal: options.signal });
  if (!res.ok) throw new Error(`fetchBbaStats failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<BbaStatsSummary>;
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
