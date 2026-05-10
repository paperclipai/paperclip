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

// ── Execute bet (HIGH RISK — triggers real bookmaker bet) ────────────────────
//
// bookmakerConfig is intentionally typed loosely (Record<string, unknown>).
// The server route at server/src/routes/betting-browser-automation.ts validates
// the exact shape; over-specifying here would create divergence risk.

export interface ExecuteBetRequest {
  issueId?: string | null;
  loginUsername: { secretId?: string; secretName?: string };
  loginPassword: { secretId?: string; secretName?: string };
  bookmakerConfig: Record<string, unknown>;
  bet: {
    matchLabel: string;
    market: string;
    selection: string;
    odds: number;
    stake: number;
    eventUrl?: string;
    currency?: string;
  };
  bets?: Array<ExecuteBetRequest["bet"]>;
  riskControls: {
    maxStakePerBet: number;
    maxTotalStakePerSession: number;
    requireFinalConfirmation?: boolean;
    dailyStopLossPct?: number;
    sessionStopLossPct?: number;
  };
  execution?: Record<string, unknown>;
  currentBalance?: number | null;
  sessionStartedAt?: string | null;
}

export interface ExecuteBetResponse {
  status: string;
  failureReason?: string | null;
  placedBetId?: string | null;
  sessionId?: string;
  artifactDir?: string;
  logPath?: string;
}

export async function executeBbaBet(
  companyId: string,
  payload: ExecuteBetRequest,
  signal?: AbortSignal,
): Promise<ExecuteBetResponse> {
  const res = await fetch(
    `/api/companies/${encodeURIComponent(companyId)}/betting-browser-automation/execute`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
  );
  if (!res.ok) throw new Error(`executeBbaBet failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<ExecuteBetResponse>;
}
