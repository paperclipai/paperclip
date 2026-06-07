import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Phone } from "lucide-react";
import { campaignsApi } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

function tone(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "done") return "default";
  if (s === "running") return "secondary";
  if (s === "error" || s === "blocked") return "destructive";
  return "outline";
}

export function JustDial() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }, { label: "JustDial" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.justdial, queryFn: () => campaignsApi.justdial() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.justdial });
  const run = async (id: string) => { setRunId(id); try { await campaignsApi.runJustdial(id); refresh(); } catch (e) { alert(e instanceof Error ? e.message : "Failed"); } finally { setRunId(null); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">JustDial scraper</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Queue job</Button>
      </div>
      <AgnbSubnav group="campaigns" />
      {open && (
        <AgnbFormModal
          title="Queue JustDial scrape"
          fields={[{ key: "category", label: "Category", required: true, placeholder: "e.g. dentists" }, { key: "city", label: "City", required: true, placeholder: "e.g. Mumbai" }, { key: "max_pages", label: "Max pages (1-20)", type: "number" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await campaignsApi.queueJustdial({ category: v.category, city: v.city, max_pages: Math.min(Math.max(Number(v.max_pages) || 1, 1), 20) }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Phone} message="No scrape jobs." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Category</th><th className="p-2">City</th><th className="p-2 text-right">Pages</th><th className="p-2">Status</th><th className="p-2 text-right">Leads</th><th className="p-2">When</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.map((j) => (
                <tr key={j.id} className="border-b border-border/60">
                  <td className="p-2">{j.category}</td>
                  <td className="p-2">{j.city}</td>
                  <td className="p-2 text-right">{j.pages_scraped ?? 0}/{j.max_pages}</td>
                  <td className="p-2"><Badge variant={tone(j.status)}>{j.status}</Badge></td>
                  <td className="p-2 text-right">{j.leads_count ?? 0}</td>
                  <td className="p-2 text-xs text-muted-foreground">{relativeTime(j.created_at)}</td>
                  <td className="p-2">
                    {(j.status === "pending" || j.status === "error") && (
                      <Button size="sm" variant="outline" onClick={() => run(j.id)} disabled={runId === j.id}>{runId === j.id ? "…" : "Run"}</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
