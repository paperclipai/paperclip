import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, Check } from "lucide-react";
import { miscApi } from "../api/agnbMisc";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, relativeTime } from "../lib/utils";

const FILTERS = ["all", "unanswered", "questions", "negative"];

export function CommentTriage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Comments" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.comments(filter), queryFn: () => miscApi.comments(filter === "all" ? undefined : filter) });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.comments(filter) });
  const replied = async (id: string) => { await miscApi.markReplied(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Comment triage</h1>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => <button key={f} onClick={() => setFilter(f)} className={cn("rounded-md border px-2 py-0.5 text-xs capitalize", filter === f ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>{f}</button>)}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={MessagesSquare} message="No comments." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((c) => (
            <div key={c.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{c.platform}</Badge>
                {c.sentiment && <Badge variant={c.sentiment === "negative" ? "destructive" : "secondary"}>{c.sentiment}</Badge>}
                {c.is_question && <Badge variant="outline">question</Badge>}
                <span className="text-xs text-muted-foreground">{c.author ?? ""}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">{relativeTime(c.ingested_at)}</span>
              </div>
              <p className="mt-1">{c.body}</p>
              {c.reply_draft && <div className="mt-1 rounded-md bg-muted/40 p-2 text-xs"><span className="text-muted-foreground">AI draft:</span> {c.reply_draft}</div>}
              <div className="mt-2 flex gap-2">
                {!c.replied ? <Button size="sm" onClick={() => replied(c.id)}><Check className="mr-1 h-3.5 w-3.5" />Mark replied</Button> : <span className="text-xs text-emerald-600">✓ replied</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
