import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { inboxApi } from "../api/agnbInbox";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

export function ReplyMining() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Inbox" }, { label: "Reply mining" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.replies, queryFn: () => inboxApi.replies() });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Reply mining</h1>
      <AgnbSubnav group="inbox" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={MessageCircle} message="No replies logged." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{r.from_name ?? r.from_email}</span>
                <Badge variant="outline">{r.intent}</Badge>
              </div>
              {r.subject && <div className="text-xs text-muted-foreground">re: {r.subject}</div>}
              <p className="mt-1 line-clamp-3 text-muted-foreground">{r.body}</p>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                {r.objection_cluster && <span className="rounded bg-muted px-1">{r.objection_cluster}</span>}
                {r.next_action && <span>→ {r.next_action}</span>}
                <span className="ml-auto">{relativeTime(r.received_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
