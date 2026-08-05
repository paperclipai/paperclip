import type { PipelineCaseBoardOutputSummary } from "@paperclipai/shared";
import type { PipelineStage } from "../api/pipelines";

const defaultPipelineStageColumnTone = {
  outer: "border-border bg-background",
  header: "border-border text-muted-foreground",
  meta: "border-border",
  body: "",
  bodyOver: "bg-accent/40",
};

export const pipelineStageColumnTones: Record<string, typeof defaultPipelineStageColumnTone> = {
  review: {
    outer: "border-violet-500/25 bg-violet-50/50 dark:bg-violet-950/15",
    header: "border-violet-500/15 text-violet-700 dark:text-violet-300",
    meta: "border-violet-500/15",
    body: "bg-violet-50/30 dark:bg-violet-950/10",
    bodyOver: "bg-violet-100/65 dark:bg-violet-950/30",
  },
  in_review: {
    outer: "border-violet-500/25 bg-violet-50/50 dark:bg-violet-950/15",
    header: "border-violet-500/15 text-violet-700 dark:text-violet-300",
    meta: "border-violet-500/15",
    body: "bg-violet-50/30 dark:bg-violet-950/10",
    bodyOver: "bg-violet-100/65 dark:bg-violet-950/30",
  },
  done: {
    outer: "border-green-500/25 bg-green-50/50 dark:bg-green-950/15",
    header: "border-green-500/15 text-green-700 dark:text-green-300",
    meta: "border-green-500/15",
    body: "bg-green-50/30 dark:bg-green-950/10",
    bodyOver: "bg-green-100/65 dark:bg-green-950/30",
  },
  cancelled: {
    outer: "border-neutral-300/70 bg-muted/25 opacity-85 dark:border-neutral-700/70 dark:bg-neutral-900/20",
    header: "border-border/70 text-muted-foreground/80",
    meta: "border-border/70",
    body: "bg-muted/20",
    bodyOver: "bg-muted/45",
  },
};

export function getPipelineStageColumnTone(kind: string | null | undefined) {
  return pipelineStageColumnTones[kind?.trim().toLowerCase() ?? ""] ?? defaultPipelineStageColumnTone;
}

export function pipelineStageAutomationSettingsHref(pipelineId: string, stageId: string) {
  return `/pipelines/${pipelineId}/settings?stage=${stageId}&section=instructions`;
}

export type StagePresentationRole = "lane" | "action" | "review" | "terminal";

export type PipelineBoardStateChipTone =
  | "neutral"
  | "active"
  | "ready"
  | "review"
  | "waiting"
  | "attention"
  | "done"
  | "muted";

export interface PipelineBoardStateChip {
  key:
    | "pending"
    | "running"
    | "output_ready"
    | "needs_review"
    | "waiting_on_children"
    | "attention"
    | "done"
    | "cancelled";
  label: string;
  tone: PipelineBoardStateChipTone;
}

export type PipelineBoardTransitionEdge = { fromStageId: string; toStageId: string; label?: string | null };

export type PipelineBoardPresentationCase = {
  id: string;
  pipelineId?: string;
  title?: string;
  stageId: string | null;
  terminalKind?: string | null;
  activeWork?: unknown;
  childCount?: number;
  terminalChildCount?: number;
  descendantActiveWorkCount?: number | null;
  outputSummary?: PipelineCaseBoardOutputSummary;
  fields?: Record<string, unknown> | null;
};

export interface PipelineBoardPresentation {
  columns: PipelineStage[];
  byStage: Map<string, PipelineBoardPresentationCase[]>;
  caseToColumn: Map<string, string>;
  caseById: Map<string, PipelineBoardPresentationCase>;
  attentionCaseIds: Set<string>;
  terminalRails: Array<{ key: "done" | "cancelled"; label: string; cases: PipelineBoardPresentationCase[] }>;
}

