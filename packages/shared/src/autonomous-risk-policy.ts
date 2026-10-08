import { z } from "zod";

const autonomousRiskIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const autonomousTimestampSchema = z.string().datetime({ offset: true });
const SENSITIVE_VALUE_PATTERN = /api[_-]?key\s*[:=]|secret\s*[:=]|token\s*[:=]|password\s*[:=]|credential\s*[:=]|chain[_ -]?of[_ -]?thought|reasoning\s*[:=]|raw[_ -]?output/i;
const SENSITIVE_FIELD_PATTERN = /api[_-]?key|secret|token|password|credential|authorization|private\s*key|chain[_ -]?of[_ -]?thought|reasoning|raw[_ -]?output|prompt/i;

export const AUTONOMOUS_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH"] as const;
export type AutonomousRiskClass = (typeof AUTONOMOUS_RISK_CLASSES)[number];
export const autonomousRiskClassSchema = z.enum(AUTONOMOUS_RISK_CLASSES);

export const AUTONOMOUS_APPROVAL_STATES = ["NOT_REQUIRED", "PENDING", "GRANTED", "DENIED"] as const;
export type AutonomousApprovalState = (typeof AUTONOMOUS_APPROVAL_STATES)[number];
export const autonomousApprovalStateSchema = z.enum(AUTONOMOUS_APPROVAL_STATES);

export const AUTONOMOUS_RISK_OUTCOMES = ["ALLOW", "DENY", "REQUIRE_APPROVAL"] as const;
export type AutonomousRiskOutcome = (typeof AUTONOMOUS_RISK_OUTCOMES)[number];
export const autonomousRiskOutcomeSchema = z.enum(AUTONOMOUS_RISK_OUTCOMES);

export const AUTONOMOUS_RISK_REASON_CODES = [
  "low_disposable",
  "missing_checkpoint",
  "missing_backup",
  "checkpoint_and_backup_present",
  "approval_required",
  "approval_denied",
  "missing_rollback",
  "approval_and_rollback_present",
] as const;
export type AutonomousRiskReasonCode = (typeof AUTONOMOUS_RISK_REASON_CODES)[number];
export const autonomousRiskReasonCodeSchema = z.enum(AUTONOMOUS_RISK_REASON_CODES);

