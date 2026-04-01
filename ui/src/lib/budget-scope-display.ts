import type { BudgetIncident, BudgetPolicySummary } from "@paperclipai/shared";
import { formatMessage } from "../i18n";
import { getRuntimeLocale } from "../i18n/runtime";

function pausedLabel(count: number, singularKey: string, pluralKey: string) {
  const locale = getRuntimeLocale();
  const noun = formatMessage(locale, count === 1 ? singularKey : pluralKey);
  return formatMessage(locale, "budgetScope.pausedItem", { count, noun });
}

export function budgetSectionDescription(scopeType: BudgetPolicySummary["scopeType"]): string {
  const locale = getRuntimeLocale();
  if (scopeType === "company") return formatMessage(locale, "budgetScope.companyDescription");
  if (scopeType === "agent") return formatMessage(locale, "budgetScope.agentDescription");
  if (scopeType === "seat") return formatMessage(locale, "budgetScope.seatDescription");
  return formatMessage(locale, "budgetScope.projectDescription");
}

export function pausedSummaryLine(input: {
  pausedAgentCount: number;
  pausedSeatCount: number;
  pausedProjectCount: number;
}): string {
  return [
    pausedLabel(input.pausedAgentCount, "budgetScope.agentSingular", "budgetScope.agentPlural"),
    pausedLabel(input.pausedSeatCount, "budgetScope.seatSingular", "budgetScope.seatPlural"),
    pausedLabel(input.pausedProjectCount, "budgetScope.projectSingular", "budgetScope.projectPlural"),
  ].join(" · ");
}

export function incidentPauseMessage(incident: Pick<BudgetIncident, "scopeType">): string {
  const locale = getRuntimeLocale();
  if (incident.scopeType === "project") return formatMessage(locale, "budgetScope.projectIncident");
  if (incident.scopeType === "seat") return formatMessage(locale, "budgetScope.seatIncident");
  return formatMessage(locale, "budgetScope.scopeIncident");
}
