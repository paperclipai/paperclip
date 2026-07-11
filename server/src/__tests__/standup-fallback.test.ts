import { describe, expect, it, vi, beforeEach } from "vitest";

// Hoist mock setup before any imports
const mockIssueCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "fallback-issue-1" }));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({ create: mockIssueCreate })),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Build a drizzle-like mock db. The query builder chains are:
//   isStandupParticipant:    db.select().from().where().limit()           → row[]  [called first]
//   hasOpenFallbackForWindow:db.select().from().where().limit()           → row[]  [called second]
//   findCeoAgentId:          db.select().from().where().orderBy().limit() → row[]  [called third]
//
// A call counter routes each select to the appropriate result factory.

type SelectResultFactory = () => Promise<{ id: string }[]>;

function buildMockDb(
  participantCheckResult: SelectResultFactory,
  openFallbackCheckResult: SelectResultFactory,
  ceoLookupResult: SelectResultFactory,
) {
  let callIndex = 0;

  function makeChain(resolve: SelectResultFactory) {
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

  const factories = [participantCheckResult, openFallbackCheckResult, ceoLookupResult];
  return {
    select: vi.fn().mockImplementation(() => {
      const resolver = factories[callIndex] ?? ceoLookupResult;
      callIndex++;
      return makeChain(resolver);
    }),
  };
}

import {
  checkAndFireStandupFallback,
  standupFallbackFingerprint,
  STANDUP_FALLBACK_ORIGIN_KIND,
} from "../services/standup-fallback.js";

const COMPANY_ID = "company-abc";
const AGENT_ID = "cro-agent-uuid";
const RESETS_AT = "2026-07-21T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkAndFireStandupFallback — happy path", () => {
  it("creates a high-priority standup fallback issue assigned to the CEO", async () => {
    const db = buildMockDb(
      () => Promise.resolve([{ id: "policy-1" }]),   // participant check: is participant
      () => Promise.resolve([]),                      // open fallback check: none exists
      () => Promise.resolve([{ id: "ceo-agent-uuid" }]), // CEO lookup: found
    );

    await checkAndFireStandupFallback(db as never, COMPANY_ID, AGENT_ID, RESETS_AT);

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    const [calledCompanyId, createData] = mockIssueCreate.mock.calls[0]!;
    expect(calledCompanyId).toBe(COMPANY_ID);
    expect(createData.priority).toBe("high");
    expect(createData.status).toBe("todo");
    expect(createData.title).toContain("[STANDUP FALLBACK]");
    expect(createData.title).toContain(RESETS_AT);
    expect(createData.assigneeAgentId).toBe("ceo-agent-uuid");
    expect(createData.originKind).toBe(STANDUP_FALLBACK_ORIGIN_KIND);
    expect(createData.originFingerprint).toBe(standupFallbackFingerprint(AGENT_ID, RESETS_AT));
  });

  it("creates the issue without a CEO assignee when no CEO agent exists", async () => {
    const db = buildMockDb(
      () => Promise.resolve([{ id: "policy-1" }]),
      () => Promise.resolve([]),
      () => Promise.resolve([]),  // CEO lookup: not found
    );

    await checkAndFireStandupFallback(db as never, COMPANY_ID, AGENT_ID, RESETS_AT);

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    expect(mockIssueCreate.mock.calls[0]![1].assigneeAgentId).toBeUndefined();
  });

  it("includes the CAR standup template in the description", async () => {
    const db = buildMockDb(
      () => Promise.resolve([{ id: "policy-1" }]),
      () => Promise.resolve([]),
      () => Promise.resolve([]),
    );

    await checkAndFireStandupFallback(db as never, COMPANY_ID, AGENT_ID, null);

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    const description: string = mockIssueCreate.mock.calls[0]![1].description;
    expect(description).toContain("whatHappened");
    expect(description).toContain("nextAction");
    expect(description).toContain("existentialRiskAssessment");
    expect(description).toContain("chosenPaperAction");
  });
});

describe("checkAndFireStandupFallback — skips when not a standup participant", () => {
  it("does not create an issue when the agent is not in any active standup policy", async () => {
    const db = buildMockDb(
      () => Promise.resolve([]),   // participant check: not a participant
      () => Promise.resolve([]),
      () => Promise.resolve([]),
    );

    await checkAndFireStandupFallback(db as never, COMPANY_ID, AGENT_ID, RESETS_AT);

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });
});

describe("checkAndFireStandupFallback — deduplication", () => {
  it("does not create a second fallback when an open fallback already exists for the same quota window", async () => {
    const db = buildMockDb(
      () => Promise.resolve([{ id: "policy-1" }]),              // is participant
      () => Promise.resolve([{ id: "existing-fallback-issue" }]), // already open
      () => Promise.resolve([{ id: "ceo-agent-uuid" }]),
    );

    await checkAndFireStandupFallback(db as never, COMPANY_ID, AGENT_ID, RESETS_AT);

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });

  it("creates a new fallback when no existing open fallback for this quota window", async () => {
    const db = buildMockDb(
      () => Promise.resolve([{ id: "policy-1" }]),
      () => Promise.resolve([]),  // no existing open fallback
      () => Promise.resolve([]),
    );

    await checkAndFireStandupFallback(db as never, COMPANY_ID, AGENT_ID, RESETS_AT);

    expect(mockIssueCreate).toHaveBeenCalledOnce();
  });

  it("uses 'unknown' window key when quotaResetsAt is null (still deduplicates)", async () => {
    const db = buildMockDb(
      () => Promise.resolve([{ id: "policy-1" }]),
      () => Promise.resolve([]),
      () => Promise.resolve([]),
    );

    await checkAndFireStandupFallback(db as never, COMPANY_ID, AGENT_ID, null);

    expect(mockIssueCreate).toHaveBeenCalledOnce();
    const fingerprint: string = mockIssueCreate.mock.calls[0]![1].originFingerprint;
    expect(fingerprint).toBe(standupFallbackFingerprint(AGENT_ID, "unknown"));
  });
});

describe("checkAndFireStandupFallback — error resilience", () => {
  it("does not throw when db rejects", async () => {
    const db = {
      select: vi.fn().mockImplementation(() => {
        throw new Error("db connection refused");
      }),
    };

    await expect(
      checkAndFireStandupFallback(db as never, COMPANY_ID, AGENT_ID, RESETS_AT),
    ).resolves.toBeUndefined();

    expect(mockIssueCreate).not.toHaveBeenCalled();
  });
});

describe("standupFallbackFingerprint", () => {
  it("produces a stable fingerprint from agentId and quotaResetsAt", () => {
    expect(standupFallbackFingerprint("agent-xyz", "2026-07-21T00:00:00.000Z")).toBe(
      "standup_fallback:weekly:agent-xyz:2026-07-21T00:00:00.000Z",
    );
  });

  it("uses 'unknown' when quotaResetsAt is the sentinel", () => {
    expect(standupFallbackFingerprint("agent-xyz", "unknown")).toBe(
      "standup_fallback:weekly:agent-xyz:unknown",
    );
  });
});
