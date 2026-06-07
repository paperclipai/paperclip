import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Linkedin as LinkedinIcon, ExternalLink } from "lucide-react";
import { campaignsApi } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function Linkedin() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }, { label: "LinkedIn scraper" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.linkedin, queryFn: () => campaignsApi.linkedin() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.linkedin });
  const sync = async () => { setSyncing(true); try { await campaignsApi.syncLinkedin(); refresh(); } catch (e) { alert(e instanceof Error ? e.message : "Failed"); } finally { setSyncing(false); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">LinkedIn scraper</h1>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>{syncing ? "Syncing…" : "Sync"}</Button>
          <Button size="sm" onClick={() => setOpen(true)}>Scrape profile</Button>
        </div>
      </div>
      <AgnbSubnav group="campaigns" />
      {open && (
        <AgnbFormModal
          title="Scrape LinkedIn profile"
          submitLabel="Scrape"
          fields={[{ key: "url", label: "Profile URL", required: true, placeholder: "https://www.linkedin.com/in/…" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await campaignsApi.scrapeLinkedin(v.url); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={LinkedinIcon} message="No scraped profiles." />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{data.length} profiles</p>
          <div className="flex flex-col gap-2">
            {data.map((p) => (
              <Card key={p.id}><CardContent className="flex items-center gap-3 p-3">
                {p.photo_url ? <img src={p.photo_url} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" /> : <div className="h-10 w-10 shrink-0 rounded-full bg-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-medium">{p.full_name ?? "—"}<a href={p.source_url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3 text-muted-foreground" /></a></div>
                  {p.headline && <div className="truncate text-xs text-muted-foreground">{p.headline}</div>}
                  <div className="truncate text-[11px] text-muted-foreground">{[p.current_title, p.current_company, p.location].filter(Boolean).join(" · ")}</div>
                </div>
              </CardContent></Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
