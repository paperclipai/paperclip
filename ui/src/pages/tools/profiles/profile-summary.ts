import { t } from "@/i18n";
import type { ToolProfileStatus, ToolProfileSummary, ToolProfileWithDetails } from "@paperclipai/shared";

/**
 * Prosumer copy for the access-profile index (PAP-10997, AP1). Reads the
 * server-computed `summary` and renders the friendly "Allows" / "Assigned to"
 * lines the table shows. Vocabulary gate: nothing here says
 * binding/entry/selector/priority — only "tools", "apps", "agents".
 */

/** "9 tools · 3 apps" / "All tools" / "All except 2 tools". */
export function allowsLabel(summary: ToolProfileSummary): string {
  if (summary.accessMode === "all_except") {
    return summary.excludedToolCount === 0
      ? t("localizationTools.allTools193")
      : t("localizationTools.allExceptTools", { count: summary.excludedToolCount });
  }
  const parts = [t("localizationApps.toolCount", { count: summary.allowedToolCount })];
  if (summary.allowedApplicationCount > 0) {
    parts.push(t("localizationApps.appCount", { count: summary.allowedApplicationCount }));
  }
  return parts.join(" · ");
}

export interface AssignedLabel {
  text: string;
  /** A profile with no assignment has no effect — the index shows a quiet hint. */
  unassigned: boolean;
}

/** "Organization default" / "2 agents" / "Not assigned yet". */
export function assignedLabel(summary: ToolProfileSummary): AssignedLabel {
  if (summary.isCompanyDefault) return { text: t("pages.companySettings.policyOption.companyDefault"), unassigned: false };
  if (summary.appliesToAgentCount > 0) {
    return { text: t("localizationTools.agentCount", { count: summary.appliesToAgentCount }), unassigned: false };
  }
  if (summary.assignmentCount > 0) {
    return { text: t("localizationTools.assignmentCount", { count: summary.assignmentCount }), unassigned: false };
  }
  return { text: t("localizationTools.notAssignedYet146"), unassigned: true };
}

export const STATUS_LABEL: Record<ToolProfileStatus, string> = {
  get draft() { return t("status.draft"); },
  get active() { return t("status.active"); },
  get disabled() { return t("localizationRoutines.off"); },
  get archived() { return t("status.archived"); },
};

export function isDraft(profile: Pick<ToolProfileWithDetails, "status">): boolean {
  return profile.status === "draft";
}
