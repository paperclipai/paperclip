import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { opsApi } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";

export function AgnbSync() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Sync" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.syncStatus, queryFn: () => opsApi.syncStatus() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="ops" />
      <h1 className="text-lg font-semibold">Sync status</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        data && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Last sync" value={data.counts.lastSyncMin != null ? `${data.counts.lastSyncMin}m ago` : "—"} />
            <Stat label="Inbox" value={String(data.counts.inbox)} />
            <Stat label="Unprocessed" value={String(data.counts.unprocessed)} />
            <Stat label="Unmatched" value={String(data.counts.unmatched)} />
          </div>
        )
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="text-xl font-semibold">{value}</div></CardContent></Card>;
}
