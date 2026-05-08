import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { OutcomeContract } from "@paperclipai/shared";
import { evaluateOutcomeContract } from "../services/issue-outcome-enforcement.js";

/**
 * Minimal fake Drizzle DB — returns `rows` for every query regardless of table.
 * Each test constructs its own fakeDb with the rows it expects.
 */
function fakeDb(rows: Record<string, unknown>[]): Db {
  const builder = {
    select(_fields: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(_cond: unknown) {
              return {
                limit(_n: number) {
                  return Promise.resolve(rows);
                },
                // allow direct await (no limit)
                then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
                  return Promise.resolve(rows).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },
  };
  return builder as unknown as Db;
}

function wpRow(overrides: Partial<{ type: string; status: string; isPrimary: boolean }> = {}) {
  return { id: "wp-1", type: "pull_request", status: "merged", isPrimary: false, ...overrides };
}

function tiRow(
  overrides: Partial<{
    kind: string;
    status: string;
    resolvedByAgentId: string | null;
    resolvedByUserId: string | null;
  }> = {},
) {
  return {
    id: "ti-1",
    kind: "request_confirmation",
    status: "accepted",
    resolvedByAgentId: null,
    resolvedByUserId: null,
    ...overrides,
  };
}

// ─── merged_pr ────────────────────────────────────────────────────────────────

describe("evaluateOutcomeContract / merged_pr", () => {
  it("satisfied when a merged PR work product exists", async () => {
    const db = fakeDb([wpRow()]);
    const contract: OutcomeContract = { kind: "merged_pr" };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(true);
  });

  it("not satisfied when no work products exist", async () => {
    const db = fakeDb([]);
    const contract: OutcomeContract = { kind: "merged_pr" };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0].code).toBe("no_merged_pr");
      expect(result.missing[0].hint).toContain("POST /api/issues/{id}/work-products");
    }
  });

  it("not satisfied when requirePrimary=true but no primary PR exists", async () => {
    const db = fakeDb([]);
    const contract: OutcomeContract = { kind: "merged_pr", params: { requirePrimary: true } };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0].hint).toContain("isPrimary=true");
    }
  });

  it("satisfied when primary PR exists and requirePrimary=true", async () => {
    const db = fakeDb([wpRow({ isPrimary: true })]);
    const contract: OutcomeContract = { kind: "merged_pr", params: { requirePrimary: true } };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(true);
  });
});

// ─── signed_off_decision ─────────────────────────────────────────────────────

describe("evaluateOutcomeContract / signed_off_decision", () => {
  it("satisfied when accepted confirmation exists and no signers required", async () => {
    const db = fakeDb([tiRow()]);
    const contract: OutcomeContract = { kind: "signed_off_decision" };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(true);
  });

  it("not satisfied when no accepted confirmation exists", async () => {
    const db = fakeDb([]);
    const contract: OutcomeContract = { kind: "signed_off_decision" };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0].code).toBe("no_accepted_confirmation");
      expect(result.missing[0].hint).toContain("POST /api/issues/{id}/interactions");
    }
  });

  it("satisfied when agent signer matches", async () => {
    const db = fakeDb([tiRow({ resolvedByAgentId: "agent-42", resolvedByUserId: null })]);
    const contract: OutcomeContract = {
      kind: "signed_off_decision",
      signers: [{ kind: "agent", id: "agent-42" }],
    };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(true);
  });

  it("satisfied when user signer matches", async () => {
    const db = fakeDb([tiRow({ resolvedByUserId: "user-99", resolvedByAgentId: null })]);
    const contract: OutcomeContract = {
      kind: "signed_off_decision",
      signers: [{ kind: "user", id: "user-99" }],
    };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(true);
  });

  it("not satisfied on signer mismatch", async () => {
    const db = fakeDb([tiRow({ resolvedByAgentId: "agent-99", resolvedByUserId: null })]);
    const contract: OutcomeContract = {
      kind: "signed_off_decision",
      signers: [{ kind: "agent", id: "agent-different" }],
    };
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0].code).toBe("signer_mismatch");
    }
  });
});
