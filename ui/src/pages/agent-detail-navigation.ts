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
    label: "Agent",
    items: [
      { value: "overview", label: "Overview" },
      { value: "instructions", label: "Identity" },
      { value: "runtime", label: "Harness / Runtime" },
      { value: "secrets", label: "Secrets & variables" },
      { value: "permissions", label: "Permissions / Trust" },
      { value: "advanced", label: "Advanced" },
    ],
  },
  {
    label: "Audit",
    items: [
      { value: "activity", label: "Activity" },
      { value: "runs", label: "Runs" },
      { value: "costs", label: "Costs" },
      { value: "budgets", label: "Budgets" },
    ],
  },
] as const;

const HIDDEN_VIEW_LABELS: Partial<Record<AgentLocalDetailView, string>> = {
  skills: "Skills",
  tools: "Tools",
  channels: "Channels",
  "api-keys": "API Keys",
  revisions: "Agent history",
};

export const AGENT_AUDIT_VIEWS: ReadonlySet<AgentLocalDetailView> = new Set(["activity", "runs", "costs", "budgets"]);

export function isAgentAuditView(view: AgentDetailView): view is AgentAuditView {
  return AGENT_AUDIT_VIEWS.has(view as AgentLocalDetailView);
}

export function agentDetailViewLabel(view: AgentLocalDetailView): string {
  const item = AGENT_DETAIL_NAVIGATION.flatMap((section) => section.items).find((entry) => entry.value === view);
  return item?.label ?? HIDDEN_VIEW_LABELS[view] ?? "Overview";
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
