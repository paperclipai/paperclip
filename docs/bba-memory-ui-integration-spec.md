# BBA Memory — UI Integration Spec

## Audience
Implementer (the CTO agent in the Paperclip workspace, or a frontend engineer).

## Demo goal
Operator clicks "Place bet" in BettingOpsDashboard → BBA executes → operator sees outcome live in the same page.

## Backend already built (this PR)
- `POST /api/companies/:companyId/betting-browser-automation/execute` — registered in app.ts.
- `GET /api/companies/:companyId/bba-memory/recent-runs?limit=20` — list last N runs (filtered by company).
- `GET /api/companies/:companyId/bba-memory/stats-summary?windowDays=7` — aggregated stats.
- All gated by `assertCompanyAccess`. Cookie-based auth.
- Typed clients: `ui/src/api/bbaMemory.ts` exports `fetchRecentBbaRuns`, `fetchBbaStats`. Add `executeBbaBet` per signature below.

## UI changes (your work)

### Component 1: Recent runs panel (read-only, low risk — do this first)
In `ui/src/pages/BettingOpsDashboard.tsx`, add a new section "BBA Memory — Recent Runs":
- TanStack Query: `useQuery({ queryKey: ["bba-memory", "recent-runs", companyId], queryFn: ({ signal }) => fetchRecentBbaRuns(companyId, { limit: 20, signal }), refetchInterval: 30_000 })`.
- Stats card row above table: success rate %, total runs (window=7d), top failure class. Fetch from `fetchBbaStats(companyId, { windowDays: 7 })`.
- Table: timestamp, source, trigger, outcome (color-coded), failure_class, duration_ms.
- Empty state: "No BBA runs recorded yet."
- Error state: small inline error.

### Component 2: Execute button (write, HIGH risk — operator confirmation REQUIRED)
ABOVE the recent runs panel, add an "Execute Bet" section.
- Inputs: pre-filled bookmaker config from a config selector (out of scope here — assume props for now).
- Button: "Place bet" — opens a modal "Confirm: place RON {{stake}} on {{matchLabel}} at {{bookmaker}} ({{odds}}). This will trigger a real bet placement against the live bookmaker. Proceed?"
- Confirm path: call `executeBbaBet(companyId, payload)`.
- Show progress: spinner with "Placing bet..." text. Poll `fetchRecentBbaRuns(companyId, { limit: 1 })` every 5s during execution.
- Result: green checkmark on `outcome === "success"`, red on failure (with failure_class), yellow on partial.

Add to `ui/src/api/bbaMemory.ts`:

```ts
export interface ExecuteBetRequest {
  issueId?: string | null;
  loginUsername: { secretId?: string; secretName?: string };
  loginPassword: { secretId?: string; secretName?: string };
  bookmakerConfig: any; // shape per server/src/routes/betting-browser-automation.ts request body
  bet: {
    matchLabel: string;
    market: string;
    selection: string;
    odds: number;
    stake: number;
    eventUrl?: string;
  };
  riskControls: {
    maxStakePerBet: number;
    maxTotalStakePerSession: number;
    requireFinalConfirmation?: boolean;
  };
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
```

## Acceptance criteria
- [ ] Recent-runs panel renders, polls every 30s, no console errors.
- [ ] Stats card row shows success rate.
- [ ] Color coding: success=green, partial=yellow, failure=red.
- [ ] "Place bet" button is disabled until a valid bookmaker config + bet are selected.
- [ ] Confirmation modal lists exact stake, match, odds, bookmaker BEFORE submitting.
- [ ] On execute, UI shows live "placing..." progress, polls recent-runs every 5s.
- [ ] On failure, the failure_class is shown to operator.
- [ ] Vitest snapshot test for the recent-runs panel.
- [ ] No backend code changes.

## Rollout note
The CEO demo can land with Component 1 only. Component 2 should ship behind a feature flag or operator role check until validated against a small bet on a sandbox account.

## Out of scope
- Bookmaker config selector UI (separate work).
- Per-run detail drill-down.
- Multi-bet (combo) UX.
