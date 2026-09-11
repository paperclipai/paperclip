import { describe, expect, it } from "vitest";
import {
  RECOVERY_ENGINEER_PROCEDURE_MAX_FAILED_REUSES,
  evaluateRecoveryEngineerProcedureApplicability,
  type RecoveryEngineerProcedureApplicabilityContext,
  type RecoveryEngineerProcedureReuseSummary,
} from "./recovery-engineer-policy.js";

const REPAIR_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "ffffffffffffffffffffffffffffffffffffffff";

function reviewedProcedure(overrides: {
  status?: string;
  failureFingerprint?: string;
  classification?: "infrastructure" | "task_defect" | null;
  repairCommit?: string;
  adapterType?: string | null;
  failedReuseCount?: number;
  invalidatedAt?: Date | null;
} = {}) {
  return {
    status: overrides.status ?? "reviewed",
    failureFingerprint: overrides.failureFingerprint ?? "fingerprint-alpha",
    classification: overrides.classification === undefined ? "task_defect" as const : overrides.classification,
    repairCommit: overrides.repairCommit ?? REPAIR_COMMIT,
    applicability: {
      adapterType: overrides.adapterType === undefined ? "codex_local" : overrides.adapterType,
      failureFingerprint: overrides.failureFingerprint ?? "fingerprint-alpha",
      classification: "task_defect" as const,
      evidenceRunId: "11111111-1111-4111-8111-111111111111",
      sourceGenerationKey: "run:alpha",
      sourceStatusVersion: 3,
    },
    failedReuseCount: overrides.failedReuseCount ?? 0,
    invalidatedAt: overrides.invalidatedAt ?? null,
  };
}

function currentContext(
  overrides: Partial<RecoveryEngineerProcedureApplicabilityContext> = {},
): RecoveryEngineerProcedureApplicabilityContext {
  return {
    failureFingerprint: "fingerprint-alpha",
    classification: "task_defect",
    adapterType: "codex_local",
    gate: "none",
    activatedRepairCommit: REPAIR_COMMIT,
    sourceGenerationKey: "run:alpha",
    ...overrides,
  };
}

function reuseHistory(
  ...entries: Array<{ status: RecoveryEngineerProcedureReuseSummary["status"]; evidenceKey: string; sourceGenerationKey?: string }>
): RecoveryEngineerProcedureReuseSummary[] {
  return entries.map((entry) => ({
    status: entry.status,
    evidenceKey: entry.evidenceKey,
    sourceGenerationKey: entry.sourceGenerationKey ?? "run:alpha",
  }));
}

describe("recovery engineer procedure applicability", () => {
  it("allows a reviewed procedure in the context it was reviewed in", () => {
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext(),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toEqual({ applicable: true, reason: null, requiresNewEvidence: false });
  });

  it("refuses a procedure that is not reviewed or has been invalidated", () => {
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure({ status: "proposed" }),
      context: currentContext(),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toMatchObject({ applicable: false, reason: "procedure_not_reviewed" });
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure({ status: "retired" }),
      context: currentContext(),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toMatchObject({ applicable: false, reason: "procedure_retired" });
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure({ invalidatedAt: new Date() }),
      context: currentContext(),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toMatchObject({ applicable: false, reason: "procedure_invalidated" });
  });

  it("never authorizes a different failure, classification, capability or deployed repair", () => {
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext({ failureFingerprint: "fingerprint-beta" }),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toMatchObject({ applicable: false, reason: "failure_fingerprint_mismatch" });
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext({ classification: "infrastructure" }),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toMatchObject({ applicable: false, reason: "classification_mismatch" });
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext({ adapterType: "claude_local" }),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toMatchObject({ applicable: false, reason: "adapter_capability_mismatch" });
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext({ activatedRepairCommit: OTHER_COMMIT }),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toMatchObject({ applicable: false, reason: "repair_commit_mismatch" });
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext({ activatedRepairCommit: null }),
      evidenceKey: "verification:1",
      reuseHistory: [],
    })).toMatchObject({ applicable: false, reason: "repair_not_activated" });
  });

  it("leaves every live gate to its owner", () => {
    for (const gate of ["human", "provider", "dependency", "owner"] as const) {
      expect(evaluateRecoveryEngineerProcedureApplicability({
        procedure: reviewedProcedure(),
        context: currentContext({ gate }),
        evidenceKey: "verification:1",
        reuseHistory: [],
      })).toMatchObject({ applicable: false, reason: "gate_owned_by_another_actor" });
    }
  });

  it("requires new evidence after a failed application and a new review after repeated failures", () => {
    const failedOnce = evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure({ failedReuseCount: 1 }),
      context: currentContext(),
      evidenceKey: "verification:1",
      reuseHistory: reuseHistory({ status: "failed", evidenceKey: "verification:1" }),
    });
    expect(failedOnce).toEqual({
      applicable: false,
      reason: "repeat_after_failed_reuse",
      requiresNewEvidence: true,
    });

    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure({ failedReuseCount: 1 }),
      context: currentContext(),
      evidenceKey: "verification:2",
      reuseHistory: reuseHistory({ status: "failed", evidenceKey: "verification:1" }),
    })).toMatchObject({ applicable: true });

    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure({ failedReuseCount: RECOVERY_ENGINEER_PROCEDURE_MAX_FAILED_REUSES }),
      context: currentContext(),
      evidenceKey: "verification:3",
      reuseHistory: reuseHistory(
        { status: "failed", evidenceKey: "verification:1" },
        { status: "failed", evidenceKey: "verification:2" },
      ),
    })).toEqual({
      applicable: false,
      reason: "procedure_requires_new_review",
      requiresNewEvidence: true,
    });
  });

  it("does not re-apply a procedure that already succeeded for the same generation", () => {
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext({ sourceGenerationKey: "run:alpha" }),
      evidenceKey: "verification:9",
      reuseHistory: reuseHistory({ status: "succeeded", evidenceKey: "verification:1" }),
    })).toMatchObject({ applicable: false, reason: "generation_already_succeeded" });
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext({ sourceGenerationKey: "run:beta" }),
      evidenceKey: "verification:9",
      reuseHistory: reuseHistory({ status: "succeeded", evidenceKey: "verification:1" }),
    })).toMatchObject({ applicable: true });
  });

  it("stays applicable for display when no evidence key has been offered yet", () => {
    expect(evaluateRecoveryEngineerProcedureApplicability({
      procedure: reviewedProcedure(),
      context: currentContext(),
      evidenceKey: null,
      reuseHistory: reuseHistory({ status: "failed", evidenceKey: "verification:1" }),
    })).toEqual({ applicable: true, reason: null, requiresNewEvidence: false });
  });
});
