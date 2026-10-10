import { isAgentStatusInvokable } from "./agent-eligibility.js";
import { extractPipelineMentions } from "./project-mentions.js";

/**
 * Setup-health warnings for pipelines.
 *
 * The goal is to warn — in plain, Zapier-level language with zero technical
 * vocabulary — about any configuration that simply will not run, *before*
 * someone discovers it mid-workflow. The copy here intentionally avoids words
 * like "routine", "dispatch", or "JWT": a paused agent is "a paused teammate",
 * a routine is "the instructions for this step", and so on.
 *
 * This module is a pure function so it can be unit-tested and shared between the
 * server (which assembles the inputs from the database) and the UI.
 */

export type PipelineHealthWarningCode =
  | "paused_agent"
  | "stage_no_automation"
  | "automation_no_instructions"
  | "automation_no_agent"
  | "automation_failed"
  | "review_no_approver"
  | "missing_pipeline_reference"
  | "missing_stage_reference"
  | "breakdown_target_missing"
  | "breakdown_no_wait"
  | "breakdown_target_not_entry_safe"
  | "breakdown_field_mismatch"
  | "unset_required_variable";

export interface PipelineHealthWarning {
  /** Machine-readable reason; UI keys icons/grouping off this. */
  code: PipelineHealthWarningCode;
  /** The stage the warning is anchored to. */
  stageId: string;
  stageKey: string;
  stageName: string;
  /** Plain-language, prosumer-safe message ready to render as-is. */
  message: string;
  /** Optional UI route for the next useful place to inspect or fix the warning. */
  href?: string;
  hrefLabel?: string;
}

export interface PipelineHealthReport {
  pipelineId: string;
  warnings: PipelineHealthWarning[];
  /** Convenience: true when there are no warnings at all. */
  ok: boolean;
}

export interface PipelineHealthAgentRef {
  id: string;
  name?: string | null;
  status: string;
}

export interface PipelineHealthStageRef {
  key: string;
  name: string;
  kind?: string;
  config?: Record<string, unknown> | null;
}

export interface PipelineHealthPipelineRef {
  id: string;
  name: string;
  stages: PipelineHealthStageRef[];
}

export interface PipelineHealthStageInput {
  id: string;
  key: string;
  name: string;
  kind: string;
  config: Record<string, unknown> | null | undefined;
  /** Latest instructions body for the stage ("" when there are none). */
  instructionsBody?: string | null;
}

export interface PipelineHealthFailedAutomationInput {
  stageId: string;
  stageKey: string;
  stageName: string;
  caseId: string;
  caseTitle: string;
  error?: string | null;
}

export interface PipelineHealthInput {
  pipelineId: string;
  stages: PipelineHealthStageInput[];
  /** Every agent in the company, keyed by id, for invokability + name lookup. */
  agentsById: Record<string, PipelineHealthAgentRef>;
  /** Every pipeline in the company, keyed by id, for validating `/pipeline:` references. */
  pipelinesById: Record<string, PipelineHealthPipelineRef>;
  /** Failed stage automation still affecting live items in this pipeline. */
  failedAutomations?: PipelineHealthFailedAutomationInput[];
}

type StageConfig = {
  assigneeAgentId?: unknown;
  automation?: unknown;
  autoAdvanceOnChildrenTerminal?: unknown;
  breakdown?: unknown;
  onEnter?: unknown;
  requireApproval?: unknown;
  requireChildrenTerminal?: unknown;
  approver?: { kind?: unknown; id?: unknown } | null;
  variables?: unknown;
  [key: string]: unknown;
};

export function isPipelineTerminalStageKind(kind: string | null | undefined): boolean {
  return kind === "done" || kind === "cancelled";
}

function asConfig(config: PipelineHealthStageInput["config"]): StageConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  return config as StageConfig;
}

function agentLabel(agent: PipelineHealthAgentRef | undefined): string {
  const name = agent?.name?.trim();
  return name && name.length > 0 ? name : "a teammate";
}

function hasOnEnterRoutineAutomation(config: StageConfig): boolean {
  const onEnter = config.onEnter;
  if (!onEnter || typeof onEnter !== "object" || Array.isArray(onEnter)) return false;
  const record = onEnter as Record<string, unknown>;
  return record.type === "run_routine" && typeof record.routineId === "string" && record.routineId.trim().length > 0;
}

function hasChildrenGateAutoAdvance(config: StageConfig): boolean {
  const breakdown = readBreakdownConfig(config);
  if (breakdown) return breakdown.waitForPieces && breakdown.whenFinishedMoveTo !== null;
  return config.requireChildrenTerminal === true &&
    typeof config.autoAdvanceOnChildrenTerminal === "string" &&
    config.autoAdvanceOnChildrenTerminal.trim().length > 0;
}

