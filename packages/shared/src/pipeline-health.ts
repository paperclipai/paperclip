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
  return config.requireChildrenTerminal === true &&
    typeof config.autoAdvanceOnChildrenTerminal === "string" &&
    config.autoAdvanceOnChildrenTerminal.trim().length > 0;
}

/** True when a stage has saved automation that can move work forward. */
function hasRunnableStageAutomation(config: StageConfig): boolean {
  return hasOnEnterRoutineAutomation(config) || hasChildrenGateAutoAdvance(config);
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

function readVariableName(entry: Record<string, unknown>): string | null {
  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
  if (name) return name;
  const key = typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : null;
  return key;
}

function readVariableLabel(entry: Record<string, unknown>, fallback: string): string {
  const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : null;
  return label ?? fallback;
}

function isRequired(entry: Record<string, unknown>): boolean {
  return entry.required === true;
}

function hasDefaultValue(entry: Record<string, unknown>): boolean {
  const value = entry.defaultValue;
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "number" || typeof value === "boolean";
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

    // 6. Instructions that hand off to a pipeline / step that no longer exists.
    if (instructionsBody) {
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

    // 7. Required details that were never filled in, so the step can't run.
    // Only stages that actually run instructions (an assigned teammate or an
    // on-enter automation) need values up front — on entry stages the same
    // variables are the intake form, filled per item, so an empty default is
    // the normal state, not a misconfiguration.
    const runsInstructions = assigneeAgentId !== null || hasOnEnterRoutineAutomation(config);
    const variables = runsInstructions && Array.isArray(config.variables) ? config.variables : [];
    for (const raw of variables) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const name = readVariableName(entry);
      if (!name) continue;
      if (isRequired(entry) && !hasDefaultValue(entry)) {
        warnings.push({
          ...anchor,
          code: "unset_required_variable",
          message: `"${readVariableLabel(entry, name)}" is empty. Fill it in so this step can run.`,
        });
      }
    }
  }

  for (const failure of input.failedAutomations ?? []) {
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
