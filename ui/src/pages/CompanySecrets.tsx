import { useEffect } from "react";
import { KeyRound } from "lucide-react";
import { SecretsManager } from "@/components/SecretsManager";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

export function CompanySecrets() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Secrets" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  if (!selectedCompany || !selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Secrets</h1>
      </div>
      <SecretsManager companyId={selectedCompanyId} />
    </div>
  );
}
