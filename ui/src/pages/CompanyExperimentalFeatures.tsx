import { useEffect } from "react";
import { FlaskConical } from "lucide-react";
import { ExperimentalFeaturesSettings } from "@/components/ExperimentalFeaturesSettings";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useExperimentalFeaturesAccess } from "@/hooks/useExperimentalFeaturesAccess";
import { Navigate } from "@/lib/router";

export function CompanyExperimentalFeatures() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { canViewExperimentalFeatures, isLoading } = useExperimentalFeaturesAccess();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Experimental features" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  if (!canViewExperimentalFeatures) {
    return <Navigate to="/company/settings" replace />;
  }

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Experimental Features</h1>
      </div>

      <ExperimentalFeaturesSettings companyId={selectedCompanyId} />
    </div>
  );
}
