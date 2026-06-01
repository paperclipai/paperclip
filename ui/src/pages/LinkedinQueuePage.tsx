import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListOrdered, ExternalLink, Check, Trash2 } from "lucide-react";
import { linkedinQueueApi } from "../api/agnbLinkedinQueue";
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
  if (s === "posted" || s === "published") return "default";
  if (s === "scheduled" || s === "queued" || s === "ready-to-post-manual") return "secondary";
  if (s === "failed") return "destructive";
  return "outline";
}

export function LinkedinQueuePage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "LinkedIn" }, { label: "Queue" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.liQueue, queryFn: () => linkedinQueueApi.queue() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.liQueue });
  const markPosted = async (id: string) => { await linkedinQueueApi.patchPost(id, { status: "posted" }).catch(() => {}); refresh(); };
  const del = async (id: string) => { await linkedinQueueApi.deletePost(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="linkedinQueue" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Queue</h1>
        <Button size="sm" onClick={() => setOpen(true)}>New post</Button>
      </div>
      {open && (
        <AgnbFormModal
          title="New LinkedIn post"
          fields={[{ key: "content", label: "Content", required: true, type: "textarea" }, { key: "scheduled_at", label: "Schedule at (ISO, optional)" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await linkedinQueueApi.addPost({ content: v.content, scheduled_at: v.scheduled_at ? new Date(v.scheduled_at).toISOString() : undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={ListOrdered} message="Queue empty." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant={tone(r.status)}>{r.status}</Badge>
                {r.source_type && <span className="text-[11px] text-muted-foreground">{r.source_type}</span>}
                <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                  {r.linkedin_post_url && <a href={r.linkedin_post_url} target="_blank" rel="noreferrer" className="hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /></a>}
                  {r.status !== "posted" && r.status !== "published" && <button title="Mark posted" onClick={() => markPosted(r.id)}><Check className="h-3.5 w-3.5 hover:text-emerald-600" /></button>}
                  <button title="Delete" onClick={() => del(r.id)}><Trash2 className="h-3.5 w-3.5 hover:text-destructive" /></button>
                </span>
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap">{r.content}</p>
              <div className="mt-1 text-[11px] text-muted-foreground">{r.scheduled_at ? `sched ${relativeTime(r.scheduled_at)}` : r.posted_at ? `posted ${relativeTime(r.posted_at)}` : "—"}{r.error_message ? ` · ${r.error_message}` : ""}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
