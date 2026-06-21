import type { MicroRegistryExperiment, MicroRegistryOverview } from "@paperclipai/shared";

export type MicroBoardReviewDecision = "approve_local_dry_run_plan" | "needs_revision" | "hold";

export interface MicroRegistrySummary {
  pods: number;
  activeExperiments: number;
  openDependencies: number;
  evidencePacks: number;
  promotionRequests: number;
}

const TERMINAL_EXPERIMENT_STATES = new Set(["killed", "archived", "promoted"]);

export function summarizeMicroRegistry(registry: MicroRegistryOverview): MicroRegistrySummary {
  return {
    pods: registry.pods.length,
    activeExperiments: registry.experiments.filter((experiment) => !TERMINAL_EXPERIMENT_STATES.has(experiment.lifecycleState)).length,
    openDependencies: registry.dependencyRequests.filter((request) => !["resolved", "cancelled", "closed"].includes(request.status)).length,
    evidencePacks: registry.evidencePacks.length,
    promotionRequests: registry.promotionRequests.filter((request) => !["approved", "rejected", "cancelled"].includes(request.status)).length,
  };
}

export function formatExperimentWindow(experiment: Pick<MicroRegistryExperiment, "holdingPeriodMinMinutes" | "holdingPeriodMaxMinutes">): string {
  const min = `${experiment.holdingPeriodMinMinutes}m`;
  const max = experiment.holdingPeriodMaxMinutes === null || experiment.holdingPeriodMaxMinutes >= 390
    ? "EOD"
    : `${experiment.holdingPeriodMaxMinutes}m`;
  return `${min} → ${max}`;
}

export function isExperimentExecutionGated(experiment: Pick<MicroRegistryExperiment, "lifecycleState" | "overnightAllowed">): boolean {
  return experiment.overnightAllowed === false && ["draft", "preregistering", "waiting_on_dependencies", "ready_for_board_review"].includes(experiment.lifecycleState);
}

export function boardReviewQueue(registry: MicroRegistryOverview): MicroRegistryExperiment[] {
  return registry.experiments.filter((experiment) => experiment.lifecycleState === "ready_for_board_review");
}

export function boardReviewDecisionLabel(decision: MicroBoardReviewDecision): string {
  switch (decision) {
    case "approve_local_dry_run_plan":
      return "Approve local dry-run plan";
    case "needs_revision":
      return "Send back for revision";
    case "hold":
      return "Hold at board review";
  }
}
