/**
 * Tests for recovery-workflow-shadow
 *
 * Strategy: pure unit tests — drizzle-orm and @paperclipai/db fully mocked;
 * the Db instance is a plain mock object whose select/update chains are
 * controlled per-test.
 *
 * Fidelity constraint: shadow decisions capture only LIFECYCLE/CADENCE signals
 * (active, status, attemptCount) from dry-run results. The "which owner/user
 * to wake" decision is NOT comparable because dry-run is read-only and does
 * not simulate the forward-looking owner/wake decision. This limitation is
 * verified by asserting the presence of `fidelityNote` in DiffResult and that
 * it mentions "owner" and "wake".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoist module mocks before any imports that resolve drizzle-orm
// ---------------------------------------------------------------------------

// Mock drizzle-orm so `eq` is a simple identity that tests can detect
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ __eq: val })),
}));

// Mock @paperclipai/db — recoveryWorkflowLinks is just a sentinel object;
// the Db type is irrelevant (we pass a plain mock).
vi.mock("@paperclipai/db", () => ({
  recoveryWorkflowLinks: {
    actionId: "__actionId_col__",
  },
}));

import {
  recordShadowDecision,
  diffShadow,
  type ObservedState,
} from "../services/recovery-workflow-shadow.js";

// ---------------------------------------------------------------------------
// Mock Db builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Db whose select/update chains can be controlled.
 *
 * selectRows: what .select().from().where() resolves to
 * updateSetSpy: captured spy for the .set() call payload
 */
function makeMockDb(selectRows: unknown[]) {
  const updateSetSpy = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  });

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(selectRows),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: updateSetSpy,
    }),
    _updateSetSpy: updateSetSpy,
  };

  return db;
}

// ---------------------------------------------------------------------------
// recordShadowDecision
// ---------------------------------------------------------------------------

