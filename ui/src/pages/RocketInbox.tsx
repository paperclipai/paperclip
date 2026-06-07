import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Archive, Star } from "lucide-react";
import { inboxApi } from "../api/agnbInbox";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { cn, relativeTime } from "../lib/utils";

const FILTERS = ["all", "engaged", "neutral", "negative"];
function tone(s: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (s === "engaged") return "default";
  if (s === "negative") return "destructive";
  return "outline";
}

export function RocketInbox() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Inbox" }, { label: "Threads" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [status, setStatus] = useState("all");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.inboxThreads(status), queryFn: () => inboxApi.threads(status) });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.inboxThreads(status) });
  const archive = async (id: string) => { await inboxApi.threadAction(id, "archive").catch(() => {}); refresh(); };
  const positive = async (id: string) => { await inboxApi.threadAction(id, "mark_positive").catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Inbox threads</h1>
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
        <EmptyState icon={Mail} message="Inbox empty." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((t) => (
            <div key={t.thread_id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">{t.subject ?? "(no subject)"}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  {t.status && <Badge variant={tone(t.status)}>{t.status}</Badge>
                  }
                  <button title="Mark positive" onClick={() => positive(t.thread_id)}><Star className="h-3.5 w-3.5 hover:text-amber-500" /></button>
                  <button title="Archive" onClick={() => archive(t.thread_id)}><Archive className="h-3.5 w-3.5 hover:text-foreground" /></button>
                </span>
              </div>
              {t.last_message_preview && <p className="mt-1 line-clamp-2 text-muted-foreground">{t.last_message_preview}</p>}
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">{[t.lead_name, t.lead_email, t.campaign_name].filter(Boolean).join(" · ")}{t.last_message_at ? ` · ${relativeTime(t.last_message_at)}` : ""}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