function normalized(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function configRecord(stage: Pick<PipelineStage, "config">) {
  return stage.config && typeof stage.config === "object" && !Array.isArray(stage.config)
    ? stage.config
    : {};
}

export function pipelineStageHasRunRoutine(stage: Pick<PipelineStage, "config">) {
  const onEnter = configRecord(stage).onEnter;
  return Boolean(
    onEnter &&
      typeof onEnter === "object" &&
      !Array.isArray(onEnter) &&
      (onEnter as Record<string, unknown>).type === "run_routine",
  );
}

export function pipelineStageHasBreakdown(stage: Pick<PipelineStage, "config">) {
  const breakdown = configRecord(stage).breakdown;
  return Boolean(breakdown && typeof breakdown === "object" && !Array.isArray(breakdown));
}

export function isPipelineStageDisabled(stage: Pick<PipelineStage, "config">) {
  const config = configRecord(stage);
  return config.enabled === false || config.disabled === true;
}

export function deriveStagePresentationRole(stage: Pick<PipelineStage, "kind" | "config">): StagePresentationRole {
  const kind = normalized(stage.kind);
  if (kind === "done" || kind === "cancelled") return "terminal";
  if (kind === "review") return "review";
  if (kind === "working" && (pipelineStageHasRunRoutine(stage) || pipelineStageHasBreakdown(stage))) return "action";
  return "lane";
}

export function isSimplifiedBoardVisibleStage(stage: PipelineStage) {
  const role = deriveStagePresentationRole(stage);
  return role === "lane" || role === "review";
}

function stageByKey(stages: PipelineStage[]) {
  const byKey = new Map<string, PipelineStage>();
  for (const stage of stages) byKey.set(stage.key, stage);
  return byKey;
}

function isNonActionVisibleStage(stage: PipelineStage | undefined) {
  return Boolean(stage && isSimplifiedBoardVisibleStage(stage) && !isPipelineStageDisabled(stage));
}

export function resolveDisplayStageForActionStage(
  actionStage: PipelineStage,
  orderedStages: PipelineStage[],
  transitions: PipelineBoardTransitionEdge[],
) {
  const byKey = stageByKey(orderedStages);
  const config = configRecord(actionStage);
  const breakdown = config.breakdown && typeof config.breakdown === "object" && !Array.isArray(config.breakdown)
    ? config.breakdown as Record<string, unknown>
    : null;
  const advanceTo = typeof breakdown?.advanceTo === "string" ? byKey.get(breakdown.advanceTo) : undefined;
  if (isNonActionVisibleStage(advanceTo)) return advanceTo!;

  const byId = new Map(orderedStages.map((stage) => [stage.id, stage]));
  const outgoingTargets = transitions
    .filter((transition) => transition.fromStageId === actionStage.id)
    .map((transition) => byId.get(transition.toStageId))
    .filter((stage): stage is PipelineStage => isNonActionVisibleStage(stage))
    .sort((left, right) => left.position - right.position);
  if (outgoingTargets[0]) return outgoingTargets[0];

  const laterStage = orderedStages.find((stage) =>
    stage.position > actionStage.position && isNonActionVisibleStage(stage)
  );
  return laterStage ?? null;
}

function terminalRailKey(caseItem: PipelineBoardPresentationCase, stage: PipelineStage | undefined) {
  const terminalKind = normalized(caseItem.terminalKind);
  if (terminalKind === "done" || terminalKind === "cancelled") return terminalKind;
  const stageKind = normalized(stage?.kind);
  if (stageKind === "done" || stageKind === "cancelled") return stageKind;
  return null;
}

export function buildPipelineBoardPresentation(input: {
  orderedStages: PipelineStage[];
  cases: PipelineBoardPresentationCase[];
  transitions: PipelineBoardTransitionEdge[];
  configuredView: boolean;
  unassignedStage: PipelineStage;
}): PipelineBoardPresentation {
  const { orderedStages, cases, transitions, configuredView, unassignedStage } = input;
  const byId = new Map(orderedStages.map((stage) => [stage.id, stage]));
  const visibleStages = configuredView ? orderedStages : orderedStages.filter(isSimplifiedBoardVisibleStage);
  const byStage = new Map<string, PipelineBoardPresentationCase[]>();
  const caseToColumn = new Map<string, string>();
  const caseById = new Map<string, PipelineBoardPresentationCase>();
  const attentionCaseIds = new Set<string>();
  const terminalRails = new Map<"done" | "cancelled", PipelineBoardPresentationCase[]>([
    ["done", []],
    ["cancelled", []],
  ]);

  for (const stage of visibleStages) byStage.set(stage.id, []);
  const unassigned: PipelineBoardPresentationCase[] = [];

  for (const caseItem of cases) {
    const configuredStage = caseItem.stageId ? byId.get(caseItem.stageId) : undefined;
    caseById.set(caseItem.id, caseItem);

    if (!configuredView) {
      const railKey = terminalRailKey(caseItem, configuredStage);
      if (railKey) {
        terminalRails.get(railKey)!.push(caseItem);
        caseToColumn.set(caseItem.id, railKey);
        continue;
      }
    }

    let displayStageId: string | null = configuredStage?.id ?? null;
    if (!configuredView && configuredStage && deriveStagePresentationRole(configuredStage) === "action") {
      const displayStage = resolveDisplayStageForActionStage(configuredStage, orderedStages, transitions);
      displayStageId = displayStage?.id ?? configuredStage.id;
      if (!displayStage || isPipelineStageDisabled(configuredStage)) {
        attentionCaseIds.add(caseItem.id);
      }
      if (!displayStage && !byStage.has(configuredStage.id)) {
        byStage.set(configuredStage.id, []);
        visibleStages.push(configuredStage);
      }
    }

    if (!displayStageId || !byStage.has(displayStageId)) {
      unassigned.push(caseItem);
      caseToColumn.set(caseItem.id, unassignedStage.id);
      continue;
    }
    byStage.get(displayStageId)!.push(caseItem);
    caseToColumn.set(caseItem.id, displayStageId);
  }

  const columns = [...visibleStages];
  if (unassigned.length > 0) {
    byStage.set(unassignedStage.id, unassigned);
    columns.push(unassignedStage);
  }

  return {
    columns,
    byStage,
    caseToColumn,
    caseById,
    attentionCaseIds,
    terminalRails: [
      { key: "done", label: "Done", cases: terminalRails.get("done") ?? [] },
      { key: "cancelled", label: "Cancelled", cases: terminalRails.get("cancelled") ?? [] },
    ],
  };
}

export interface PipelineDetailActionState {
  visible: boolean;
  disabled: boolean;
  reason?: string | null;
}

export interface PipelineDetailActionInputs {
  hasStageAutomation: boolean;
  rerunPending: boolean;
  rerunBlockedByPermission: boolean;
  stageKind: string | null | undefined;
  hasActiveWork: boolean;
  previousRetryAllowed: boolean;
  retryPending: boolean;
  canCancel: boolean;
  cancelPending: boolean;
}

export interface PipelineDetailActions {
  run: PipelineDetailActionState;
  redo: PipelineDetailActionState;
  edit: PipelineDetailActionState;
  cancel: PipelineDetailActionState;
}

/**
 * Derives enablement/visibility of the item-detail action strip from the current
 * stage, terminal/active state, review config, blockers, and retry preflight. Kept
 * as a pure helper so the guardrail conditions are unit-testable independent of the
 * detail view JSX. It never widens an affordance: callers still gate the underlying
 * mutations on the same server preflight (`previousRetryAllowed`, permission preflight,
 * review availability) that produced these inputs.
 */
export function derivePipelineItemDetailActions(input: PipelineDetailActionInputs): PipelineDetailActions {
  const stageKind = normalized(input.stageKind);
  return {
    run: {
      visible: true,
      disabled:
        !input.hasStageAutomation ||
        input.rerunPending ||
        input.rerunBlockedByPermission ||
        stageKind === "review" ||
        input.hasActiveWork,
      reason: input.rerunBlockedByPermission ? "Permission still missing — request access first" : null,
    },
    redo: {
      visible: true,
      disabled: !input.previousRetryAllowed || input.retryPending,
    },
    edit: { visible: true, disabled: false },
    cancel: {
      visible: true,
      disabled: !input.canCancel || input.cancelPending,
    },
  };
}

export function getPipelineBoardStateChip(input: {
  caseItem: PipelineBoardPresentationCase;
  stage?: Pick<PipelineStage, "kind" | "config"> | null;
  hiddenActionFallback?: boolean;
  livenessReason?: string | null;
}): PipelineBoardStateChip {
  const { caseItem, stage, hiddenActionFallback = false, livenessReason = null } = input;
  const terminalKind = normalized(caseItem.terminalKind);
  const stageKind = normalized(stage?.kind);
  if (terminalKind === "cancelled" || stageKind === "cancelled") return { key: "cancelled", label: "Cancelled", tone: "muted" };
  if (terminalKind === "done" || stageKind === "done") return { key: "done", label: "Done", tone: "done" };

  const fields = caseItem.fields ?? {};
  const blocked = Number(fields.openBlockers ?? 0) > 0;
  const attentionReasons = new Set(["linked_issue_blocked", "case_blocked", "automation_failed", "permission_preflight_failed", "no_action_path"]);
  if (hiddenActionFallback || blocked || attentionReasons.has(livenessReason ?? "")) {
    return { key: "attention", label: "Needs attention", tone: "attention" };
  }

  if (caseItem.activeWork || livenessReason === "lease_active" || livenessReason === "linked_issue_active") {
    return { key: "running", label: "Running", tone: "active" };
  }

  if (stage && deriveStagePresentationRole(stage) === "review") {
    return { key: "needs_review", label: "Needs review", tone: "review" };
  }

  const childCount = Math.max(0, Math.floor(caseItem.childCount ?? 0));
  const terminalChildCount = Math.max(0, Math.floor(caseItem.terminalChildCount ?? 0));
  const config = stage ? configRecord(stage) : {};
  const breakdown = config.breakdown && typeof config.breakdown === "object" && !Array.isArray(config.breakdown)
    ? config.breakdown as Record<string, unknown>
    : null;
  const waitsForChildren = config.requireChildrenTerminal === true || breakdown?.waitForPieces === true;
  if (waitsForChildren && childCount > terminalChildCount) {
    const remaining = childCount - terminalChildCount;
    const pieceNoun = typeof breakdown?.pieceNoun === "string" && breakdown.pieceNoun.trim()
      ? breakdown.pieceNoun.trim()
      : "child";
    const plural = pieceNoun === "child" ? "children" : `${pieceNoun}s`;
    return {
      key: "waiting_on_children",
      label: `Waiting on ${remaining} of ${childCount} ${childCount === 1 ? pieceNoun : plural}`,
      tone: "waiting",
    };
  }

  if ((caseItem.outputSummary?.outputCount ?? 0) > 0) {
    return { key: "output_ready", label: "Output ready", tone: "ready" };
  }

  return { key: "pending", label: "Pending", tone: "neutral" };
}
