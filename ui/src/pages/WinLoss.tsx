import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, X } from "lucide-react";
import { agnbPagesApi, type Interview } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { cn, formatShortDate } from "../lib/utils";

function tone(o: string): "default" | "destructive" | "secondary" | "outline" {
  if (o === "won") return "default";
  if (o === "lost") return "destructive";
  if (o === "churned") return "secondary";
  return "outline";
}
const OUTCOMES = ["all", "won", "lost", "churned", "no-decision"] as const;

export function WinLoss() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Win/loss" }]), [setBreadcrumbs]);
  const [outcome, setOutcome] = useState<string>("all");
  const [viewing, setViewing] = useState<Interview | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.winLoss(outcome),
    queryFn: () => agnbPagesApi.winLoss(outcome),
  });

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Win/loss</h1>
        <div className="flex flex-wrap items-center gap-1">
          {OUTCOMES.map((o) => (
            <button key={o} onClick={() => setOutcome(o)}
              className={cn("rounded-md border px-2 py-0.5 text-xs capitalize",
                outcome === o ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {o}
            </button>
          ))}
        </div>
      </div>
      {viewing && <ViewModal interview={viewing} onClose={() => setViewing(null)} />}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={ClipboardList} message="No interviews." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Customer</th><th className="p-2">Outcome</th><th className="p-2">Date</th><th className="p-2">Top reasons</th><th className="p-2">Status</th></tr>
            </thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className="cursor-pointer border-b border-border/60 hover:bg-accent/30" onClick={() => setViewing(i)}>
                  <td className="p-2">
                    {i.customer_name}
                    {i.contact_name && <span className="block text-xs text-muted-foreground">{i.contact_name}{i.contact_title ? ` · ${i.contact_title}` : ""}</span>}
                  </td>
                  <td className="p-2"><Badge variant={tone(i.outcome)}>{i.outcome}</Badge></td>
                  <td className="p-2 font-mono text-xs">{i.interview_date ? formatShortDate(i.interview_date) : "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground">{(i.top_reasons ?? []).slice(0, 2).join(" · ") || "—"}</td>
                  <td className="p-2 font-mono text-xs">{i.analysis_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ViewModal({ interview, onClose }: { interview: Interview; onClose: () => void }) {
  const lists: Array<[string, string[] | null | undefined]> = [
    ["Top reasons", interview.top_reasons],
    ["Decision makers", interview.decision_makers],
    ["Competitors", interview.competitors_considered],
    ["Feature requests", interview.feature_requests],
    ["Tags", interview.tags],
  ];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">{interview.customer_name}</h3><button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button></div>
        {interview.summary && <p className="text-sm">{interview.summary}</p>}
        {interview.raw_quote && <p className="mt-2 border-l-2 border-border pl-2 text-sm italic text-muted-foreground">"{interview.raw_quote}"</p>}
        <div className="mt-3 space-y-2">
          {lists.filter(([, v]) => v && v.length).map(([label, v]) => (
            <div key={label}>
              <div className="text-xs font-medium text-muted-foreground">{label}</div>
              <div className="text-sm">{v!.join(" · ")}</div>
            </div>
          ))}
        </div>
        {interview.raw_transcript && (
          <details className="mt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Transcript</summary><pre className="mt-1 whitespace-pre-wrap text-xs">{interview.raw_transcript}</pre></details>
        )}
      </div>
    </div>
  );
}
