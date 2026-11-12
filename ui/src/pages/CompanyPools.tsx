import { useEffect } from "react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { HarnessPoolSettings } from "../components/ai-connections/HarnessPoolSettings";

export function CompanyPools() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Pools" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">No organization selected. Select an organization from the switcher above.</p>;
  return <HarnessPoolSettings key={selectedCompanyId} companyId={selectedCompanyId} />;
}
