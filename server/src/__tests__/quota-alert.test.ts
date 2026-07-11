import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProviderQuotaResult } from "@paperclipai/adapter-utils";

// Hoist mock setup before any imports
const mockIssueCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "alert-issue-1" }));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({ create: mockIssueCreate })),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Build a drizzle-like mock db. The query builder chains are:
//   findCeoAgentId:         db.select().from().where().orderBy().limit() → Promise<row[]>
//   hasOpenAlertForResetAt: db.select().from().where().limit()           → Promise<row[]>
//
// We use a call counter so the first select chain goes to ceoResults and subsequent
// ones go to alertResults.

type SelectResultFactory = () => Promise<{ id: string }[]>;

function buildMockDb(ceoResult: SelectResultFactory, alertResult: SelectResultFactory) {
  let callIndex = 0;

  function makeChain(resolve: SelectResultFactory) {
    const chain: Record<string, unknown> = {};
    const then = (onFulfilled?: (value: { id: string }[]) => unknown) =>
      resolve().then(onFulfilled);
    const thenableChain = {
      from: () => thenableChain,
      where: () => thenableChain,
      orderBy: () => thenableChain,
      limit: () => ({ then }),
      then,
    };
    return thenableChain;
  }

  return {
    select: vi.fn().mockImplementation(() => {
      const resolver = callIndex === 0 ? ceoResult : alertResult;
      callIndex++;
      return makeChain(resolver);
    }),
  };
}

import {
  checkAndFireClaudeLocalQuotaAlert,
  quotaAlertFingerprint,
  QUOTA_ALERT_ORIGIN_KIND,
} from "../services/quota-alert.js";

const RESETS_AT = "2026-07-14T00:00:00.000Z";
const COMPANY_ID = "company-abc";

