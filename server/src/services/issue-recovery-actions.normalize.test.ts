import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";

function collectSqlBindings(node: unknown): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string" && typeof record.columnType === "string") {
      columns.push(record.name);
    }
    if (record.constructor?.name === "Param" && "value" in record) {
      values.push(record.value);
    }
    if (Array.isArray(record.queryChunks)) {
      for (const chunk of record.queryChunks) walk(chunk);
    }
  };
  walk(node);
  return { columns, values };
}

function sameTimestamp(left: unknown, right: unknown): boolean {
  const leftMs = left instanceof Date ? left.getTime() : typeof left === "string" ? Date.parse(left) : Number.NaN;
  const rightMs = right instanceof Date ? right.getTime() : typeof right === "string" ? Date.parse(right) : Number.NaN;
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_state",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("normalizeExhaustedMissingDispositionActions", () => {
  it("normalizes a pre-existing capped active row without changing issue status", async () => {
    const legacyRow = makeRecoveryActionRow({
      id: "legacy-capped-action",
      status: "active",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      previousOwnerAgentId: "agent-1",
      maxAttempts: 1,
      evidence: {
        handoffAttempt: 1,
        maxHandoffAttempts: 1,
      },
      wakePolicy: {
        type: "wake_owner",
        reason: "source_scoped_recovery_action",
        ownerAgentId: "agent-1",
      },
    });
    let persisted: Record<string, unknown> | null = null;
    const fakeDb = {
      select: vi.fn(() => ({
        from() {
          return this;
        },
        where() {
          return Promise.resolve([legacyRow]);
        },
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          persisted = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: legacyRow.id }]),
            })),
          };
        }),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never)
      .normalizeExhaustedMissingDispositionActions();

    expect(result).toEqual({
      scanned: 1,
      normalized: 1,
      actionIds: [legacyRow.id],
    });
    expect(persisted).toMatchObject({
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      ownerUserId: null,
      previousOwnerAgentId: "agent-1",
      wakePolicy: {
        type: "board_escalation",
        reason: "successful_run_handoff_exhausted",
      },
      evidence: expect.objectContaining({
        exhausted: true,
        handoffAttempt: 1,
        maxHandoffAttempts: 1,
      }),
    });
    expect(persisted).not.toHaveProperty("sourceIssueId");
    expect(Object.keys(persisted ?? {})).not.toContain("issueStatus");
  });

  it("leaves already honest exhausted rows and live uncapped rows untouched", async () => {
    const honestRow = makeRecoveryActionRow({
      id: "honest-escalated",
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      evidence: { handoffAttempt: 1, maxHandoffAttempts: 1, exhausted: true },
      wakePolicy: { type: "board_escalation", reason: "successful_run_handoff_exhausted" },
    });
    const liveRow = makeRecoveryActionRow({
      id: "live-uncapped",
      status: "active",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      evidence: { handoffAttempt: 1, maxHandoffAttempts: 2 },
      wakePolicy: { type: "wake_owner" },
    });
    const fakeDb = {
      select: vi.fn(() => ({
        from() {
          return this;
        },
        where() {
          return Promise.resolve([honestRow, liveRow]);
        },
      })),
      update: vi.fn(),
    };

    const result = await issueRecoveryActionService(fakeDb as never)
      .normalizeExhaustedMissingDispositionActions();

    expect(result).toEqual({ scanned: 2, normalized: 0, actionIds: [] });
    expect(fakeDb.update).not.toHaveBeenCalled();
  });

  it("clears a leftover ownerUserId when canonicalizing exhausted board ownership", async () => {
    const staleOwnerRow = makeRecoveryActionRow({
      id: "board-stale-owner",
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      ownerUserId: "user-1",
      evidence: { handoffAttempt: 1, maxHandoffAttempts: 1, exhausted: true },
      wakePolicy: { type: "board_escalation", reason: "successful_run_handoff_exhausted" },
    });
    let persisted: Record<string, unknown> | null = null;
    const fakeDb = {
      select: vi.fn(() => ({
        from() {
          return this;
        },
        where() {
          return Promise.resolve([staleOwnerRow]);
        },
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          persisted = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: staleOwnerRow.id }]),
            })),
          };
        }),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never)
      .normalizeExhaustedMissingDispositionActions();

    expect(result).toEqual({
      scanned: 1,
      normalized: 1,
      actionIds: [staleOwnerRow.id],
    });
    expect(persisted).toMatchObject({
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      ownerUserId: null,
    });
  });

  it("does not overwrite a concurrently upserted live action after a stale select", async () => {
    const classifiedAt = new Date("2026-05-09T19:30:00.000Z");
    const staleRow = makeRecoveryActionRow({
      id: "shared-source-action",
      status: "active",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      ownerUserId: "user-1",
      maxAttempts: 1,
      evidence: { handoffAttempt: 1, maxHandoffAttempts: 1 },
      wakePolicy: {
        type: "wake_owner",
        reason: "source_scoped_recovery_action",
        ownerAgentId: "agent-1",
      },
      updatedAt: classifiedAt,
    });
    const liveRow = makeRecoveryActionRow({
      id: staleRow.id,
      sourceIssueId: staleRow.sourceIssueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: "agent-2",
      ownerUserId: "user-2",
      cause: "stranded_assigned_issue",
      fingerprint: "stranded:live",
      evidence: { latestRunId: "run-2" },
      wakePolicy: { type: "wake_owner" },
      updatedAt: new Date("2026-05-09T19:31:44.000Z"),
    });
    let currentRow: Record<string, unknown> = { ...staleRow };
    let appliedSet: Record<string, unknown> | null = null;
    let writeGuard: unknown;

    const fakeDb = {
      select: vi.fn(() => ({
        from() {
          return this;
        },
        where() {
          return Promise.resolve([{ ...staleRow }]);
        },
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn((predicate: unknown) => {
            writeGuard = predicate;
            currentRow = { ...liveRow };
            const bindings = collectSqlBindings(predicate);
            const matchesClassifiedRow = bindings.columns.includes("id")
              && bindings.columns.includes("cause")
              && bindings.columns.includes("updated_at")
              && bindings.values.includes(staleRow.id)
              && bindings.values.includes("successful_run_missing_state")
              && bindings.values.some((value) => sameTimestamp(value, classifiedAt));
            const liveStillMatchesClassified = currentRow.id === staleRow.id
              && currentRow.cause === "successful_run_missing_state"
              && sameTimestamp(currentRow.updatedAt, classifiedAt)
              && (currentRow.status === "active" || currentRow.status === "escalated");
            if (matchesClassifiedRow && liveStillMatchesClassified) {
              appliedSet = values;
              currentRow = { ...currentRow, ...values };
              return { returning: vi.fn(async () => [{ id: staleRow.id }]) };
            }
            return { returning: vi.fn(async () => []) };
          }),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never)
      .normalizeExhaustedMissingDispositionActions();

    const bindings = collectSqlBindings(writeGuard);
    expect(bindings.columns).toEqual(expect.arrayContaining(["id", "cause", "updated_at", "status"]));
    expect(bindings.values).toEqual(expect.arrayContaining([
      staleRow.id,
      "successful_run_missing_state",
    ]));
    expect(bindings.values.some((value) => sameTimestamp(value, classifiedAt))).toBe(true);
    expect(result).toEqual({ scanned: 1, normalized: 0, actionIds: [] });
    expect(appliedSet).toBeNull();
    expect(currentRow).toMatchObject({
      id: staleRow.id,
      cause: "stranded_assigned_issue",
      fingerprint: "stranded:live",
      ownerAgentId: "agent-2",
      ownerUserId: "user-2",
      status: "active",
    });
  });
});
