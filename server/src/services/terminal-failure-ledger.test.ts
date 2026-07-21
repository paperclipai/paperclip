/**
 * Tests for the terminal failure fail-closed ledger (FALA-880).
 *
 * Verifies:
 * - First delivery creates exactly one ledger comment.
 * - Re-delivery of the same (agentId, rootRunId, cause) deduplicates:
 *   no new comment, redeliveryCount incremented.
 * - dedupe key normalization is stable.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildDedupeKey, normalizeFailureCause, recordTerminalFailure } from "./terminal-failure-ledger.js";
import type { TerminalFailureInput } from "./terminal-failure-ledger.js";

// ---------------------------------------------------------------------------
// Pure-function tests (no DB required)
// ---------------------------------------------------------------------------

describe("normalizeFailureCause", () => {
  it("lowercases and collapses punctuation", () => {
    expect(normalizeFailureCause("process_lost")).toBe("process_lost");
    expect(normalizeFailureCause("Process Lost")).toBe("process_lost");
    expect(normalizeFailureCause("process-lost!")).toBe("process_lost");
    expect(normalizeFailureCause("  PROCESS LOST  ")).toBe("process_lost");
  });

  it("produces stable output for equivalent inputs", () => {
    const a = normalizeFailureCause("process_lost");
    const b = normalizeFailureCause("process lost");
    const c = normalizeFailureCause("process-lost");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("buildDedupeKey", () => {
  it("combines agentId, rootRunId, and normalized cause", () => {
    const key = buildDedupeKey("agent-1", "root-run-1", "process_lost");
    expect(key).toBe("agent-1|root-run-1|process_lost");
  });

  it("normalizes the failure cause in the key", () => {
    const key1 = buildDedupeKey("a", "r", "process_lost");
    const key2 = buildDedupeKey("a", "r", "Process Lost");
    expect(key1).toBe(key2);
  });

  it("differentiates on agentId", () => {
    const key1 = buildDedupeKey("agent-1", "root", "process_lost");
    const key2 = buildDedupeKey("agent-2", "root", "process_lost");
    expect(key1).not.toBe(key2);
  });

  it("differentiates on rootRunId", () => {
    const key1 = buildDedupeKey("agent", "root-1", "process_lost");
    const key2 = buildDedupeKey("agent", "root-2", "process_lost");
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// DB-backed behaviour — mocked drizzle
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();

// Mock the logger so we don't need transport config.
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

// Minimal fake drizzle Db shaped for the paths we exercise.
function buildMockDb(existingComment: { id: string; metadata: Record<string, unknown> } | null) {
  const selectRows = existingComment ? [existingComment] : [];
  const insertValues: Record<string, unknown>[] = [];
  const updatePatches: Array<{ set: Record<string, unknown>; where: unknown }> = [];

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectRows),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        insertValues.push(row);
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updatePatches.push({ set: patch, where });
          return Promise.resolve();
        },
      }),
    }),
    _insertValues: insertValues,
    _updatePatches: updatePatches,
  };

  return db as unknown as import("@paperclipai/db").Db;
}

const BASE_INPUT: TerminalFailureInput = {
  companyId: "company-1",
  agentId: "agent-1",
  issueId: "issue-1",
  runId: "run-1",
  rootRunId: "root-1",
  failureCause: "process_lost",
};

describe("recordTerminalFailure — first delivery", () => {
  it("creates exactly one ledger comment", async () => {
    const db = buildMockDb(null);
    const result = await recordTerminalFailure(db, BASE_INPUT);

    expect(result.kind).toBe("created");
    expect(typeof result.commentId).toBe("string");
    expect(result.dedupeKey).toBe(buildDedupeKey("agent-1", "root-1", "process_lost"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    expect(dbAny._insertValues).toHaveLength(1);
    expect(dbAny._updatePatches).toHaveLength(0);

    const inserted = dbAny._insertValues[0] as Record<string, unknown>;
    const meta = inserted.metadata as Record<string, unknown>;
    expect(meta.terminalFailureDedupeKey).toBe(result.dedupeKey);
    expect(meta.redeliveryCount).toBe(0);
  });
});

describe("recordTerminalFailure — re-delivery (deduplicate)", () => {
  it("does not create a duplicate comment; increments redeliveryCount", async () => {
    const existingMeta = {
      terminalFailureDedupeKey: buildDedupeKey("agent-1", "root-1", "process_lost"),
      redeliveryCount: 0,
    };
    const db = buildMockDb({ id: "existing-comment-1", metadata: existingMeta });
    const result = await recordTerminalFailure(db, BASE_INPUT);

    expect(result.kind).toBe("deduplicated");
    expect(result.commentId).toBe("existing-comment-1");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    // No new comment inserted.
    expect(dbAny._insertValues).toHaveLength(0);
    // Existing comment updated with incremented count.
    expect(dbAny._updatePatches).toHaveLength(1);
    const patch = dbAny._updatePatches[0].set as Record<string, unknown>;
    const patchedMeta = patch.metadata as Record<string, unknown>;
    expect(patchedMeta.redeliveryCount).toBe(1);
  });

  it("duplicate 0 — re-delivery of same event produces 0 new top-level comments", async () => {
    // Simulate: first delivery → create; then two re-deliveries → 0 new comments.
    const dedupeKey = buildDedupeKey("agent-1", "root-1", "process_lost");

    // First delivery: no existing comment.
    const dbFirst = buildMockDb(null);
    const first = await recordTerminalFailure(dbFirst, BASE_INPUT);
    expect(first.kind).toBe("created");

    // Second delivery (re-delivery 1): comment now exists.
    const dbSecond = buildMockDb({ id: first.commentId, metadata: { terminalFailureDedupeKey: dedupeKey, redeliveryCount: 0 } });
    const second = await recordTerminalFailure(dbSecond, BASE_INPUT);
    expect(second.kind).toBe("deduplicated");
    expect((dbSecond as any)._insertValues).toHaveLength(0);

    // Third delivery (re-delivery 2): still no new comment.
    const dbThird = buildMockDb({ id: first.commentId, metadata: { terminalFailureDedupeKey: dedupeKey, redeliveryCount: 1 } });
    const third = await recordTerminalFailure(dbThird, BASE_INPUT);
    expect(third.kind).toBe("deduplicated");
    expect((dbThird as any)._insertValues).toHaveLength(0);
  });
});