function makeOkResult(usedPercent: number, label = "Current week (all models)"): ProviderQuotaResult {
  return {
    provider: "anthropic",
    source: "anthropic-oauth",
    ok: true,
    windows: [
      { label, usedPercent, resetsAt: RESETS_AT, valueLabel: null, detail: null },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkAndFireClaudeLocalQuotaAlert — threshold", () => {
  it("creates a critical alert issue when a weekly window is at 82%", async () => {
    const db = buildMockDb(
      () => Promise.resolve([]),               // CEO: not found
      () => Promise.resolve([]),               // alert: no existing open alert
    );

    await checkAndFireClaudeLocalQuotaAlert(db as never, COMPANY_ID, () => Promise.resolve(makeOkResult(82)));

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    const [calledCompanyId, createData] = mockIssueCreate.mock.calls[0]!;
    expect(calledCompanyId).toBe(COMPANY_ID);
    expect(createData.priority).toBe("critical");
    expect(createData.status).toBe("todo");
    expect(createData.title).toContain("82%");
    expect(createData.title).toContain("[QUOTA ALERT]");
    expect(createData.originKind).toBe(QUOTA_ALERT_ORIGIN_KIND);
    expect(createData.originFingerprint).toBe(quotaAlertFingerprint(RESETS_AT));
  });

  it("does not create an issue when usage is at 79% (below threshold)", async () => {
    const db = buildMockDb(
      () => Promise.resolve([]),
      () => Promise.resolve([]),
    );

    await checkAndFireClaudeLocalQuotaAlert(db as never, COMPANY_ID, () => Promise.resolve(makeOkResult(79)));

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  it("does not create an issue when usage is at exactly 65%", async () => {
    const db = buildMockDb(
      () => Promise.resolve([]),
      () => Promise.resolve([]),
    );

    await checkAndFireClaudeLocalQuotaAlert(db as never, COMPANY_ID, () => Promise.resolve(makeOkResult(65)));

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });
});

describe("checkAndFireClaudeLocalQuotaAlert — deduplication", () => {
  it("does not create a second alert when an open alert already exists for the same reset week", async () => {
    // call 0 → hasOpenAlertForResetAt: returns existing open alert → dedup fires
    // call 1 → findCeoAgentId: never reached
    const db = buildMockDb(
      () => Promise.resolve([{ id: "existing-alert-issue" }]),
      () => Promise.resolve([]),
    );

    await checkAndFireClaudeLocalQuotaAlert(
      db as never,
      COMPANY_ID,
      () => Promise.resolve(makeOkResult(85)),
    );

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  it("creates a new alert when no existing open alert found (first crossing)", async () => {
    const db = buildMockDb(
      () => Promise.resolve([]),               // no CEO
      () => Promise.resolve([]),               // no existing alert
    );

    await checkAndFireClaudeLocalQuotaAlert(
      db as never,
      COMPANY_ID,
      () => Promise.resolve(makeOkResult(85)),
    );

    expect(mockIssueCreate).toHaveBeenCalledOnce();
  });
});

describe("checkAndFireClaudeLocalQuotaAlert — window filtering", () => {
  it("does not create an issue for the current session window even at 95%", async () => {
    const db = buildMockDb(() => Promise.resolve([]), () => Promise.resolve([]));

    await checkAndFireClaudeLocalQuotaAlert(
      db as never,
      COMPANY_ID,
      () => Promise.resolve({
        provider: "anthropic",
        source: "anthropic-oauth",
        ok: true,
        windows: [
          { label: "Current session", usedPercent: 95, resetsAt: RESETS_AT, valueLabel: null, detail: null },
        ],
      }),
    );

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  it("creates an alert for 'Current week (Sonnet only)' when above threshold", async () => {
    const db = buildMockDb(() => Promise.resolve([]), () => Promise.resolve([]));

    await checkAndFireClaudeLocalQuotaAlert(
      db as never,
      COMPANY_ID,
      () => Promise.resolve(makeOkResult(90, "Current week (Sonnet only)")),
    );

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(mockIssueCreate.mock.calls[0]![1].title).toContain("90%");
  });

  it("creates an alert for 'Current week (Opus only)' when above threshold", async () => {
    const db = buildMockDb(() => Promise.resolve([]), () => Promise.resolve([]));

    await checkAndFireClaudeLocalQuotaAlert(
      db as never,
      COMPANY_ID,
      () => Promise.resolve(makeOkResult(88, "Current week (Opus only)")),
    );

    expect(mockIssueCreate).toHaveBeenCalledOnce();
  });
});

describe("checkAndFireClaudeLocalQuotaAlert — error resilience", () => {
  it("does not throw when getQuotaWindows rejects", async () => {
    const db = buildMockDb(() => Promise.resolve([]), () => Promise.resolve([]));

    await expect(
      checkAndFireClaudeLocalQuotaAlert(db as never, COMPANY_ID, () => Promise.reject(new Error("network error"))),
    ).resolves.toBeUndefined();

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  it("does not create an issue when quota result has ok: false", async () => {
    const db = buildMockDb(() => Promise.resolve([]), () => Promise.resolve([]));

    await checkAndFireClaudeLocalQuotaAlert(
      db as never,
      COMPANY_ID,
      () => Promise.resolve({ provider: "anthropic", ok: false, error: "token expired", windows: [] }),
    );

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });
});

describe("checkAndFireClaudeLocalQuotaAlert — CEO assignment", () => {
  it("assigns the issue to the CEO agent when one exists", async () => {
    // call 0 → hasOpenAlertForResetAt: no existing alert
    // call 1 → findCeoAgentId: CEO found
    const db = buildMockDb(
      () => Promise.resolve([]),
      () => Promise.resolve([{ id: "ceo-agent-uuid" }]),
    );

    await checkAndFireClaudeLocalQuotaAlert(db as never, COMPANY_ID, () => Promise.resolve(makeOkResult(82)));

    expect(mockIssueCreate.mock.calls[0]![1].assigneeAgentId).toBe("ceo-agent-uuid");
  });

  it("creates the issue without an assignee when no CEO agent exists", async () => {
    const db = buildMockDb(
      () => Promise.resolve([]),   // no CEO
      () => Promise.resolve([]),
    );

    await checkAndFireClaudeLocalQuotaAlert(db as never, COMPANY_ID, () => Promise.resolve(makeOkResult(82)));

    expect(mockIssueCreate.mock.calls[0]![1].assigneeAgentId).toBeUndefined();
  });
});

describe("quotaAlertFingerprint", () => {
  it("includes the resetsAt in the fingerprint", () => {
    expect(quotaAlertFingerprint("2026-07-14T00:00:00.000Z")).toBe(
      "quota_alert:weekly:2026-07-14T00:00:00.000Z",
    );
  });
});
