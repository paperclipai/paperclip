import { z } from "zod";
import {
  GATE_MANIFEST_GATE_STATUSES,
  GATE_MANIFEST_GATE_TYPES,
  MISSION_CONTRACT_DONE_POLICIES,
} from "../constants.js";
import type { EvidenceRecord, EvidenceRecordsDocument } from "./evidence-records.js";

export const gateManifestGateTypeSchema = z.enum(GATE_MANIFEST_GATE_TYPES);
export const gateManifestGateStatusSchema = z.enum(GATE_MANIFEST_GATE_STATUSES);
export const gateManifestDonePolicySchema = z.enum(MISSION_CONTRACT_DONE_POLICIES);

export const gateManifestGateSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  type: gateManifestGateTypeSchema,
  title: z.string().trim().min(1).max(240),
  ownerAgentId: z.string().uuid().nullable().optional(),
  ownerAgentName: z.string().trim().min(1).max(120).nullable().optional(),
  issueId: z.string().uuid().nullable().optional(),
  status: gateManifestGateStatusSchema.default("pending"),
  blockedByGateIds: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  blockedByIssueIds: z.array(z.string().uuid()).max(20).default([]),
  requiredEvidence: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  evidenceRecordIds: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();

export const gateManifestSchema = z.object({
  version: z.literal(1),
  gates: z.array(gateManifestGateSchema).min(1).max(50),
  donePolicy: gateManifestDonePolicySchema.default("all_required_gates_passed"),
}).strict().superRefine((value, ctx) => {
  const gateIds = new Set<string>();
  for (const [index, gate] of value.gates.entries()) {
    if (gateIds.has(gate.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Gate ids must be unique",
        path: ["gates", index, "id"],
      });
    }
    gateIds.add(gate.id);
  }

  for (const [gateIndex, gate] of value.gates.entries()) {
    for (const [blockerIndex, blockedByGateId] of gate.blockedByGateIds.entries()) {
      if (!gateIds.has(blockedByGateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "blockedByGateIds must reference an existing gate id",
          path: ["gates", gateIndex, "blockedByGateIds", blockerIndex],
        });
      }
      if (blockedByGateId === gate.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A gate cannot block itself",
          path: ["gates", gateIndex, "blockedByGateIds", blockerIndex],
        });
      }
    }
  }
});

export const materializeGateManifestSchema = z.preprocess(
  (value) => value == null ? {} : value,
  z.object({
    blockParentUntilDone: z.boolean().optional().default(true),
  }).strict(),
);

export type GateManifestGateType = z.infer<typeof gateManifestGateTypeSchema>;
export type GateManifestGateStatus = z.infer<typeof gateManifestGateStatusSchema>;
export type GateManifestGate = z.infer<typeof gateManifestGateSchema>;
export type GateManifest = z.infer<typeof gateManifestSchema>;
export type MaterializeGateManifest = z.infer<typeof materializeGateManifestSchema>;

export interface GateEvidenceFailure {
  gateId: string;
  missingEvidence: string[];
}

export interface GateManifestCompletionEvaluation {
  incompleteGateIds: string[];
  statusIncompleteGateIds: string[];
  gateEvidenceFailures: GateEvidenceFailure[];
}

const DEFAULT_GATE_EVIDENCE_REQUIREMENTS: Partial<Record<GateManifestGateType, string[]>> = {
  release: ["commit", "deploy_url"],
  production_smoke: ["production_url", "screenshot_or_artifact"],
};

export function evaluateGateManifestCompletion(
  manifest: GateManifest,
  evidenceDocument: EvidenceRecordsDocument | null | undefined,
): GateManifestCompletionEvaluation {
  const records = evidenceDocument?.records ?? [];
  const statusIncompleteGateIds = manifest.gates
    .filter((gate) => gate.status !== "passed" && gate.status !== "waived")
    .map((gate) => gate.id);
  const gateEvidenceFailures = manifest.gates
    .filter((gate) => gate.status === "passed")
    .map((gate) => {
      const missingEvidence = missingEvidenceForGate(gate, records);
      return missingEvidence.length > 0 ? { gateId: gate.id, missingEvidence } : null;
    })
    .filter((value): value is GateEvidenceFailure => value !== null);
  const incompleteGateIds = Array.from(new Set([
    ...statusIncompleteGateIds,
    ...gateEvidenceFailures.map((failure) => failure.gateId),
  ]));

  return {
    incompleteGateIds,
    statusIncompleteGateIds,
    gateEvidenceFailures,
  };
}

function missingEvidenceForGate(gate: GateManifestGate, records: EvidenceRecord[]) {
  const gateRecords = records.filter((record) =>
    record.gateId === gate.id &&
    record.gateType === gate.type &&
    record.status === "passed");
  const requirements = Array.from(new Set([
    ...(DEFAULT_GATE_EVIDENCE_REQUIREMENTS[gate.type] ?? []),
    ...gate.requiredEvidence,
  ]));

  return requirements.filter((requirement) =>
    !gateRecords.some((record) => evidenceRecordSatisfiesRequirement(record, requirement)));
}

function evidenceRecordSatisfiesRequirement(record: EvidenceRecord, rawRequirement: string) {
  const requirement = rawRequirement.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (requirement) {
    case "agent":
    case "agent_id":
    case "agent_name":
      return Boolean(record.agentId || record.agentName);
    case "artifact":
      return record.artifacts.length > 0;
    case "command":
    case "commands":
    case "focused_tests":
    case "test":
    case "tests":
      return record.commands.some((command) =>
        command.status === "passed" && (command.exitCode === undefined || command.exitCode === 0));
    case "commit":
    case "commit_sha":
      return Boolean(record.commitSha);
    case "deploy":
    case "deploy_url":
    case "deployment":
    case "deployment_url":
      return hasUrlLike(record, /deploy|deployment|actions\/runs|ci|build/i);
    case "pr":
    case "pr_url":
    case "pull_request":
      return hasUrlLike(record, /pull\/\d+|pull request|pr/i);
    case "production":
    case "production_url":
    case "prod_url":
    case "live_url":
      return hasUrlLike(record, /production|prod|live|app\.|www\./i);
    case "run":
    case "run_id":
    case "heartbeat_run":
      return Boolean(record.runId);
    case "screenshot":
    case "screenshots":
      return record.screenshots.length > 0;
    case "screenshot_or_artifact":
      return record.screenshots.length > 0 || record.artifacts.length > 0;
    case "url":
    case "urls":
      return record.urls.length > 0;
    default:
      return hasLabeledEvidence(record, requirement);
  }
}

function hasUrlLike(record: EvidenceRecord, pattern: RegExp) {
  return record.urls.some((url) => pattern.test(url.label) || pattern.test(url.url));
}

function hasLabeledEvidence(record: EvidenceRecord, requirement: string) {
  const values = [
    record.notes,
    ...record.urls.flatMap((url) => [url.label, url.url]),
    ...record.screenshots.flatMap((screenshot) => [screenshot.label, screenshot.path]),
    ...record.artifacts.flatMap((artifact) => [artifact.label, artifact.path]),
    ...record.commands.flatMap((command) => [command.command, command.outputSummary]),
  ];
  return values.some((value) =>
    typeof value === "string" && value.toLowerCase().replace(/[\s-]+/g, "_").includes(requirement));
}

export function formatGateManifestDocumentBody(manifest: unknown): string {
  const parsed = gateManifestSchema.parse(manifest);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function parseGateManifestDocumentBody(body: string): GateManifest {
  return gateManifestSchema.parse(JSON.parse(body));
}
