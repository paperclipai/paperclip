import { useEffect } from "react";
import { TrendingUp } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { AgnbSubnav } from "../components/AgnbSubnav";

export function YoutubeTrends() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "YouTube" }, { label: "Trends" }]), [setBreadcrumbs]);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="youtube" />
      <h1 className="text-lg font-semibold">Trends</h1>
      <EmptyState icon={TrendingUp} message="Trends are fetched on demand (generative). The fetch-and-promote action will be wired next; promoted trends appear on the Ideas tab." />
    </div>
  );
}
