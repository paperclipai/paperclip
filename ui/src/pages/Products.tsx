import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Package2 } from "lucide-react";
import { campaignsApi } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";

export function Products() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }, { label: "Products" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.products, queryFn: () => campaignsApi.products() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="campaigns" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Products</h1>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Package2} message="No products." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((p) => (
            <Card key={p.id}><CardContent className="p-3">
              <div className="font-medium">{p.name}</div>
              {p.description && <div className="mt-0.5 line-clamp-4 text-sm text-muted-foreground">{p.description}</div>}
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
