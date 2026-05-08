import { describe, expect, it } from "vitest";
import { evaluateOutcomeContract } from "./issue-outcome-enforcement.js";
import type { OutcomeContract } from "@paperclipai/shared";

type Row = Record<string, unknown>;

function makeDb(rows: Row[]) {
  const leaf = {
    limit: (_n: number) => Promise.resolve(rows),
    then: (cb: (rows: Row[]) => unknown) => Promise.resolve(cb(rows)),
  };
  return {
    select: () => ({ from: () => ({ where: () => leaf }) }),
  } as any;
}

describe("evaluateOutcomeContract — merged_pr", () => {
  const contract: OutcomeContract = { kind: "merged_pr" };

  it("satisfied when a merged PR row exists", async () => {
    const db = makeDb([{ id: "pr-1" }]);
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(true);
  });

  it("not satisfied when no merged PR rows", async () => {
    const db = makeDb([]);
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0].code).toBe("no_merged_pr");
      expect(result.missing[0].hint).toContain("POST /api/issues");
    }
  });

  it("requirePrimary=true: not satisfied when no rows returned (DB filters primary)", async () => {
    const db = makeDb([]);
    const contractWithPrimary: OutcomeContract = {
      kind: "merged_pr",
      params: { requirePrimary: true },
    };
    const result = await evaluateOutcomeContract(db, "issue-1", contractWithPrimary);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0].hint).toContain("isPrimary=true");
    }
  });

  it("requirePrimary=true: satisfied when a primary merged PR row exists", async () => {
    const db = makeDb([{ id: "pr-2" }]);
    const contractWithPrimary: OutcomeContract = {
      kind: "merged_pr",
      params: { requirePrimary: true },
    };
    const result = await evaluateOutcomeContract(db, "issue-1", contractWithPrimary);
    expect(result.satisfied).toBe(true);
  });
});

describe("evaluateOutcomeContract — signed_off_decision", () => {
  const contract: OutcomeContract = { kind: "signed_off_decision" };

  it("satisfied when an accepted confirmation exists and no signers required", async () => {
    const db = makeDb([{ id: "int-1", resolvedByAgentId: "agent-a", resolvedByUserId: null, status: "accepted" }]);
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(true);
  });

  it("not satisfied when no accepted confirmations exist", async () => {
    const db = makeDb([]);
    const result = await evaluateOutcomeContract(db, "issue-1", contract);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0].code).toBe("no_accepted_confirmation");
    }
  });

  it("satisfied when signer agent matches resolvedByAgentId", async () => {
    const db = makeDb([{ id: "int-1", resolvedByAgentId: "agent-a", resolvedByUserId: null, status: "accepted" }]);
    const contractWithSigner: OutcomeContract = {
      kind: "signed_off_decision",
      signers: [{ kind: "agent", id: "agent-a" }],
    };
    const result = await evaluateOutcomeContract(db, "issue-1", contractWithSigner);
    expect(result.satisfied).toBe(true);
  });

  it("satisfied when signer user matches resolvedByUserId", async () => {
    const db = makeDb([{ id: "int-1", resolvedByAgentId: null, resolvedByUserId: "user-x", status: "accepted" }]);
    const contractWithSigner: OutcomeContract = {
      kind: "signed_off_decision",
      signers: [{ kind: "user", id: "user-x" }],
    };
    const result = await evaluateOutcomeContract(db, "issue-1", contractWithSigner);
    expect(result.satisfied).toBe(true);
  });

  it("not satisfied on signer mismatch", async () => {
    const db = makeDb([{ id: "int-1", resolvedByAgentId: "agent-b", resolvedByUserId: null, status: "accepted" }]);
    const contractWithSigner: OutcomeContract = {
      kind: "signed_off_decision",
      signers: [{ kind: "agent", id: "agent-a" }],
    };
    const result = await evaluateOutcomeContract(db, "issue-1", contractWithSigner);
    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0].code).toBe("signer_mismatch");
      expect(result.missing[0].hint).toContain("agent:agent-a");
    }
  });
});
