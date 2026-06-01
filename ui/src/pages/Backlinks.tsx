import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trash2 } from "lucide-react";
import { mentionsApi } from "../api/agnbMentions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatShortDate } from "../lib/utils";

const KINDS = ["earned", "foundational", "directory", "yc_swap", "cold_swap", "guest_post", "integration", "community"];

export function Backlinks() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Mentions" }, { label: "Backlinks" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.backlinks, queryFn: () => mentionsApi.backlinks() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.backlinks });
  const del = async (id: string) => { await mentionsApi.deleteBacklink(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="mentions" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Backlinks</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Add backlink</Button>
      </div>
      {open && (
        <AgnbFormModal
          title="Add backlink"
          fields={[
            { key: "source_url", label: "Source URL", required: true },
            { key: "target_url", label: "Target URL", required: true },
            { key: "anchor_text", label: "Anchor text" },
            { key: "kind", label: "Kind", type: "select", options: KINDS.map((k) => ({ value: k, label: k })) },
            { key: "source_da", label: "Domain authority", type: "number" },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await mentionsApi.addBacklink({ source_url: v.source_url, target_url: v.target_url, anchor_text: v.anchor_text || undefined, kind: v.kind || undefined, source_da: v.source_da || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Link2} message="No backlinks." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">When</th><th className="p-2">Source</th><th className="p-2 text-right">DA</th><th className="p-2">Kind</th><th className="p-2">Anchor</th><th className="p-2">Status</th><th className="p-2"></th></tr>
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
                  <td className="p-2"><button onClick={() => del(b.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
