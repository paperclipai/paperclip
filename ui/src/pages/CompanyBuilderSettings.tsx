import { Sparkles } from "lucide-react";
import { useEffect } from "react";
import { BuilderConfigEditor } from "@/components/BuilderConfigEditor";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

export function CompanyBuilderSettings() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "AI Builder" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company before editing AI Builder settings.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="rounded-2xl border border-border/70 bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-foreground">AI Builder Settings</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Configure the company-level adapter and runtime used for live Builder turns.
              Existing sessions always pick up the current settings on their next turn.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-6">
        <BuilderConfigEditor companyId={selectedCompanyId} />
      </div>
    </div>
  );
}
