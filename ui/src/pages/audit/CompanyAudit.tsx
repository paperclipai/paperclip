import { useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { EmptyState } from "../../components/EmptyState";
import { AuditFeed } from "./AuditFeed";

/**
 * Company-level agent audit page (PAP-14464, Phase 3b) — a permission-gated
 * rich view in the unified codebase, matching the `tools:view_audit` precedent.
 * The feed itself renders the upsell/permission-denied state when the caller
 * lacks `audit:view_agent_actions` (server-authoritative, see `AuditFeed`).
 */
export function CompanyAudit() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Audit" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldCheck} message="Select a company to view the agent audit log." />;
  }

  return <AuditFeed companyId={selectedCompanyId} />;
}
