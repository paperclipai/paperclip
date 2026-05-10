# BBA Memory UI Components

The BBA memory UI family provides a small operator-facing surface for viewing
recent betting-browser-automation runs and, when explicitly confirmed, executing
a live bookmaker bet through the existing API. The components are intentionally
self-contained so they can be integrated into a dashboard, a dedicated route, or
an internal playground without changing their internal behavior.

## Component Family

| Component | Export | Role |
| --- | --- | --- |
| `BbaMemoryRecentRunsPanel` | default | Read-only recent runs table plus 7-day stats cards. |
| `BbaMemoryExecuteBetPanel` | named | High-risk write path with two-step confirmation and result feedback. |
| `BbaOperatorPlayground` | named and default | Combines the read-only panel and execute panel with bookmaker and bet presets. |

## Usage

### Recent Runs Panel

```tsx
import BbaMemoryRecentRunsPanel from "./components/bba-memory/BbaMemoryRecentRunsPanel";

export function RunsSection({ companyId }: { companyId: string }) {
  return <BbaMemoryRecentRunsPanel companyId={companyId} />;
}
```

### Execute Bet Panel

```tsx
import { BbaMemoryExecuteBetPanel } from "./components/bba-memory/BbaMemoryExecuteBetPanel";
import type { ExecuteBetRequest } from "./api/bbaMemory";

const payload: ExecuteBetRequest = {
  loginUsername: { secretName: "BBA_USERNAME" },
  loginPassword: { secretName: "BBA_PASSWORD" },
  bookmakerConfig: {
    bookmaker: "TestMock",
    baseUrl: "https://example.test",
    loginUrl: "https://example.test/login",
    username: { selectors: ["#user"] },
    password: { selectors: ["#pass"] },
    loginSubmit: { selectors: ["#submit"] },
    selectionButton: { selectors: [".selection"] },
    stakeInput: { selectors: ["#stake"] },
    reviewButton: { selectors: ["#review"] },
  },
  bet: {
    matchLabel: "Team A vs Team B",
    market: "1X2",
    selection: "1",
    odds: 2.5,
    stake: 10,
  },
  riskControls: {
    maxStakePerBet: 50,
    maxTotalStakePerSession: 200,
    requireFinalConfirmation: true,
  },
};

export function ExecuteSection({ companyId }: { companyId: string }) {
  return (
    <BbaMemoryExecuteBetPanel
      companyId={companyId}
      payload={payload}
      betSummary={{
        matchLabel: "Team A vs Team B",
        market: "1X2",
        selection: "1",
        odds: 2.5,
        stake: 10,
        bookmaker: "TestMock",
      }}
    />
  );
}
```

### Operator Playground

```tsx
import BbaOperatorPlayground from "./components/bba-memory/BbaOperatorPlayground";

export function PlaygroundSection({ companyId }: { companyId: string }) {
  return <BbaOperatorPlayground companyId={companyId} />;
}
```

## Hook

```tsx
import { useBbaMemoryRuns } from "./components/bba-memory/useBbaMemoryRuns";

export function Summary({ companyId }: { companyId: string }) {
  const { runs, stats, isLoading, error, refetch } = useBbaMemoryRuns(companyId, {
    limit: 20,
    windowDays: 7,
  });

  if (isLoading) return <p>Loading...</p>;
  if (error) return <p>{error.message}</p>;

  return (
    <button onClick={refetch}>
      {runs.length} runs, {stats?.successRatePct ?? "-"}% success
    </button>
  );
}
```

## API Endpoints

- `GET /api/companies/:companyId/bba-memory/recent-runs?limit=20`
- `GET /api/companies/:companyId/bba-memory/stats-summary?windowDays=7`
- `POST /api/companies/:companyId/betting-browser-automation/execute`

## Testing Notes

The UI test stack uses Vitest with `happy-dom` and Testing Library:

- `@testing-library/react`
- `@testing-library/jest-dom`
- `@testing-library/user-event`
- `happy-dom`

Component tests live in `ui/src/components/bba-memory/__tests__/` and cover
loading, empty, populated, error, preset selection, API client behavior, hook
behavior, and full Playground integration.

## Known Follow-ups

- Address the PR #5602 review follow-ups before promoting the execute path:
  server-side idempotency, richer risk-control display, stricter selector
  validation, operator role gating, and sandbox-account validation.
- Wire `BbaOperatorPlayground` into the host page only after the stack PRs merge.
- Add visual polish once the demo path is stable.

Last updated: 2026-05-10
