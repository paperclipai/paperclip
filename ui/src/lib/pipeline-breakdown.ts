import { i18n, t } from "@/i18n";
import type { PipelineStage } from "../api/pipelines";

/**
 * UI-side reader + copy helpers for the "Break into pieces" stage primitive.
 *
 * The server stores the breakdown config on `stage.config.breakdown` (see
 * `pipelineStageBreakdownSchema`). Only the singular `pieceNoun` is persisted;
 * English display retains the server-style plural. Russian keeps the original
 * user-authored name and places it in grammatical templates without inflecting it.
 *
 * All copy in this module is prosumer-facing — no API terms ("case", "child",
 * "stage key") ever surface; the configured piece noun is the dominant token.
 */

export interface StageBreakdownConfig {
  targetPipelineId: string;
  targetStageKey: string;
  pieceNoun: string;
  inheritFields: string[];
  carryOverPolicy?: BreakdownCarryOverPolicy;
  advanceTo: string | null;
  waitForPieces: boolean;
  whenFinishedMoveTo: string | null;
}

export type BreakdownCarryOverMode = "all_except" | "only";

export interface BreakdownCarryOverPolicy {
  version: 1;
  mode: BreakdownCarryOverMode;
  includeFields: string[];
  excludeFields: string[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const key = asString(entry);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [key];
  });
}

function readCarryOverPolicy(record: Record<string, unknown>, inheritFields: string[]): BreakdownCarryOverPolicy {
  const raw = record.carryOverPolicy;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const policy = raw as Record<string, unknown>;
    const mode = policy.mode === "all_except" || policy.mode === "only" ? policy.mode : "all_except";
    return {
      version: 1,
      mode,
      includeFields: asStringList(policy.includeFields),
      excludeFields: asStringList(policy.excludeFields),
    };
  }
  return {
    version: 1,
    mode: "only",
    includeFields: inheritFields,
    excludeFields: [],
  };
}

export function isCarryOverIdentityFieldKey(key: string) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized === "name" ||
    normalized === "title" ||
    normalized === "casename" ||
    normalized === "casetitle";
}

export function isCarryOverFieldEnabled(policy: BreakdownCarryOverPolicy | null | undefined, key: string) {
  if (!policy) return false;
  if (isCarryOverIdentityFieldKey(key)) return false;
  if (policy.mode === "only") return policy.includeFields.includes(key);
  return !policy.excludeFields.includes(key);
}

/**
 * Returns the breakdown config when a stage has the `breakdown` block, else
 * `null`. Fields may be empty when the config is half-finished — read surfaces
 * lean on `computePipelineHealth` to flag a missing target rather than hiding
 * the stage.
 */
export function readStageBreakdown(
  stage: { config?: Record<string, unknown> | null } | null | undefined,
): StageBreakdownConfig | null {
  const raw = stage?.config?.breakdown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const inheritFields = Array.isArray(record.inheritFields)
    ? record.inheritFields.filter((field): field is string => typeof field === "string" && field.trim().length > 0).map((field) => field.trim())
    : [];
  const carryOverPolicy = readCarryOverPolicy(record, inheritFields);
  return {
    targetPipelineId: asString(record.targetPipelineId),
    targetStageKey: asString(record.targetStageKey),
    pieceNoun: asString(record.pieceNoun) || "piece",
    inheritFields,
    carryOverPolicy,
    advanceTo: asString(record.advanceTo) || null,
    waitForPieces: record.waitForPieces === true,
    whenFinishedMoveTo: asString(record.whenFinishedMoveTo) || null,
  };
}

export function hasStageBreakdown(stage: PipelineStage | null | undefined): boolean {
  return readStageBreakdown(stage) !== null;
}

/** Display form only; never modifies the saved piece name. */
export function pieceNounPlural(noun: string): string {
  const trimmed = noun.trim() || "piece";
  return (i18n.resolvedLanguage ?? "en").split("-")[0] !== "en" ? trimmed : `${trimmed}s`;
}

/** "a and b" / "a, b and c" — for inherited-field lists. */
export function joinWithAnd(items: string[]): string {
  const list = items.filter((item) => item.trim().length > 0);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0]!;
  return new Intl.ListFormat(i18n.resolvedLanguage, { style: "long", type: "conjunction" }).format(list);
}

export interface BreakdownCopyNames {
  targetPipelineName: string;
  entryStageName: string;
  advanceToName: string | null;
  whenFinishedName: string | null;
  /** Human labels for the inherited fields, in config order. */
  inheritedFieldLabels: string[];
}

/**
 * The single generated sentence shown in the settings card footer band.
 * Returns `null` when the config is too incomplete to summarize.
 */
export function breakdownSummarySentence(
  config: StageBreakdownConfig,
  names: BreakdownCopyNames,
): string | null {
  if (!config.targetPipelineId || !config.targetStageKey || !names.targetPipelineName) {
    return null;
  }
  const noun = config.pieceNoun;
  const parts: string[] = [
    t("localizationOperations.breakdownCreates", { noun, pipeline: names.targetPipelineName, stage: names.entryStageName }),
  ];
  if (names.inheritedFieldLabels.length > 0) {
    parts.push(t("localizationOperations.breakdownCarry", { fields: joinWithAnd(names.inheritedFieldLabels) }));
  }
  if (names.advanceToName) {
    parts.push(t("localizationOperations.breakdownAdvance", { stage: names.advanceToName }));
  }
  let sentence = parts.join(", ");
  if (config.waitForPieces && names.whenFinishedName) {
    sentence += t("localizationOperations.breakdownWait", { noun, stage: names.whenFinishedName });
  }
  return `${sentence}.`;
}

/**
 * The read-only "Paperclip handles this" mechanics bullets, composed from the
 * config. Bullets 5 and 6 only appear when the wait gate is on.
 */
export function breakdownMechanicsBullets(
  config: StageBreakdownConfig,
  names: BreakdownCopyNames,
): string[] {
  const noun = config.pieceNoun;
  const bullets: string[] = [
    t("localizationOperations.mechanicsCreates", { noun, pipeline: names.targetPipelineName || t("localizationOperations.destinationPipeline"), stage: names.entryStageName || t("localizationOperations.entryStage") }),
    t("localizationOperations.mechanicsLinks", { noun }),
  ];
  if (names.inheritedFieldLabels.length > 0) {
    bullets.push(t("localizationOperations.mechanicsCarry", { fields: joinWithAnd(names.inheritedFieldLabels), noun }));
  }
  if (names.advanceToName) {
    bullets.push(t("localizationOperations.mechanicsAdvance", { stage: names.advanceToName }));
  }
  if (config.waitForPieces && names.whenFinishedName) {
    bullets.push(t("localizationOperations.mechanicsWait", { noun, stage: names.whenFinishedName }));
    bullets.push(t("localizationOperations.mechanicsSkip", { stage: names.whenFinishedName }));
  }
  return bullets;
}
