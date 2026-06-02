import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { opsApi, SYNC_JOBS } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function AgnbSync() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Sync" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.syncStatus, queryFn: () => opsApi.syncStatus() });

  const run = async (key: string, path: string) => {
    setBusy(key);
    try { await opsApi.runJob(path); setResult((r) => ({ ...r, [key]: "ok" })); qc.invalidateQueries({ queryKey: queryKeys.agnb.syncStatus }); }
    catch (e) { setResult((r) => ({ ...r, [key]: e instanceof Error ? e.message : "failed" })); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="ops" />
      <h1 className="text-lg font-semibold">Sync control</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        <>
          {data && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Last sync" value={data.counts.lastSyncMin != null ? `${data.counts.lastSyncMin}m ago` : "—"} />
              <Stat label="Inbox" value={String(data.counts.inbox)} />
              <Stat label="Unprocessed" value={String(data.counts.unprocessed)} />
              <Stat label="Unmatched" value={String(data.counts.unmatched)} />
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {SYNC_JOBS.map((j) => (
              <div key={j.key} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                <span>{j.label}{result[j.key] && <span className={result[j.key] === "ok" ? "ml-2 text-[11px] text-emerald-600" : "ml-2 text-[11px] text-destructive"}>{result[j.key]}</span>}</span>
                <Button size="sm" variant="outline" onClick={() => run(j.key, j.path)} disabled={busy === j.key}>{busy === j.key ? "…" : "Run"}</Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="text-xl font-semibold">{value}</div></CardContent></Card>;
}
