import { t } from "@/i18n";
import { auditSectionHref, type AuditSection } from "./audit/audit-navigation";

export type AgentDetailView =
  | "overview"
  | "instructions"
  | "skills"
  | "runtime"
  | "secrets"
  | "tools"
  | "channels"
  | "permissions"
  | "api-keys"
  | "revisions"
  | "run-detail";

export type AgentLocalDetailView = Exclude<AgentDetailView, "run-detail">;

export const AGENT_DETAIL_NAVIGATION: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ value: AgentLocalDetailView; label: string }>;
}> = [
  {
    get label() { return t("localizationAgents.navigation_Agent"); },
    items: [
      { value: "overview", get label() { return t("localizationAgents.navigation_Overview"); } },
      { value: "instructions", get label() { return t("localizationAgents.navigation_Instructions"); } },
      { value: "skills", get label() { return t("localizationAgents.navigation_Skills"); } },
    ],
  },
  {
    get label() { return t("localizationAgents.navigation_Runtime"); },
    items: [
      { value: "runtime", get label() { return t("localizationAgents.navigation_Harness_Runtime"); } },
      { value: "secrets", get label() { return t("pages.agentDetail.breadcrumbSecrets"); } },
      { value: "tools", get label() { return t("pages.agentDetail.breadcrumbTools"); } },
      { value: "channels", get label() { return t("agentSetup.channels"); } },
    ],
  },
  {
    get label() { return t("localizationAgents.navigation_Governance"); },
    items: [
      { value: "permissions", get label() { return t("localizationAgents.navigation_Permissions_Trust"); } },
      { value: "api-keys", get label() { return t("localizationAgents.navigation_API_Keys"); } },
      { value: "revisions", get label() { return t("localizationAgents.navigation_Revisions"); } },
    ],
  },
] as const;

export function parseAgentDetailView(value: string | null): AgentLocalDetailView {
  if (value === "instructions" || value === "prompts") return "instructions";
  if (value === "skills") return "skills";
  if (value === "runtime" || value === "configure" || value === "configuration") return "runtime";
  if (value === "secrets") return "secrets";
  if (value === "tools") return "tools";
  if (value === "channels") return "channels";
  if (value === "permissions" || value === "trust") return "permissions";
  if (value === "api-keys" || value === "keys") return "api-keys";
  if (value === "revisions" || value === "history") return "revisions";
  return "overview";
}

export function agentDetailHref(agentRef: string, view: AgentLocalDetailView = "overview") {
  return `/agents/${agentRef}/${view}`;
}

export function agentLegacyAuditSection(value: string | null): AuditSection | null {
  if (value === "runs") return "runs";
  if (value === "audit" || value === "activity") return "activity";
  if (value === "cost" || value === "costs") return "costs";
  if (value === "budget" || value === "budgets") return "budgets";
  return null;
}

export function agentScopedAuditHref(agentId: string, section: AuditSection) {
  return auditSectionHref(section, {
    mode: section === "activity" ? "agents" : undefined,
    agentId,
  });
}
