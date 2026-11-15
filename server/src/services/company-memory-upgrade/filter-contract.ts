/**
 * Contract definitions, schema, and prompt hashing for memory upgrade quality filter (TECH-8572).
 *
 * ARCHITECTURAL INVARIANTS:
 * - Pure and deterministic.
 * - Closed reason sets for keep and drop decisions.
 * - Pinned prompt + schema SHA-256 for auditability.
 */

import { createHash } from "node:crypto";
import { CompanyMemoryUpgradeError } from "./types.js";

export const FILTER_ID = "paperclip.memory-upgrade.quality-filter";
export const FILTER_VERSION = 1;
export const FILTER_MODEL = "gpt-5.4-mini";

export const FILTER_KEEP_REASONS = [
  "durable_fact",
  "durable_preference",
  "decision",
  "lesson",
  "procedure",
] as const;

export type FilterKeepReason = (typeof FILTER_KEEP_REASONS)[number];

export const FILTER_DROP_REASONS = [
  "run_status",
  "transient_id",
  "environment_detail",
  "uninformative",
] as const;

export type FilterDropReason = (typeof FILTER_DROP_REASONS)[number];

export const FILTER_ALL_REASONS = [
  ...FILTER_KEEP_REASONS,
  ...FILTER_DROP_REASONS,
] as const;

export type FilterReasonCode = (typeof FILTER_ALL_REASONS)[number];

export const FILTER_SYSTEM_PROMPT = `You are a precision memory quality classifier for Paperclip.
Evaluate whether a single memory record contains durable, long-term organizational value or represents low-value transient operational noise.

RULES:
1. Return decision "keep" ONLY for durable knowledge that is useful across future agent runs:
   - durable_fact: A lasting factual truth about people, teams, projects, architecture, or business domains.
   - durable_preference: A user, team, or company preference or constraint that persists over time.
   - decision: An architectural, strategic, or engineering decision and its rationale.
   - lesson: A durable takeaway, retrospective learning, or failure mode to avoid.
   - procedure: A lasting multi-step workflow, convention, or operational policy.
2. Return decision "drop" for transient, operational, temporary, or uninformative text:
   - run_status: Ephemeral heartbeat, task progress, run completion, or immediate execution status.
   - transient_id: Bare UUID, ephemeral token, run ID, trace ID, session ID, or transient hash.
   - environment_detail: Ephemeral localhost URLs, temporary ports, scratch file paths, or transitory PID/worker IDs.
   - uninformative: Trivial placeholder, content-free acknowledgment, or text devoid of durable substance.
3. Every "keep" decision MUST use a reason from: durable_fact, durable_preference, decision, lesson, procedure.
4. Every "drop" decision MUST use a reason from: run_status, transient_id, environment_detail, uninformative.`;

export const FILTER_JSON_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["keep", "drop"],
    },
    reason: {
      type: "string",
      enum: FILTER_ALL_REASONS,
    },
  },
  required: ["decision", "reason"],
  additionalProperties: false,
} as const;

export const FILTER_CANONICAL_PARAMS = Object.freeze({
  temperature: 0,
  seed: 8572,
  max_completion_tokens: 100,
});

export function computeFilterPromptSha256(): string {
  return createHash("sha256")
    .update(
      FILTER_SYSTEM_PROMPT +
        JSON.stringify(FILTER_JSON_SCHEMA) +
        JSON.stringify(FILTER_CANONICAL_PARAMS),
    )
    .digest("hex");
}

export const FILTER_PROMPT_SHA256 = computeFilterPromptSha256();

const KEEP_REASON_SET = new Set<string>(FILTER_KEEP_REASONS);
const DROP_REASON_SET = new Set<string>(FILTER_DROP_REASONS);

export function validateFilterOutput(parsed: unknown): {
  decision: "keep" | "drop";
  reason: FilterReasonCode;
} {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CompanyMemoryUpgradeError(
      "Classifier returned a non-object payload.",
      "FILTER_INVALID_CLASSIFICATION",
    );
  }

  const obj = parsed as Record<string, unknown>;
  const decision = obj.decision;
  const reason = obj.reason;

  if (decision !== "keep" && decision !== "drop") {
    throw new CompanyMemoryUpgradeError(
      `Classifier returned invalid decision: ${String(decision)}. Must be 'keep' or 'drop'.`,
      "FILTER_INVALID_CLASSIFICATION",
    );
  }

  if (typeof reason !== "string") {
    throw new CompanyMemoryUpgradeError(
      "Classifier returned a non-string reason.",
      "FILTER_INVALID_CLASSIFICATION",
    );
  }

  if (decision === "keep") {
    if (!KEEP_REASON_SET.has(reason)) {
      throw new CompanyMemoryUpgradeError(
        `Classifier returned invalid keep reason: ${reason}. Must be one of: ${FILTER_KEEP_REASONS.join(", ")}.`,
        "FILTER_INVALID_CLASSIFICATION",
      );
    }
    return { decision: "keep", reason: reason as FilterKeepReason };
  } else {
    if (!DROP_REASON_SET.has(reason)) {
      throw new CompanyMemoryUpgradeError(
        `Classifier returned invalid drop reason: ${reason}. Must be one of: ${FILTER_DROP_REASONS.join(", ")}.`,
        "FILTER_INVALID_CLASSIFICATION",
      );
    }
    return { decision: "drop", reason: reason as FilterDropReason };
  }
}

export interface FilterAuditRecord {
  import_key: string;
  decision: "keep" | "drop";
  stage: "override" | "deterministic" | "classifier";
  reason: string;
}

export interface FilterMetadata {
  filter_id: string;
  filter_version: number;
  prompt_sha256: string;
  model: string;
  kept: number;
  dropped_deterministic: number;
  dropped_classified: number;
  rule_counts: Record<string, number>;
  classified_reasons: Record<string, number>;
  generated_at: string;
  input_jsonl_sha256: string;
  input_record_count: number;
}

export interface FilterOptions {
  manifestPath: string;
  jsonlPath: string;
  outputDir: string;
  companyId?: string | null;
  agentId?: string | null;
  upgradeId?: string | null;
  openaiKeyFile?: string | null;
  model?: string;
  maxCostUsd?: number;
  isDryRun?: boolean;
  confirm?: string | null;
  keepImportKeysPath?: string | null;
  controlPlaneDatabaseUrl?: string | null;
  format?: "text" | "json";
  allowProd?: boolean;
  concurrency?: number;
  chatRpm?: number;
  chatTpm?: number;
}

export interface FilterReport {
  isDryRun: boolean;
  companyId: string;
  agentId: string;
  upgradeId: string;
  inputRecordCount: number;
  inputJsonlSha256: string;
  keptCount: number;
  droppedDeterministicCount: number;
  droppedClassifiedCount: number;
  ruleCounts: Record<string, number>;
  classifiedReasons: Record<string, number>;
  projectedCostUsd: number;
  actualCostUsd: number;
  outputJsonlPath: string | null;
  outputManifestPath: string | null;
  outputJsonlSha256: string | null;
  auditTxtPath: string | null;
  auditJsonPath: string | null;
  metadataPath: string | null;
}
