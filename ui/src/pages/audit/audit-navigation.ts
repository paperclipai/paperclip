export type AuditSection = "activity" | "runs" | "costs" | "budgets" | "timeline";

export const AUDIT_SECTIONS: ReadonlyArray<{
  value: AuditSection;
  label: string;
  href: string;
}> = [
  { value: "activity", label: "Activity", href: "/activity" },
  { value: "runs", label: "Runs", href: "/activity/runs" },
  { value: "costs", label: "Costs", href: "/activity/costs" },
  { value: "budgets", label: "Budgets", href: "/activity/budgets" },
  { value: "timeline", label: "Timeline", href: "/activity/timeline" },
];

export interface AuditLinkScope {
  mode?: "all" | "agents";
  agentId?: string | null;
  runId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export function auditSectionHref(section: AuditSection, scope: AuditLinkScope = {}) {
  const base = AUDIT_SECTIONS.find((candidate) => candidate.value === section)?.href ?? "/activity";
  const search = new URLSearchParams();
  if (scope.mode === "agents") search.set("mode", "agents");
  if (scope.agentId) search.set("agentId", scope.agentId);
  if (scope.runId) search.set("runId", scope.runId);
  if (scope.entityType) search.set("entityType", scope.entityType);
  if (scope.entityId) search.set("entityId", scope.entityId);
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

/** Link target for an agent's attributed activity or company-wide run history. */
export function agentAuditHref(agentId: string, section: "activity" | "runs" = "activity") {
  return auditSectionHref(section, {
    mode: section === "activity" ? "agents" : undefined,
    agentId,
  });
}

/** Link target for the immutable activity recorded directly against a routine. */
export function routineAuditHref(routineId: string) {
  return auditSectionHref("activity", {
    entityType: "routine",
    entityId: routineId,
  });
}

/** Link target for the attributed activity behind a specific run. */
export function runAuditHref(runId: string, agentId?: string | null) {
  return auditSectionHref("activity", { mode: "agents", runId, agentId });
}

export function auditScopeFromSearchParams(searchParams: URLSearchParams): AuditLinkScope {
  return {
    mode: searchParams.get("mode") === "agents" ? "agents" : "all",
    agentId: searchParams.get("agentId"),
    runId: searchParams.get("runId"),
    entityType: searchParams.get("entityType"),
    entityId: searchParams.get("entityId"),
  };
}
