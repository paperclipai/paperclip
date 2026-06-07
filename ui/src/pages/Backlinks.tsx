import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { mentionsApi } from "../api/agnbMentions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { formatShortDate } from "../lib/utils";

export function Backlinks() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Mentions" }, { label: "Backlinks" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.backlinks, queryFn: () => mentionsApi.backlinks() });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Backlinks</h1>
      </div>
      <AgnbSubnav group="mentions" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Link2} message="No backlinks." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">When</th><th className="p-2">Source</th><th className="p-2 text-right">DA</th><th className="p-2">Kind</th><th className="p-2">Anchor</th><th className="p-2">Status</th></tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id} className="border-b border-border/60">
                  <td className="p-2 font-mono text-xs">{formatShortDate(b.acquired_at)}</td>
                  <td className="p-2"><a href={b.source_url} target="_blank" rel="noreferrer" className="hover:underline">{b.source_domain}</a></td>
                  <td className="p-2 text-right">{b.source_da ?? "—"}</td>
                  <td className="p-2"><Badge variant="outline">{b.kind}</Badge></td>
                  <td className="p-2 text-xs text-muted-foreground">{b.anchor_text ?? "—"}</td>
                  <td className="p-2 text-xs">{b.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
