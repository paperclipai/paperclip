import { useCallback, useEffect } from "react";
import { History } from "lucide-react";
import { useSearchParams } from "@/lib/router";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useStreamlinedUiEnabled } from "../../hooks/useStreamlinedUiEnabled";
import { EmptyState } from "../../components/EmptyState";
import { AuditFeed, type AuditFeedMode } from "./AuditFeed";
import { AuditHub } from "./AuditHub";

/**
 * Canonical `/:company/activity` entrypoint for the Audit hub. It retains the
 * shared all-actors and privileged Agent Actions modes while Runs, Costs,
 * Budgets, and Timeline live as peer sections. The mode lives in `?mode=` so `/audit` deep
 * links can preset it and links stay shareable. The server enforces both tiers.
 */
export function CompanyActivity() {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode: AuditFeedMode = searchParams.get("mode") === "agents" ? "agents" : "all";
  const actionParam = searchParams.get("action");
  const actionDomain = [
    "issue.",
    "agent.",
    "heartbeat.",
    "approval.",
    "project.",
    "goal.",
    "tool_",
    "cost.",
    "company.",
  ].includes(actionParam ?? "") ? actionParam! : "__all";

  useEffect(() => {
    if (!streamlinedUiEnabled) setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs, streamlinedUiEnabled]);

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
      setSearchParams((current) => {
        const params = new URLSearchParams(current);
        if (next === "__all") params.delete("action");
        else params.set("action", next);
        return params;
      }, { replace: true });
    },
    [setSearchParams],
  );

  if (streamlinedUiEnabled) return <AuditHub section="activity" />;

  if (!selectedCompanyId) {
    return <EmptyState icon={History} message="Select an organization to view activity." />;
  }

  return (
    <AuditFeed
      companyId={selectedCompanyId}
      mode={mode}
      onModeChange={handleModeChange}
      actionDomain={actionDomain}
      onActionDomainChange={handleActionDomainChange}
    />
  );
}
