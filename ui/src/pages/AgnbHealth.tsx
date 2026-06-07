import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { HeartPulse } from "lucide-react";
import { opsApi } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";

const COLOR: Record<string, string> = { ok: "#16a34a", degraded: "#d97706", down: "#dc2626", unknown: "#737373" };

export function AgnbHealth() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Health" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.health, queryFn: () => opsApi.health(), refetchInterval: 30_000 });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Health</h1>
      <AgnbSubnav group="ops" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={HeartPulse} message="No checks." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((c) => (
            <div key={c.name} className="flex items-center gap-3 rounded-md border border-border p-2.5 text-sm">
              <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: COLOR[c.status] }} />
              <span className="font-medium">{c.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
