import { t as finalPagesT } from "@/i18n";
import { auditSectionHref, type AuditSection } from "./audit/audit-navigation";

export type AgentAuditView = Extract<AuditSection, "activity" | "runs" | "costs" | "budgets">;

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
  | "advanced"
  | AgentAuditView
  | "run-detail";

export type AgentLocalDetailView = Exclude<AgentDetailView, "run-detail">;

export const AGENT_DETAIL_NAVIGATION: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ value: AgentLocalDetailView; label: string }>;
}> = [
  {
    get label() { return finalPagesT("final-pages:Agent_11b39c"); },
    items: [
      { value: "overview", get label() { return finalPagesT("final-pages:Overview_d4b1ea"); } },
      { value: "instructions", get label() { return finalPagesT("final-pages:Identity_999f23"); } },
      { value: "runtime", get label() { return finalPagesT("final-pages:Harness_Runtime_6711e5"); } },
      { value: "secrets", get label() { return finalPagesT("final-pages:Secrets_variables_bd56b5"); } },
      { value: "permissions", get label() { return finalPagesT("final-pages:Permissions_Trust_183c6a"); } },
      { value: "advanced", get label() { return finalPagesT("final-pages:Advanced_9f088d"); } },
    ],
  },
  {
    get label() { return finalPagesT("final-pages:Audit_bb6aea"); },
    items: [
      { value: "activity", get label() { return finalPagesT("final-pages:Activity_38da15"); } },
      { value: "runs", get label() { return finalPagesT("final-pages:Runs_848f54"); } },
      { value: "costs", get label() { return finalPagesT("final-pages:Costs_b88fc5"); } },
      { value: "budgets", get label() { return finalPagesT("final-pages:Budgets_a1a06e"); } },
    ],
  },
] as const;

const HIDDEN_VIEW_LABELS: Partial<Record<AgentLocalDetailView, string>> = {
  get skills() { return finalPagesT("final-pages:Skills_66d0f5"); },
  get tools() { return finalPagesT("final-pages:Tools_ea93d6"); },
  get channels() { return finalPagesT("final-pages:Channels_4c8906"); },
  get "api-keys"() { return finalPagesT("final-pages:API_Keys_c08f17"); },
  get revisions() { return finalPagesT("final-pages:Agent_history_9679fc"); },
};

export const AGENT_AUDIT_VIEWS: ReadonlySet<AgentLocalDetailView> = new Set(["activity", "runs", "costs", "budgets"]);

export function isAgentAuditView(view: AgentDetailView): view is AgentAuditView {
  return AGENT_AUDIT_VIEWS.has(view as AgentLocalDetailView);
}

export function agentDetailViewLabel(view: AgentLocalDetailView): string {
  const item = AGENT_DETAIL_NAVIGATION.flatMap((section) => section.items).find((entry) => entry.value === view);
  return item?.label ?? HIDDEN_VIEW_LABELS[view] ?? finalPagesT("final-pages:Overview_d4b1ea");
}

export function parseAgentDetailView(value: string | null): AgentLocalDetailView {
  if (value === "identity" || value === "instructions" || value === "prompts") return "instructions";
  if (value === "skills") return "skills";
  if (value === "runtime" || value === "configure" || value === "configuration") return "runtime";
  if (value === "secrets") return "secrets";
  if (value === "tools") return "tools";
  if (value === "channels") return "channels";
  if (value === "permissions" || value === "trust") return "permissions";
  if (value === "api-keys" || value === "keys") return "api-keys";
  if (value === "revisions" || value === "history") return "revisions";
  if (value === "advanced") return "advanced";
  const audit = agentLegacyAuditSection(value);
  if (audit) return audit;
  return "overview";
}

export function agentDetailSegment(view: AgentLocalDetailView): string {
  return view === "instructions" ? "identity" : view;
}

export function agentDetailHref(agentRef: string, view: AgentLocalDetailView = "overview") {
  return `/agents/${agentRef}/${agentDetailSegment(view)}`;
}

export function agentLegacyAuditSection(value: string | null): AgentAuditView | null {
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
