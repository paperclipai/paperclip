import { z } from "zod";

const autonomousMergeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const autonomousEvidenceRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^artifact:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const AUTONOMOUS_MERGE_GATE_IDS = [
  "worker",
  "task",
  "scope",
  "test",
  "typecheck",
  "security",
  "global",
] as const;
export type AutonomousMergeGateId = (typeof AUTONOMOUS_MERGE_GATE_IDS)[number];
export const autonomousMergeGateIdSchema = z.enum(AUTONOMOUS_MERGE_GATE_IDS);

export const autonomousMergeGateDecisionSchema = z.enum(["PASS", "FAIL", "SKIP"]);
export type AutonomousMergeGateDecision = z.infer<typeof autonomousMergeGateDecisionSchema>;

/** Only bounded, redacted evidence metadata crosses the merge decision seam. */
export const autonomousMergeEvidenceMetadataSchema = z
  .object({
    summary: z.string().max(240).nullable(),
    exitCode: z.number().int().min(0).max(255).nullable(),
    changedFiles: z.number().int().min(0).max(100_000).nullable(),
  })
  .strict();
export type AutonomousMergeEvidenceMetadata = z.infer<typeof autonomousMergeEvidenceMetadataSchema>;

export const autonomousMergeGateEvidenceSchema = z
  .object({
    gateId: autonomousMergeGateIdSchema,
    decision: autonomousMergeGateDecisionSchema,
    evidenceRef: autonomousEvidenceRefSchema,
    metadata: autonomousMergeEvidenceMetadataSchema,
  })
  .strict();
export type AutonomousMergeGateEvidence = z.infer<typeof autonomousMergeGateEvidenceSchema>;

export const autonomousMergeRequestSchema = z
  .object({
    workerId: autonomousMergeIdSchema,
    taskId: autonomousMergeIdSchema,
    scopeId: autonomousMergeIdSchema,
    gates: z.array(autonomousMergeGateEvidenceSchema).max(AUTONOMOUS_MERGE_GATE_IDS.length * 2),
  })
  .strict();
export type AutonomousMergeRequest = z.infer<typeof autonomousMergeRequestSchema>;

export const AUTONOMOUS_MERGE_REASON_CODES = [
  "all_gates_passed",
  "gate_failed",
  "missing_gate",
  "duplicate_gate",
] as const;
export type AutonomousMergeReasonCode = (typeof AUTONOMOUS_MERGE_REASON_CODES)[number];
export const autonomousMergeReasonCodeSchema = z.enum(AUTONOMOUS_MERGE_REASON_CODES);

export const autonomousMergeDecisionSchema = z
  .object({
    decisionId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    workerId: autonomousMergeIdSchema,
    taskId: autonomousMergeIdSchema,
    scopeId: autonomousMergeIdSchema,
    outcome: z.enum(["ALLOW", "DENY"]),
    reasonCode: autonomousMergeReasonCodeSchema,
    failedGates: z.array(autonomousMergeGateIdSchema),
    evidence: z.array(autonomousMergeGateEvidenceSchema).max(AUTONOMOUS_MERGE_GATE_IDS.length * 2),
  })
  .strict();
export type AutonomousMergeDecision = z.infer<typeof autonomousMergeDecisionSchema>;

const SENSITIVE_METADATA_PATTERN =
  /api[_-]?key|secret|token|password|credential|authorization|private\s+key|chain[_ -]?of[_ -]?thought|reasoning|raw[_ -]?output|prompt/i;

function safeSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const summary = value.trim();
  if (!summary) return null;
  return SENSITIVE_METADATA_PATTERN.test(summary) ? "[REDACTED]" : summary;
}

function boundedInteger(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

/** Projects untrusted gate details into the redacted metadata contract. */
export function redactAutonomousMergeMetadata(value: unknown): AutonomousMergeEvidenceMetadata {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return autonomousMergeEvidenceMetadataSchema.parse({
    summary: safeSummary(record.summary),
    exitCode: boundedInteger(record.exitCode, 255),
    changedFiles: boundedInteger(record.changedFiles, 100_000),
  });
}

export function createAutonomousMergeGateEvidence(input: {
  gateId: AutonomousMergeGateId;
  decision: AutonomousMergeGateDecision;
  evidenceRef: string;
  metadata?: unknown;
}): AutonomousMergeGateEvidence {
  return autonomousMergeGateEvidenceSchema.parse({
    gateId: input.gateId,
    decision: input.decision,
    evidenceRef: input.evidenceRef,
    metadata: redactAutonomousMergeMetadata(input.metadata),
  });
}

function compareEvidence(left: AutonomousMergeGateEvidence, right: AutonomousMergeGateEvidence): number {
  const leftIndex = AUTONOMOUS_MERGE_GATE_IDS.indexOf(left.gateId);
  const rightIndex = AUTONOMOUS_MERGE_GATE_IDS.indexOf(right.gateId);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  const leftKey = `${left.decision}\u0000${left.evidenceRef}`;
  const rightKey = `${right.decision}\u0000${right.evidenceRef}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * Pure D7 seam for the existing workspace/restore-merge helpers. It emits a
 * deterministic proposal only; it never touches a workspace, database, or
 * orchestrator. Every required gate must be present exactly once and PASS.
 */
export function decideControlledAutonomousMerge(
  input: AutonomousMergeRequest,
): AutonomousMergeDecision {
  const parsed = autonomousMergeRequestSchema.parse(input);
  const evidence = [...parsed.gates].sort(compareEvidence);
  const counts = new Map<AutonomousMergeGateId, number>();
  for (const entry of evidence) counts.set(entry.gateId, (counts.get(entry.gateId) ?? 0) + 1);

  const duplicateGates = AUTONOMOUS_MERGE_GATE_IDS.filter((gateId) => (counts.get(gateId) ?? 0) > 1);
  const missingGates = AUTONOMOUS_MERGE_GATE_IDS.filter((gateId) => !counts.has(gateId));
  const failedGates = AUTONOMOUS_MERGE_GATE_IDS.filter((gateId) => {
    const matches = evidence.filter((entry) => entry.gateId === gateId);
    return matches.length !== 1 || matches[0]!.decision !== "PASS";
  });
  const outcome = duplicateGates.length === 0 && missingGates.length === 0 && failedGates.length === 0
    ? "ALLOW"
    : "DENY";
  const reasonCode: AutonomousMergeReasonCode = duplicateGates.length > 0
    ? "duplicate_gate"
    : missingGates.length > 0
      ? "missing_gate"
      : outcome === "ALLOW"
        ? "all_gates_passed"
        : "gate_failed";

  return autonomousMergeDecisionSchema.parse({
    decisionId: `autonomous-merge/${parsed.workerId}/${parsed.taskId}/${parsed.scopeId}/${outcome}`,
    workerId: parsed.workerId,
    taskId: parsed.taskId,
    scopeId: parsed.scopeId,
    outcome,
    reasonCode,
    failedGates: [...failedGates],
    evidence,
  });
}