const artifactRefSchema = z.string().min(1).max(512).regex(/^artifact:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const autonomousCheckpointManifestSchema = z
  .object({
    manifestId: autonomousRiskIdSchema,
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    createdAt: autonomousTimestampSchema,
    scope: autonomousRiskIdSchema,
    artifactRefs: z.array(artifactRefSchema).min(1).max(100),
  })
  .strict();
export type AutonomousCheckpointManifest = z.infer<typeof autonomousCheckpointManifestSchema>;

export const autonomousBackupManifestSchema = z
  .object({
    manifestId: autonomousRiskIdSchema,
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    createdAt: autonomousTimestampSchema,
    sourceRef: artifactRefSchema,
    artifactRefs: z.array(artifactRefSchema).min(1).max(100),
  })
  .strict();
export type AutonomousBackupManifest = z.infer<typeof autonomousBackupManifestSchema>;

export const autonomousRollbackCommandMetadataSchema = z
  .object({
    rollbackId: autonomousRiskIdSchema,
    manifestId: autonomousRiskIdSchema,
    command: z.string().trim().min(1).max(512),
    args: z.array(z.string().max(512)).max(100),
    reason: z.string().trim().min(1).max(240),
  })
  .strict()
  .superRefine((value, ctx) => {
    const values = [value.command, value.reason, ...value.args];
    if (values.some((entry) => SENSITIVE_VALUE_PATTERN.test(entry) || SENSITIVE_FIELD_PATTERN.test(entry))) {
      ctx.addIssue({ code: "custom", message: "Rollback metadata must be redacted" });
    }
  });
export type AutonomousRollbackCommandMetadata = z.infer<typeof autonomousRollbackCommandMetadataSchema>;

export const autonomousRollbackManifestSchema = z
  .object({
    manifestId: autonomousRiskIdSchema,
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    createdAt: autonomousTimestampSchema,
    backupManifestId: autonomousRiskIdSchema,
    command: autonomousRollbackCommandMetadataSchema,
  })
  .strict();
export type AutonomousRollbackManifest = z.infer<typeof autonomousRollbackManifestSchema>;

const autonomousRollbackEvidenceSchema = z.union([
  autonomousRollbackCommandMetadataSchema,
  autonomousRollbackManifestSchema,
]);

export const autonomousRiskInputSchema = z
  .object({
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    risk: autonomousRiskClassSchema,
    approval: autonomousApprovalStateSchema,
    checkpoint: autonomousCheckpointManifestSchema.nullable(),
    backup: autonomousBackupManifestSchema.nullable(),
    rollback: autonomousRollbackEvidenceSchema.nullable(),
  })
  .strict();
export type AutonomousRiskInput = z.infer<typeof autonomousRiskInputSchema>;

export const autonomousRiskDecisionSchema = z
  .object({
    decisionId: z.string().min(1).max(1024),
    actionId: autonomousRiskIdSchema,
    executionId: autonomousRiskIdSchema,
    taskId: autonomousRiskIdSchema,
    risk: autonomousRiskClassSchema,
    outcome: autonomousRiskOutcomeSchema,
    reasonCode: autonomousRiskReasonCodeSchema,
    disposable: z.boolean(),
    requiresCheckpoint: z.boolean(),
    requiresBackup: z.boolean(),
    requiresApproval: z.boolean(),
    requiresRollback: z.boolean(),
    checkpointManifestId: autonomousRiskIdSchema.nullable(),
    backupManifestId: autonomousRiskIdSchema.nullable(),
    checkpointManifest: autonomousCheckpointManifestSchema.nullable(),
    backupManifest: autonomousBackupManifestSchema.nullable(),
    rollback: autonomousRollbackEvidenceSchema.nullable(),
  })
  .strict();
export type AutonomousRiskDecision = z.infer<typeof autonomousRiskDecisionSchema>;

export type AutonomousRiskDecisionBindingIssue =
  | "risk_mismatch"
  | "identity_mismatch"
  | "decision_id_mismatch"
  | "reason_code_mismatch"
  | "checkpoint_evidence_missing"
  | "checkpoint_evidence_unexpected"
  | "checkpoint_binding_mismatch"
  | "backup_evidence_missing"
  | "backup_evidence_unexpected"
  | "backup_binding_mismatch"
  | "rollback_evidence_missing"
  | "rollback_evidence_unexpected"
  | "rollback_binding_mismatch"
  | "approval_not_granted"
  | "approval_unexpected"
  | "gate_failed"
  | "outcome_not_allow";

/**
 * Validates that a serialized risk decision is still bound to the admission
 * evidence that accompanies it. Callers must reject a non-null issue; this
 * helper deliberately does not infer or repair missing approval/evidence.
 */
export function getAutonomousRiskDecisionBindingIssue(input: {
  decision: AutonomousRiskDecision;
  risk: AutonomousRiskClass | "CRITICAL";
  approval: AutonomousApprovalState;
  gateDecision: "PASS" | "FAIL";
  actionId?: string;
  executionId?: string;
  taskId?: string;
}): AutonomousRiskDecisionBindingIssue | null {
  const { decision, risk, approval, gateDecision } = input;
  if (decision.risk !== risk) return "risk_mismatch";
  if (
    (input.actionId !== undefined && decision.actionId !== input.actionId) ||
    (input.executionId !== undefined && decision.executionId !== input.executionId) ||
    (input.taskId !== undefined && decision.taskId !== input.taskId)
  ) {
    return "identity_mismatch";
  }
  const expectedDecisionId = `autonomous-risk/${decision.actionId}/${decision.risk}/${decision.outcome}/${decision.reasonCode}`;
  if (decision.decisionId !== expectedDecisionId) return "decision_id_mismatch";

  // Recompute the policy from the serialized evidence. The requires* fields,
  // outcome, and reason are claims, not authority supplied by the caller.
  const policy = decideAutonomousRisk({
    actionId: decision.actionId,
    executionId: decision.executionId,
    taskId: decision.taskId,
    risk: decision.risk,
    approval,
    checkpoint: decision.checkpointManifest,
    backup: decision.backupManifest,
    rollback: decision.rollback,
  });

  const checkpointPresent = decision.checkpointManifest !== null;
  if (decision.requiresCheckpoint !== checkpointPresent) {
    return decision.requiresCheckpoint ? "checkpoint_evidence_missing" : "checkpoint_evidence_unexpected";
  }
  if (decision.checkpointManifestId !== (decision.checkpointManifest?.manifestId ?? null)) {
    return "checkpoint_binding_mismatch";
  }
  if (decision.checkpointManifest && (
    decision.checkpointManifest.actionId !== decision.actionId ||
    decision.checkpointManifest.executionId !== decision.executionId ||
    decision.checkpointManifest.taskId !== decision.taskId
  )) {
    return "checkpoint_binding_mismatch";
  }

  const backupPresent = decision.backupManifest !== null;
  if (decision.requiresBackup !== backupPresent) {
    return decision.requiresBackup ? "backup_evidence_missing" : "backup_evidence_unexpected";
  }
  if (decision.backupManifestId !== (decision.backupManifest?.manifestId ?? null)) {
    return "backup_binding_mismatch";
  }
  if (decision.backupManifest && (
    decision.backupManifest.actionId !== decision.actionId ||
    decision.backupManifest.executionId !== decision.executionId ||
    decision.backupManifest.taskId !== decision.taskId
  )) {
    return "backup_binding_mismatch";
  }
  if (decision.requiresRollback !== (decision.rollback !== null)) {
    return decision.requiresRollback ? "rollback_evidence_missing" : "rollback_evidence_unexpected";
  }
  if (decision.rollback && !("actionId" in decision.rollback)) return "rollback_binding_mismatch";
  if (decision.rollback && (
    decision.rollback.actionId !== decision.actionId ||
    decision.rollback.executionId !== decision.executionId ||
    decision.rollback.taskId !== decision.taskId ||
    decision.rollback.command.manifestId !== decision.rollback.backupManifestId
  )) {
    return "rollback_binding_mismatch";
  }
  if (decision.requiresCheckpoint !== policy.requiresCheckpoint) return policy.requiresCheckpoint ? "checkpoint_evidence_missing" : "checkpoint_evidence_unexpected";
  if (decision.requiresBackup !== policy.requiresBackup) return policy.requiresBackup ? "backup_evidence_missing" : "backup_evidence_unexpected";
  if (decision.requiresRollback !== policy.requiresRollback) return policy.requiresRollback ? "rollback_evidence_missing" : "rollback_evidence_unexpected";
  if (decision.requiresApproval !== policy.requiresApproval) return policy.requiresApproval ? "approval_not_granted" : "approval_unexpected";
  if (decision.requiresApproval && approval !== "GRANTED") return "approval_not_granted";
  if (!decision.requiresApproval && approval === "GRANTED") return "approval_unexpected";
  if ((decision.requiresCheckpoint || decision.requiresBackup || decision.requiresRollback || decision.requiresApproval) && gateDecision !== "PASS") {
    return "gate_failed";
  }
  if (decision.reasonCode !== policy.reasonCode) return "reason_code_mismatch";
  if (decision.outcome !== policy.outcome) return "outcome_not_allow";
  if (policy.outcome !== "ALLOW") return "outcome_not_allow";
  return null;
}

function manifestMatches(
  manifest: { actionId: string; executionId: string; taskId: string } | null,
  input: AutonomousRiskInput,
): boolean {
  return manifest !== null && manifest.actionId === input.actionId && manifest.executionId === input.executionId && manifest.taskId === input.taskId;
}

function decision(
  input: AutonomousRiskInput,
  outcome: AutonomousRiskOutcome,
  reasonCode: AutonomousRiskReasonCode,
  requirements: {
    disposable: boolean;
    checkpoint: boolean;
    backup: boolean;
    approval: boolean;
    rollback: boolean;
  },
): AutonomousRiskDecision {
  return autonomousRiskDecisionSchema.parse({
    decisionId: `autonomous-risk/${input.actionId}/${input.risk}/${outcome}/${reasonCode}`,
    actionId: input.actionId,
    executionId: input.executionId,
    taskId: input.taskId,
    risk: input.risk,
    outcome,
    reasonCode,
    disposable: requirements.disposable,
    requiresCheckpoint: requirements.checkpoint,
    requiresBackup: requirements.backup,
    requiresApproval: requirements.approval,
    requiresRollback: requirements.rollback,
    checkpointManifestId: input.checkpoint?.manifestId ?? null,
    backupManifestId: input.backup?.manifestId ?? null,
    checkpointManifest: input.checkpoint,
    backupManifest: input.backup,
    rollback: input.rollback,
  });
}

/** Pure D9 risk policy; it returns a manifest/approval proposal and never applies it. */
export function decideAutonomousRisk(input: AutonomousRiskInput): AutonomousRiskDecision {
  const parsed = autonomousRiskInputSchema.parse(input);
  if (parsed.risk === "LOW") {
    return decision(parsed, "ALLOW", "low_disposable", {
      disposable: true,
      checkpoint: false,
      backup: false,
      approval: false,
      rollback: false,
    });
  }
  if (parsed.risk === "MEDIUM") {
    if (!manifestMatches(parsed.checkpoint, parsed)) {
      return decision(parsed, "DENY", "missing_checkpoint", {
        disposable: false,
        checkpoint: true,
        backup: true,
        approval: false,
        rollback: false,
      });
    }
    if (!manifestMatches(parsed.backup, parsed)) {
      return decision(parsed, "DENY", "missing_backup", {
        disposable: false,
        checkpoint: true,
        backup: true,
        approval: false,
        rollback: false,
      });
    }
    return decision(parsed, "ALLOW", "checkpoint_and_backup_present", {
      disposable: false,
      checkpoint: true,
      backup: true,
      approval: false,
      rollback: false,
    });
  }
  if (parsed.approval === "PENDING" || parsed.approval === "NOT_REQUIRED") {
    return decision(parsed, "REQUIRE_APPROVAL", "approval_required", {
      disposable: false,
      checkpoint: false,
      backup: false,
      approval: true,
      rollback: true,
    });
  }
  if (parsed.approval === "DENIED") {
    return decision(parsed, "DENY", "approval_denied", {
      disposable: false,
      checkpoint: false,
      backup: false,
      approval: true,
      rollback: true,
    });
  }
  if (!parsed.rollback) {
    return decision(parsed, "DENY", "missing_rollback", {
      disposable: false,
      checkpoint: false,
      backup: false,
      approval: true,
      rollback: true,
    });
  }
  return decision(parsed, "ALLOW", "approval_and_rollback_present", {
    disposable: false,
    checkpoint: false,
    backup: false,
    approval: true,
    rollback: true,
  });
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown rollback metadata field: ${unknown}`);
}

function redactText(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SENSITIVE_VALUE_PATTERN.test(trimmed) || SENSITIVE_FIELD_PATTERN.test(trimmed) ? "[REDACTED]" : trimmed;
}

/** Projects command text into bounded, redacted metadata; unknown fields fail closed. */
export function createAutonomousRollbackCommandMetadata(input: unknown): AutonomousRollbackCommandMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Rollback metadata must be an object");
  }
  const record = input as Record<string, unknown>;
  assertAllowedKeys(record, ["rollbackId", "manifestId", "command", "args", "reason"]);
  return autonomousRollbackCommandMetadataSchema.parse({
    rollbackId: record.rollbackId,
    manifestId: record.manifestId,
    command: redactText(record.command),
    args: Array.isArray(record.args) ? record.args.map(redactText) : record.args,
    reason: redactText(record.reason),
  });
}

export function createAutonomousCheckpointManifest(input: AutonomousCheckpointManifest): AutonomousCheckpointManifest {
  return autonomousCheckpointManifestSchema.parse(input);
}

export function createAutonomousBackupManifest(input: AutonomousBackupManifest): AutonomousBackupManifest {
  return autonomousBackupManifestSchema.parse(input);
}

export function createAutonomousRollbackManifest(input: AutonomousRollbackManifest): AutonomousRollbackManifest {
  return autonomousRollbackManifestSchema.parse(input);
}
