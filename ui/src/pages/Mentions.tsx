import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AtSign, ExternalLink, Link as LinkIcon } from "lucide-react";
import { mentionsApi } from "../api/agnbMentions";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

function sentTone(s: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (s === "positive") return "default";
  if (s === "negative" || s === "objection") return "destructive";
  return "outline";
}

export function Mentions() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Mentions" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.mentions, queryFn: () => mentionsApi.mentions() });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="mentions" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Mentions</h1>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={AtSign} message="No mentions." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((m) => (
            <div key={m.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{m.source}</Badge>
                {m.sentiment && <Badge variant={sentTone(m.sentiment)}>{m.sentiment}</Badge>}
                {m.has_link && <LinkIcon className="h-3 w-3 text-emerald-600" />}
                <a href={m.url} target="_blank" rel="noreferrer" className="ml-auto text-muted-foreground hover:text-foreground"><ExternalLink className="h-3 w-3" /></a>
              </div>
              {m.context && <p className="mt-1">{m.context}</p>}
              <div className="mt-1 text-[11px] text-muted-foreground">{m.author ?? "—"} · {relativeTime(m.noticed_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
