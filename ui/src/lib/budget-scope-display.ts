import type { BudgetIncident, BudgetPolicySummary } from "@paperclipai/shared";

function pausedLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"} paused`;
}

export function budgetSectionDescription(scopeType: BudgetPolicySummary["scopeType"]): string {
  if (scopeType === "company") return "Company-wide monthly policy.";
  if (scopeType === "agent") return "Recurring monthly spend policies for individual agents.";
  if (scopeType === "seat") return "Recurring monthly spend policies for stable operating seats.";
  return "Lifetime spend policies for execution-bound projects.";
}

export function pausedSummaryLine(input: {
  pausedAgentCount: number;
  pausedSeatCount: number;
  pausedProjectCount: number;
}): string {
  return [
    pausedLabel(input.pausedAgentCount, "agent"),
    pausedLabel(input.pausedSeatCount, "seat"),
    pausedLabel(input.pausedProjectCount, "project"),
  ].join(" · ");
}

export function incidentPauseMessage(incident: Pick<BudgetIncident, "scopeType">): string {
  if (incident.scopeType === "project") {
    return "Project execution is paused. New work in this project will not start until you resolve the budget incident.";
  }
  if (incident.scopeType === "seat") {
    return "This seat is paused. New work attributed to this seat will not start until you resolve the budget incident.";
  }
  return "This scope is paused. New heartbeats will not start until you resolve the budget incident.";
}