describe("recordShadowDecision", () => {
  it("appends a new decision to shadow_decisions with injected recordedAtMs", async () => {
    const existingDecision = {
      attemptNumber: 1,
      observed: { active: true, status: "active", attemptCount: 1 },
      recordedAtMs: 1000,
    };
    const linkRow = {
      id: "link-id-1",
      actionId: "action-1",
      shadowDecisions: [existingDecision],
    };

    const db = makeMockDb([linkRow]);

    const injectedTs = 2000;
    await recordShadowDecision(db as unknown as Parameters<typeof recordShadowDecision>[0], {
      actionId: "action-1",
      attemptNumber: 2,
      observed: { active: true, status: "active", attemptCount: 2 },
      recordedAtMs: injectedTs,
    });

    expect(db._updateSetSpy).toHaveBeenCalledOnce();
    const setPayload = db._updateSetSpy.mock.calls[0]?.[0] as {
      shadowDecisions?: unknown[];
      updatedAt?: unknown;
    };
    expect(Array.isArray(setPayload?.shadowDecisions)).toBe(true);
    const decisions = setPayload?.shadowDecisions as Array<{
      attemptNumber: number;
      observed: ObservedState;
      recordedAtMs: number;
    }>;
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toEqual(existingDecision);
    expect(decisions[1]).toEqual({
      attemptNumber: 2,
      observed: { active: true, status: "active", attemptCount: 2 },
      recordedAtMs: injectedTs,
    });
  });

  it("creates shadow_decisions array from scratch when link row has null/empty", async () => {
    const linkRow = { id: "link-id-2", actionId: "action-2", shadowDecisions: null };
    const db = makeMockDb([linkRow]);

    await recordShadowDecision(db as unknown as Parameters<typeof recordShadowDecision>[0], {
      actionId: "action-2",
      attemptNumber: 1,
      observed: { active: false, status: "resolved", attemptCount: 3 },
      recordedAtMs: 5000,
    });

    const setPayload = db._updateSetSpy.mock.calls[0]?.[0] as {
      shadowDecisions?: unknown[];
    };
    const decisions = setPayload?.shadowDecisions as Array<{
      attemptNumber: number;
      observed: ObservedState;
      recordedAtMs: number;
    }>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual({
      attemptNumber: 1,
      observed: { active: false, status: "resolved", attemptCount: 3 },
      recordedAtMs: 5000,
    });
  });

  it("is a no-op and does NOT call db.update when link row is missing", async () => {
    const db = makeMockDb([]); // empty result — no row found

    await expect(
      recordShadowDecision(db as unknown as Parameters<typeof recordShadowDecision>[0], {
        actionId: "action-missing",
        attemptNumber: 1,
        observed: { active: true, status: "active", attemptCount: 1 },
        recordedAtMs: 1000,
      }),
    ).resolves.toBeUndefined();

    expect(db.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// diffShadow
// ---------------------------------------------------------------------------

describe("diffShadow", () => {
  it("flags agreement when workflow-observed lifecycle matches liveActual", async () => {
    const linkRow = {
      id: "link-id-3",
      actionId: "action-3",
      shadowDecisions: [
        {
          attemptNumber: 1,
          observed: { active: true, status: "active", attemptCount: 1 },
          recordedAtMs: 1000,
        },
        {
          attemptNumber: 2,
          observed: { active: true, status: "active", attemptCount: 2 },
          recordedAtMs: 2000,
        },
      ],
    };

    const db = makeMockDb([linkRow]);

    const result = await diffShadow(db as unknown as Parameters<typeof diffShadow>[0], {
      actionId: "action-3",
      liveActual: { active: true, status: "active", attemptCount: 2 },
    });

    expect(result.actionId).toBe("action-3");
    expect(result.mismatches).toHaveLength(0);
    // 2 decisions × 3 signals each = 6 agreements (active, status, attemptCount)
    // (attemptCount for decision 1: |1-2|=1 ≤ tolerance=1, so also agreement)
    expect(result.agreements.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/agreement/i);
    // fidelityNote must mention owner and wake
    expect(result.fidelityNote).toMatch(/owner/i);
    expect(result.fidelityNote).toMatch(/wake/i);
  });

  it("flags mismatch when workflow observed resolved but live is still active", async () => {
    const linkRow = {
      id: "link-id-4",
      actionId: "action-4",
      shadowDecisions: [
        {
          attemptNumber: 1,
          observed: { active: false, status: "resolved", attemptCount: 2 },
          recordedAtMs: 3000,
        },
      ],
    };

    const db = makeMockDb([linkRow]);

    const result = await diffShadow(db as unknown as Parameters<typeof diffShadow>[0], {
      actionId: "action-4",
      liveActual: { active: true, status: "active", attemptCount: 2 },
    });

    expect(result.actionId).toBe("action-4");
    expect(result.mismatches.length).toBeGreaterThan(0);

    const activeMismatch = result.mismatches.find((m) => m.field === "active");
    expect(activeMismatch).toMatchObject({
      attemptNumber: 1,
      field: "active",
      observed: false,
      live: true,
    });

    const statusMismatch = result.mismatches.find((m) => m.field === "status");
    expect(statusMismatch).toMatchObject({
      attemptNumber: 1,
      field: "status",
      observed: "resolved",
      live: "active",
    });

    expect(result.summary).toMatch(/mismatch/i);
  });

  it("flags mismatch when attemptCount diverges beyond tolerance (>1)", async () => {
    const linkRow = {
      id: "link-id-5",
      actionId: "action-5",
      shadowDecisions: [
        {
          attemptNumber: 1,
          observed: { active: true, status: "active", attemptCount: 1 },
          recordedAtMs: 1000,
        },
      ],
    };

    const db = makeMockDb([linkRow]);

    // Live has attemptCount=5; workflow only saw 1 — diverged beyond tolerance=1
    const result = await diffShadow(db as unknown as Parameters<typeof diffShadow>[0], {
      actionId: "action-5",
      liveActual: { active: true, status: "active", attemptCount: 5 },
    });

    const countMismatch = result.mismatches.find((m) => m.field === "attemptCount");
    expect(countMismatch).toBeDefined();
    expect(countMismatch?.observed).toBe(1);
    expect(countMismatch?.live).toBe(5);
  });

  it("result includes fidelityNote documenting owner/wake comparison limitation", async () => {
    const db = makeMockDb([
      { id: "link-id-6", actionId: "action-6", shadowDecisions: [] },
    ]);

    const result = await diffShadow(db as unknown as Parameters<typeof diffShadow>[0], {
      actionId: "action-6",
      liveActual: { active: false, status: "resolved", attemptCount: 0 },
    });

    expect(result.fidelityNote).toMatch(/owner/i);
    expect(result.fidelityNote).toMatch(/wake/i);
  });

  it("returns empty agreements/mismatches when no shadow decisions recorded", async () => {
    const db = makeMockDb([
      { id: "link-id-7", actionId: "action-7", shadowDecisions: [] },
    ]);

    const result = await diffShadow(db as unknown as Parameters<typeof diffShadow>[0], {
      actionId: "action-7",
      liveActual: { active: true, status: "active", attemptCount: 1 },
    });

    expect(result.agreements).toHaveLength(0);
    expect(result.mismatches).toHaveLength(0);
    expect(result.summary).toMatch(/no shadow decisions/i);
  });
});
