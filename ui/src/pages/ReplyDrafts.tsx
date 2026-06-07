import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mailbox, ExternalLink } from "lucide-react";
import { inboxApi } from "../api/agnbInbox";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

const FILTERS = ["all", "draft", "queued", "sent", "cancelled"];
function tone(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "sent") return "default";
  if (s === "queued") return "secondary";
  if (s === "cancelled") return "destructive";
  return "outline";
}

export function ReplyDrafts() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Inbox" }, { label: "Reply drafts" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [status, setStatus] = useState("all");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.replyDrafts(status), queryFn: () => inboxApi.replyDrafts(status) });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.replyDrafts(status) });
  const mark = async (id: string, s: string) => { await inboxApi.patchReplyDraft(id, s).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Reply drafts</h1>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setStatus(f)}
              className={cn("rounded-md border px-2 py-0.5 text-xs capitalize", status === f ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <AgnbSubnav group="inbox" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Mailbox} message="No drafts." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((d) => (
            <div key={d.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{d.subject ?? "(no subject)"}</span>
                <Badge variant={tone(d.status)}>{d.status}</Badge>
              </div>
              <div className="text-[11px] text-muted-foreground">to: {d.lead_name ?? ""} {d.lead_email}</div>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap font-mono text-xs text-muted-foreground">{d.body}</p>
              {d.status === "draft" && (
                <div className="mt-2 flex gap-2">
                  {d.mailto_url && <a href={d.mailto_url} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"><ExternalLink className="h-3 w-3" /> Open mailto</a>}
                  <Button size="sm" onClick={() => mark(d.id, "sent")}>Mark sent</Button>
                  <Button size="sm" variant="outline" onClick={() => mark(d.id, "cancelled")}>Cancel</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
