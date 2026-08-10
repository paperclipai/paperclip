import { useEffect } from "react";
import { useNavigate } from "@/lib/router";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "../components/PageTabBar";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { OrgChart } from "./OrgChart";
import { OfficeView } from "./OfficeView";

/**
 * Org page shell: hosts the "Chart" (hierarchy) and "Office" (2.5D floor)
 * sub-tabs. Routed at /org (chart) and /org/office (office).
 */
export function OrgPage({ tab }: { tab: "chart" | "office" }) {
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Org" }]);
  }, [setBreadcrumbs]);

  const go = (value: string) => navigate(value === "chart" ? "/org" : "/org/office");

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <Tabs value={tab} onValueChange={go}>
        <PageTabBar
          items={[
            { value: "chart", label: "Chart" },
            { value: "office", label: "Office" },
          ]}
          value={tab}
          onValueChange={go}
          align="start"
        />
      </Tabs>
      <div className="min-h-0 flex-1">{tab === "chart" ? <OrgChart /> : <OfficeView />}</div>
    </div>
  );
}
