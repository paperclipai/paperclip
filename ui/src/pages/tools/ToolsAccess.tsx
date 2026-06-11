import { useEffect } from "react";
import { Settings2, Wrench } from "lucide-react";
import { Link, Navigate, useParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { ApplicationsTab } from "./ApplicationsTab";
import { ProfilesTab } from "./ProfilesTab";
import { PoliciesTab } from "./PoliciesTab";
import { RuntimeTab } from "./RuntimeTab";
import { AuditTab } from "./AuditTab";
import { PasteConfigTab } from "./PasteConfigTab";
import { RunYourOwnTab } from "./RunYourOwnTab";
import {
  ADVANCED_TABS,
  TOOL_TABS,
  advancedTabHref,
  isAdvancedSetupTab,
  type ToolTabKey,
} from "./tool-tabs";

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
    case "paste-config":
      return <PasteConfigTab companyId={companyId} />;
    case "run-your-own":
    default:
      return <RunYourOwnTab companyId={companyId} />;
  }
}

export function ToolsAccess() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const params = useParams<{ tab?: string }>();
  const activeTab = (TOOL_TABS.find((t) => t.key === params.tab)?.key ?? "run-your-own") as ToolTabKey;
  const advanced = isAdvancedSetupTab(activeTab);
  const tabLabel = TOOL_TABS.find((t) => t.key === activeTab)?.label;

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      ...(advanced
        ? [{ label: "Advanced setup" }]
        : [
            { label: "Advanced setup", href: advancedTabHref("run-your-own") },
            { label: tabLabel ?? "Developer tools" },
          ]),
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, advanced, tabLabel]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to open advanced setup.</div>;
  }

  // Retired developer tabs (PAP-10915) — keep old links working.
  if (params.tab === "connections" || params.tab === "overview" || params.tab === "examples") {
    return <Navigate to={advancedTabHref("applications")} replace />;
  }

  if (advanced) {
    // M8a/M8b chrome (PAP-10839 wires): Advanced badge, plain-words subtitle,
    // and a two-tab switcher. The developer surface stays behind a quiet link.
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
        <header>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-foreground">Advanced setup</h1>
            <span className="inline-flex items-center rounded-full bg-foreground px-2.5 py-0.5 text-[11px] font-bold text-background">
              Advanced
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            For tools that aren't in the gallery. You'll need details from the tool's documentation.
          </p>
        </header>

        <nav className="flex items-center gap-6 border-b border-border">
          {ADVANCED_TABS.map((tab) => (
            <Link
              key={tab.key}
              to={advancedTabHref(tab.key)}
              className={cn(
                "-mb-px border-b-2 pb-2 text-sm transition-colors",
                tab.key === activeTab
                  ? "border-foreground font-bold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className="min-h-[300px]">{renderTab(activeTab, selectedCompanyId)}</div>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Wrench className="h-3.5 w-3.5" />
          Looking for the developer surface?{" "}
          <Link to={advancedTabHref("applications")} className="font-medium text-primary hover:underline">
            Open developer tools
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <Settings2 className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-bold text-foreground">Developer tools</h1>
      </div>

      <div className="min-h-[300px]">{renderTab(activeTab, selectedCompanyId)}</div>
    </div>
  );
}
