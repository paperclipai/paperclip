import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crosshair } from "lucide-react";
import { campaignsApi } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function Targeting() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }, { label: "Saved targetings" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.targeting, queryFn: () => campaignsApi.targeting() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="campaigns" />
      <h1 className="text-lg font-semibold">Saved targetings</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Crosshair} message="No saved targetings." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{t.name}</span>
                  <Badge variant="outline">{t.last_lead_count != null ? `${t.last_lead_count} leads` : "never run"}</Badge>
                </div>
                <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{t.query}</div>
                {t.notes && <p className="mt-1 text-xs">{t.notes}</p>}
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{t.created_by}</span><span>{relativeTime(t.created_at)}</span>
                  {(t.tags ?? []).map((tag) => <span key={tag} className="rounded bg-muted px-1 uppercase">{tag}</span>)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
