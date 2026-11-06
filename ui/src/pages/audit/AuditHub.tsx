import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "@/i18n";
import { History } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useSearchParams } from "@/lib/router";
import { Costs } from "@/pages/Costs";
import { Timeline } from "@/pages/Timeline";
import { AuditFeed, type AuditFeedMode } from "./AuditFeed";
import { AuditRuns } from "./AuditRuns";
import { AgentCommentary } from "./AgentCommentary";
import { RoutineAuditActivity } from "./RoutineAuditActivity";
import {
  AUDIT_SECTIONS,
  auditScopeFromSearchParams,
  auditSectionHref,
  type AuditSection,
} from "./audit-navigation";

export function AuditHub({ section }: { section: AuditSection }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = auditScopeFromSearchParams(searchParams);
  const mode: AuditFeedMode = scope.mode === "agents" ? "agents" : "all";
  const routineId = scope.entityType === "routine" ? scope.entityId ?? undefined : undefined;
  const actionParam = searchParams.get("action");
  const actionDomain = [
    "issue.",
    "case.",
    "agent.",
    "heartbeat.",
    "approval.",
    "project.",
    "goal.",
    "tool_",
    "cost.",
    "company.",
  ].includes(actionParam ?? "") ? actionParam! : "__all";

  const translatedSections = useMemo(() => [
    { value: "activity" as const, label: t("audit.tabs.activity"), href: "/activity" },
    { value: "runs" as const, label: t("audit.tabs.runs"), href: "/activity/runs" },
    { value: "commentary" as const, label: t("audit.tabs.commentary"), href: "/activity/commentary" },
    { value: "costs" as const, label: t("audit.tabs.costs"), href: "/activity/costs" },
    { value: "budgets" as const, label: t("audit.tabs.budgets"), href: "/activity/budgets" },
    { value: "timeline" as const, label: t("audit.tabs.timeline"), href: "/activity/timeline" },
  ], [t]);

  useEffect(() => {
    const current = translatedSections.find((candidate) => candidate.value === section);
    setBreadcrumbs([
      { label: t("audit.title"), href: section === "activity" ? undefined : "/activity" },
      ...(section === "activity" || !current ? [] : [{ label: current.label }]),
    ]);
  }, [section, setBreadcrumbs, t, translatedSections]);

  const handleModeChange = useCallback(
    (next: AuditFeedMode) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          if (next === "agents") params.set("mode", "agents");
          else params.delete("mode");
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleActionDomainChange = useCallback(
    (next: string) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          if (next === "__all") params.delete("action");
          else params.set("action", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleEntityTypeChange = useCallback((next: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next === "__all") params.delete("entityType");
      else params.set("entityType", next);
      params.delete("entityId");
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  const handleEntityIdChange = useCallback((next: string) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (next.trim()) params.set("entityId", next);
      else params.delete("entityId");
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  const handleClearFilters = useCallback(() => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.delete("action");
      params.delete("entityType");
      params.delete("entityId");
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message={t("audit.empty.selectOrg")} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{t("audit.title")}</h1>
      </div>

      <Tabs
        value={section}
        onValueChange={(value) => {
          const next = value as AuditSection;
          navigate(auditSectionHref(next, scope));
        }}
      >
        <PageTabBar items={translatedSections} value={section} align="start" />
      </Tabs>

      {section === "commentary" ? (
        <AgentCommentary key={selectedCompanyId} companyId={selectedCompanyId} />
      ) : section === "activity" && routineId ? (
        <RoutineAuditActivity companyId={selectedCompanyId} routineId={routineId} />
      ) : section === "activity" ? (
        <AuditFeed
          companyId={selectedCompanyId}
          hideHeader
          mode={mode}
          onModeChange={handleModeChange}
          actionDomain={actionDomain}
          onActionDomainChange={handleActionDomainChange}
          entityType={scope.entityType ?? "__all"}
          onEntityTypeChange={handleEntityTypeChange}
          entityId={scope.entityId ?? ""}
          onEntityIdChange={handleEntityIdChange}
          onClearFilters={handleClearFilters}
          lockedAgentId={scope.agentId ?? undefined}
          lockedRunId={scope.runId ?? undefined}
          lockedEntity={
            scope.entityType && scope.entityId
              ? { type: scope.entityType, id: scope.entityId }
              : undefined
          }
        />
      ) : section === "runs" ? (
        <AuditRuns companyId={selectedCompanyId} routineId={routineId} />
      ) : section === "budgets" ? (
        <Costs embedded initialTab="budgets" lockTab />
      ) : section === "timeline" ? (
        <Timeline embedded />
      ) : (
        <Costs embedded initialTab="overview" hideBudgetsTab />
      )}
    </div>
  );
}