/** True when a stage has saved automation that can move work forward. */
function hasRunnableStageAutomation(config: StageConfig): boolean {
  return readBreakdownConfig(config) !== null || hasOnEnterRoutineAutomation(config) || hasChildrenGateAutoAdvance(config);
}

function automationAssigneeAgentId(config: StageConfig): string | null {
  const automation = config.automation;
  if (automation && typeof automation === "object" && !Array.isArray(automation)) {
    const value = (automation as Record<string, unknown>).assigneeAgentId;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return typeof config.assigneeAgentId === "string" && config.assigneeAgentId.trim()
    ? config.assigneeAgentId.trim()
    : null;
}

function readBreakdownConfig(config: StageConfig) {
  const raw = config.breakdown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const targetPipelineId = typeof record.targetPipelineId === "string" && record.targetPipelineId.trim()
    ? record.targetPipelineId.trim()
    : null;
  const targetStageKey = typeof record.targetStageKey === "string" && record.targetStageKey.trim()
    ? record.targetStageKey.trim()
    : null;
  const pieceNoun = typeof record.pieceNoun === "string" && record.pieceNoun.trim()
    ? record.pieceNoun.trim()
    : "piece";
  const inheritFields = Array.isArray(record.inheritFields)
    ? record.inheritFields.filter((field): field is string => typeof field === "string" && field.trim().length > 0).map((field) => field.trim())
    : [];
  const whenFinishedMoveTo = typeof record.whenFinishedMoveTo === "string" && record.whenFinishedMoveTo.trim()
    ? record.whenFinishedMoveTo.trim()
    : typeof config.autoAdvanceOnChildrenTerminal === "string" && config.autoAdvanceOnChildrenTerminal.trim()
      ? config.autoAdvanceOnChildrenTerminal.trim()
      : null;
  return {
    targetPipelineId,
    targetStageKey,
    pieceNoun,
    inheritFields,
    waitForPieces: record.waitForPieces === undefined ? config.requireChildrenTerminal === true : record.waitForPieces === true,
    whenFinishedMoveTo,
  };
}

export function computePipelineHealth(input: PipelineHealthInput): PipelineHealthReport {
  const warnings: PipelineHealthWarning[] = [];

  for (const stage of input.stages) {
    const config = asConfig(stage.config);
    const instructionsBody = (stage.instructionsBody ?? "").trim();
    const anchor = { stageId: stage.id, stageKey: stage.key, stageName: stage.name };

    const assigneeAgentId = automationAssigneeAgentId(config);
    const hasStageAutomation = hasRunnableStageAutomation(config);
    const isTerminalStage = isPipelineTerminalStageKind(stage.kind);
    const breakdown = readBreakdownConfig(config);

    // 1. A teammate is assigned to run this step, but they're paused / gone.
    if (assigneeAgentId) {
      const agent = input.agentsById[assigneeAgentId];
      if (!agent) {
        warnings.push({
          ...anchor,
          code: "paused_agent",
          message: `Assigned to a teammate who's no longer here. Pick someone else to run this step.`,
        });
      } else if (!isAgentStatusInvokable(agent.status)) {
        warnings.push({
          ...anchor,
          code: "paused_agent",
          message: `${agentLabel(agent)} is paused, so this step won't run until they're back. Reassign it if you can't wait.`,
        });
      }
    }

    // 2. A teammate is assigned but there's nothing for them to do (no instructions).
    if (assigneeAgentId && !instructionsBody) {
      warnings.push({
        ...anchor,
        code: "automation_no_instructions",
        message: `Assigned to a teammate, but there are no instructions yet. Add instructions so this step doesn't stall.`,
      });
    }

    // 3. Instructions exist, but no teammate is assigned to run them.
    if (!assigneeAgentId && instructionsBody && !hasStageAutomation && stage.kind !== "review" && !isTerminalStage) {
      warnings.push({
        ...anchor,
        code: "automation_no_agent",
        message: `This step has instructions, but no agent is assigned. Add an agent to run this step, or make it a review step if a person should decide.`,
      });
    }

    // 4. Nothing runs here automatically. This is legal, but must be loud.
    if (!assigneeAgentId && !instructionsBody && !hasStageAutomation && stage.kind !== "review" && !isTerminalStage) {
      warnings.push({
        ...anchor,
        code: "stage_no_automation",
        message: `Nothing runs here automatically — items will sit until a person moves them. Add an agent to run this step, or make it a review step if a person should decide.`,
      });
    }

    // 5. A review step with no one who can actually approve.
    if (stage.kind === "review" || config.requireApproval === true) {
      const approver = config.approver && typeof config.approver === "object" ? config.approver : null;
      const kind = approver && typeof approver.kind === "string" ? approver.kind : "any_human";
      const approverId =
        approver && typeof approver.id === "string" && approver.id.trim() ? approver.id.trim() : null;
      if (kind === "agent") {
        const agent = approverId ? input.agentsById[approverId] : undefined;
        if (!approverId || !agent) {
          warnings.push({
            ...anchor,
            code: "review_no_approver",
            message: `No approver picked yet, so work will pile up here. Choose who approves.`,
          });
        } else if (!isAgentStatusInvokable(agent.status)) {
          warnings.push({
            ...anchor,
            code: "review_no_approver",
            message: `${agentLabel(agent)} is the approver and they're paused, so nothing can be approved until they're back.`,
          });
        }
      } else if (kind === "user" && !approverId) {
        warnings.push({
          ...anchor,
          code: "review_no_approver",
          message: `No approver picked yet, so work will pile up here. Choose who approves.`,
        });
      }
    }

    // 6. First-class breakdown references. These replace prose scanning on
    // breakdown stages because the target workflow is now config, not copy.
    if (breakdown) {
      const target = breakdown.targetPipelineId ? input.pipelinesById[breakdown.targetPipelineId] : undefined;
      const targetStage = breakdown.targetStageKey
        ? target?.stages.find((s) => s.key === breakdown.targetStageKey)
        : undefined;
      if (!target || !targetStage) {
        warnings.push({
          ...anchor,
          code: "breakdown_target_missing",
          message: `This step breaks work into another workflow, but that destination is missing. Pick where the pieces should go.`,
        });
      } else {
        if (!breakdown.waitForPieces || !breakdown.whenFinishedMoveTo) {
          warnings.push({
            ...anchor,
            code: "breakdown_no_wait",
            message: `This step creates ${breakdown.pieceNoun}s but does not wait for them before moving on. Turn on waiting if the next step depends on the pieces finishing.`,
          });
        }
        const targetConfig = asConfig(targetStage.config);
        const firstStage = target.stages[0];
        if (
          firstStage?.key !== targetStage.key ||
          targetStage.kind === "review" ||
          isPipelineTerminalStageKind(targetStage.kind) ||
          targetConfig.disabled === true ||
          targetConfig.requireApproval === true
        ) {
          warnings.push({
            ...anchor,
            code: "breakdown_target_not_entry_safe",
            message: `New ${breakdown.pieceNoun}s start in a destination step that may not accept new work cleanly. Choose the entry step for that workflow.`,
          });
        }
      }
    } else if (instructionsBody) {
      for (const mention of extractPipelineMentions(instructionsBody)) {
        const target = input.pipelinesById[mention.pipelineId];
        if (!target) {
          warnings.push({
            ...anchor,
            code: "missing_pipeline_reference",
            message: `These instructions hand off to a workflow that's been deleted. Point them at one that exists.`,
          });
          continue;
        }
        if (mention.stageKey && !target.stages.some((s) => s.key === mention.stageKey)) {
          warnings.push({
            ...anchor,
            code: "missing_stage_reference",
            message: `These instructions hand off to a step that no longer exists in "${target.name}". Point them at one that does.`,
          });
        }
      }
    }

    // 7. Required stage variables are item inputs, not settings defaults.
    // Missing per-item values are validated when work enters or runs through
    // the pipeline; a blank default in settings is a normal configuration.
  }

  const seenFailedAutomationCaseIdsByStage = new Map<string, Set<string>>();
  for (const failure of input.failedAutomations ?? []) {
    let seenCaseIds = seenFailedAutomationCaseIdsByStage.get(failure.stageId);
    if (!seenCaseIds) {
      seenCaseIds = new Set<string>();
      seenFailedAutomationCaseIdsByStage.set(failure.stageId, seenCaseIds);
    }
    if (seenCaseIds.has(failure.caseId)) continue;
    seenCaseIds.add(failure.caseId);
    warnings.push({
      code: "automation_failed",
      stageId: failure.stageId,
      stageKey: failure.stageKey,
      stageName: failure.stageName,
      message: `Automation failed on "${failure.caseTitle}". Open the item to inspect the log and retry it.`,
      href: `/pipelines/${input.pipelineId}/items/${failure.caseId}`,
      hrefLabel: "Open item",
    });
  }

  return { pipelineId: input.pipelineId, warnings, ok: warnings.length === 0 };
}

/** Group a flat warning list by stage id — handy for rendering per-stage badges. */
export function groupWarningsByStage(
  warnings: PipelineHealthWarning[],
): Record<string, PipelineHealthWarning[]> {
  const byStage: Record<string, PipelineHealthWarning[]> = {};
  for (const warning of warnings) {
    (byStage[warning.stageId] ??= []).push(warning);
  }
  return byStage;
}
