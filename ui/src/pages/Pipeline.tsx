import { useEffect } from "react";
import { LayoutGrid } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { AgnbSubnav } from "../components/AgnbSubnav";

export function Pipeline() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipeline" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">Pipeline</h1>
            <span className="rounded bg-[#FF7A59]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#FF7A59]">
              HS
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            HubSpot deal board is unavailable.
          </p>
        </div>
      </div>
      <EmptyState icon={LayoutGrid} message="Pipeline board unavailable." />
    </div>
  );
}
