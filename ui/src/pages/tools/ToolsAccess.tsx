import { useEffect } from "react";
import { Wrench } from "lucide-react";
import { Link, Navigate, useParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { ProfilesIndex } from "./profiles/ProfilesIndex";
import { GatewaysTab } from "./GatewaysTab";
import { PasteConfigTab } from "./PasteConfigTab";
import { SmokeLabTab } from "./SmokeLabTab";
import {
  ADVANCED_TABS,
  TOOL_TABS,
  advancedTabHref,
  isAdvancedSetupTab,
  type ToolTabKey,
} from "./tool-tabs";

function renderTab(tab: ToolTabKey, companyId: string) {
  switch (tab) {
    case "profiles":
      return <ProfilesIndex companyId={companyId} />;
    case "gateways":
      return <GatewaysTab companyId={companyId} />;
    case "smoke-lab":
      return <SmokeLabTab companyId={companyId} />;
    case "paste-config":
    default:
      return <PasteConfigTab companyId={companyId} />;
  }
}

export function ToolsAccess() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const params = useParams<{ tab?: string }>();
  const activeTab = (TOOL_TABS.find((t) => t.key === params.tab)?.key ?? "paste-config") as ToolTabKey;
  const advanced = isAdvancedSetupTab(activeTab);
  const tabLabel = TOOL_TABS.find((t) => t.key === activeTab)?.label;

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      ...(advanced
        ? [{ label: "Advanced setup" }]
        : [
            { label: "Advanced setup", href: advancedTabHref("paste-config") },
            { label: tabLabel ?? "Developer tools" },
          ]),
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, advanced, tabLabel]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to open advanced setup.</div>;
  }

  if (params.tab === "run-your-own") {
    return <Navigate to="/apps" replace />;
  }

  // Retired developer tabs (PAP-10915/PAP-10928) — keep old links working.
  if (
    params.tab === "applications" ||
    params.tab === "connections" ||
    params.tab === "overview" ||
    params.tab === "examples" ||
    params.tab === "audit"
  ) {
    return <Navigate to="/apps" replace />;
  }

  if (params.tab === "runtime") {
    return <Navigate to="/apps" replace />;
  }

  if (params.tab === "policies") {
    return <Navigate to="/apps/advanced/profiles" replace />;
  }

  if (advanced) {
    // M8a/M8b chrome (PAP-10839 wires): Advanced badge, plain-words subtitle,
    // and a focused setup tab. The developer surface stays behind a quiet link.
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
        <header>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-foreground">Advanced setup</h1>
            <span className="inline-flex items-center rounded-full bg-foreground px-2.5 py-0.5 text-(length:--text-micro) font-bold text-background">
              Advanced
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            For tools that aren't in the gallery. You'll need details from the tool's documentation.
            Most people never need this — if the app you want is in the gallery,{" "}
            <Link to="/apps" className="font-medium text-primary hover:underline">
              connect it there instead
            </Link>
            .
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

        <div className="min-h-(--sz-300px)">{renderTab(activeTab, selectedCompanyId)}</div>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Wrench className="h-3.5 w-3.5" />
          Looking for the developer surface?{" "}
          <Link to={advancedTabHref("profiles")} className="font-medium text-primary hover:underline">
            Open developer tools
          </Link>
        </p>
      </div>
    );
  }

  return <div className="max-w-5xl">{renderTab(activeTab, selectedCompanyId)}</div>;
}
