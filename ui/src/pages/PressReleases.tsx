import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Newspaper, Send, Trash2 } from "lucide-react";
import { renewalsApi } from "../api/agnbRenewals";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const TRIGGERS = ["funding", "product_launch", "milestone", "partnership", "award"];

export function PressReleases() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Renewals" }, { label: "Press releases" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.pressReleases, queryFn: () => renewalsApi.pressReleases() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.pressReleases });
  const publish = async (id: string) => { await renewalsApi.publishPress(id).catch(() => {}); refresh(); };
  const del = async (id: string) => { await renewalsApi.deletePress(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="renewals" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Press releases</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Draft release</Button>
      </div>
      {open && (
        <AgnbFormModal
          title="Draft press release"
          submitLabel="Generate"
          fields={[
            { key: "trigger_event", label: "Trigger", type: "select", options: TRIGGERS.map((t) => ({ value: t, label: t })) },
            { key: "details", label: "Details / milestone", required: true, type: "textarea" },
            { key: "spokesperson_name", label: "Spokesperson" },
            { key: "spokesperson_title", label: "Spokesperson title" },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await renewalsApi.draftPress({ trigger_event: v.trigger_event || "milestone", details: v.details, spokesperson_name: v.spokesperson_name || undefined, spokesperson_title: v.spokesperson_title || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Newspaper} message="No press releases." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((p) => (
            <div key={p.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline">{p.trigger_event}</Badge>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Badge variant={p.status === "published" ? "default" : "outline"}>{p.status}</Badge>
                  {p.status !== "published" && <button title="Publish" onClick={() => publish(p.id)}><Send className="h-3.5 w-3.5 hover:text-emerald-600" /></button>}
                  <button title="Delete" onClick={() => del(p.id)}><Trash2 className="h-3.5 w-3.5 hover:text-destructive" /></button>
                </span>
              </div>
              {p.headline && <h3 className="mt-1 font-semibold">{p.headline}</h3>}
              {p.subhead && <p className="text-xs italic text-muted-foreground">{p.subhead}</p>}
              {p.body && <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">{p.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
