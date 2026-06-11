import { useEffect } from "react";
import { ClipboardList } from "lucide-react";
import { Navigate, useParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { OverviewTab } from "./OverviewTab";
import { ApplicationsTab } from "./ApplicationsTab";
import { ProfilesTab } from "./ProfilesTab";
import { PoliciesTab } from "./PoliciesTab";
import { RuntimeTab } from "./RuntimeTab";
import { AuditTab } from "./AuditTab";
import { ExamplesTab } from "./ExamplesTab";
import { TOOL_TABS, type ToolTabKey } from "./tool-tabs";

function renderTab(tab: ToolTabKey, companyId: string) {
  switch (tab) {
    case "applications":
      return <ApplicationsTab companyId={companyId} />;
    case "profiles":
      return <ProfilesTab companyId={companyId} />;
    case "policies":
      return <PoliciesTab companyId={companyId} />;
    case "runtime":
      return <RuntimeTab companyId={companyId} />;
    case "audit":
      return <AuditTab companyId={companyId} />;
    case "examples":
      return <ExamplesTab companyId={companyId} />;
    case "overview":
    default:
      return <OverviewTab companyId={companyId} />;
  }
}

export function ToolsAccess() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const params = useParams<{ tab?: string }>();
  const activeTab = (TOOL_TABS.find((t) => t.key === params.tab)?.key ?? "overview") as ToolTabKey;

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Tools" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage tools &amp; access.</div>;
  }

  if (params.tab === "connections") return <Navigate to="/tools/applications" replace />;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-bold text-foreground">Tools</h1>
      </div>

      <div className="min-h-[300px]">{renderTab(activeTab, selectedCompanyId)}</div>
    </div>
  );
}
