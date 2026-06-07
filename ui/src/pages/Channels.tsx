import { useEffect } from "react";
import { Share2 } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { AgnbSubnav } from "../components/AgnbSubnav";

export function Channels() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Channels" }]), [setBreadcrumbs]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Channels</h1>
      </div>
      <AgnbSubnav group="pipeline" />
      <EmptyState icon={Share2} message="Channel attribution is unavailable." />
    </div>
  );
}
