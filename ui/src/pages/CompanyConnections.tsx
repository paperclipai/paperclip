import { useEffect } from "react";
import { Link2 } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { DecisionModelSettingsSection } from "../components/decision-models/DecisionModelSettings";
import { FastResponseSettingsSection } from "../components/fast-responses/FastResponseSettings";
import { useFastResponsesEnabled } from "../hooks/useFastResponsesEnabled";
import { PromptInjectionPreventionSettingsSection } from "../components/prompt-injection-prevention/PromptInjectionPreventionSettings";
import { useTranslation } from "@/i18n";

export function CompanyConnections() {
  const { t } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { enabled } = useFastResponsesEnabled();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("settings.company.companyFallback"), href: "/dashboard" },
      { label: t("settings.breadcrumb"), href: "/company/settings" },
      { label: t("settings.connections.title") },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name, t]);

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("settings.company.noCompany")}
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-8">
      <div className="flex items-center gap-2">
        <Link2 className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("settings.connections.title")}</h1>
      </div>
      <DecisionModelSettingsSection key={selectedCompanyId} companyId={selectedCompanyId} />
      <div className="max-w-2xl border-t border-border pt-8">
        <PromptInjectionPreventionSettingsSection key={`injection-${selectedCompanyId}`} companyId={selectedCompanyId} />
      </div>
      {enabled && <div className="max-w-2xl border-t border-border pt-8">
        <FastResponseSettingsSection key={`fast-${selectedCompanyId}`} companyId={selectedCompanyId} />
      </div>}
    </div>
  );
}
