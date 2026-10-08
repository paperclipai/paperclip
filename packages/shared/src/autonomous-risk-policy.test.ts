import { describe, expect, it } from "vitest";
import {
  autonomousRiskDecisionSchema,
  createAutonomousBackupManifest,
  createAutonomousCheckpointManifest,
  createAutonomousRollbackCommandMetadata,
  createAutonomousRollbackManifest,
  decideAutonomousRisk,
  getAutonomousRiskDecisionBindingIssue,
  type AutonomousRiskInput,
} from "./autonomous-risk-policy.js";

const baseInput: AutonomousRiskInput = {
  actionId: "action-001",
  executionId: "exec-001",
  taskId: "task-001",
  risk: "LOW",
  approval: "NOT_REQUIRED",
  checkpoint: null,
  backup: null,
  rollback: null,
};

const checkpoint = createAutonomousCheckpointManifest({
  manifestId: "checkpoint-001",
  actionId: "action-001",
  executionId: "exec-001",
  taskId: "task-001",
  createdAt: "2026-09-27T00:00:00.000Z",
  scope: "issue-001",
  artifactRefs: ["artifact://run-001/checkpoint"],
});
const backup = createAutonomousBackupManifest({
  manifestId: "backup-001",
  actionId: "action-001",
  executionId: "exec-001",
  taskId: "task-001",
  createdAt: "2026-09-27T00:00:00.000Z",
  sourceRef: "artifact://run-001/source",
  artifactRefs: ["artifact://run-001/backup"],
});
const rollback = createAutonomousRollbackCommandMetadata({
  rollbackId: "rollback-001",
  manifestId: "backup-001",
  command: "paperclip restore",
  args: ["--manifest", "backup-001"],
  reason: "restore the prior backup",
});
const rollbackManifest = createAutonomousRollbackManifest({
  manifestId: "rollback-manifest-001",
  actionId: "action-001",
  executionId: "exec-001",
  taskId: "task-001",
  createdAt: "2026-09-27T00:00:00.000Z",
  backupManifestId: "backup-001",
  command: rollback,
});

describe("autonomous risk policy", () => {
  it("treats LOW actions as disposable with no checkpoint, backup, rollback, or approval", () => {
    const first = decideAutonomousRisk(baseInput);
    const second = decideAutonomousRisk({ ...baseInput });

    expect(first).toMatchObject({
      outcome: "ALLOW",
      reasonCode: "low_disposable",
      disposable: true,
      requiresCheckpoint: false,
      requiresBackup: false,
      requiresApproval: false,
      requiresRollback: false,
    });
    expect(second).toEqual(first);
  });

  it("requires checkpoint and backup manifests for MEDIUM actions", () => {
    expect(decideAutonomousRisk({ ...baseInput, risk: "MEDIUM" })).toMatchObject({
      outcome: "DENY",
      reasonCode: "missing_checkpoint",
      requiresCheckpoint: true,
      requiresBackup: true,
    });
    expect(
      decideAutonomousRisk({ ...baseInput, risk: "MEDIUM", checkpoint, backup }),
    ).toMatchObject({ outcome: "ALLOW", reasonCode: "checkpoint_and_backup_present", disposable: false });
  });

  it("requires explicit approval and rollback metadata for HIGH actions", () => {
    const high = { ...baseInput, risk: "HIGH" as const, checkpoint: null, backup: null };
    expect(decideAutonomousRisk(high)).toMatchObject({ outcome: "REQUIRE_APPROVAL", reasonCode: "approval_required" });
    expect(decideAutonomousRisk({ ...high, approval: "DENIED" })).toMatchObject({
      outcome: "DENY",
      reasonCode: "approval_denied",
    });
    expect(decideAutonomousRisk({ ...high, approval: "GRANTED" })).toMatchObject({
      outcome: "DENY",
      reasonCode: "missing_rollback",
    });
    const allowed = decideAutonomousRisk({ ...high, approval: "GRANTED", rollback: rollbackManifest });
    expect(allowed).toMatchObject({
      outcome: "ALLOW",
      reasonCode: "approval_and_rollback_present",
      requiresApproval: true,
      requiresRollback: true,
      rollback: rollbackManifest,
    });
    expect(autonomousRiskDecisionSchema.parse(JSON.parse(JSON.stringify(allowed)))).toEqual(allowed);
  });

  it("derives required rollback from HIGH policy instead of trusting serialized flags", () => {
    const denied = decideAutonomousRisk({ ...baseInput, risk: "HIGH", approval: "GRANTED" });
    const forged = { ...denied, requiresRollback: false, reasonCode: "missing_rollback" as const, decisionId: `autonomous-risk/${denied.actionId}/HIGH/DENY/missing_rollback` };
    expect(getAutonomousRiskDecisionBindingIssue({ decision: forged, risk: "HIGH", approval: "GRANTED", gateDecision: "PASS" })).toBe("rollback_evidence_missing");
  });

  it("redacts rollback evidence and strictly rejects secret or chain-of-thought fields", () => {
    const redacted = createAutonomousRollbackCommandMetadata({
      rollbackId: "rollback-002",
      manifestId: "backup-001",
      command: "restore --token=private-value",
      args: ["--password=private-value", "safe"],
      reason: "chain of thought: hidden token=private-value",
    });

    expect(redacted).toMatchObject({
      command: "[REDACTED]",
      args: ["[REDACTED]", "safe"],
      reason: "[REDACTED]",
    });
    expect(JSON.stringify(redacted)).not.toMatch(/private-value|token=|password=|chain of thought|secret/i);
    expect(() => createAutonomousRollbackCommandMetadata({
      rollbackId: "rollback-003",
      manifestId: "backup-001",
      command: "restore",
      args: [],
      reason: "safe",
      chainOfThought: "nope" as never,
    })).toThrow();
  });
});
