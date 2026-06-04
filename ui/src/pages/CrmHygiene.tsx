import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ExternalLink } from "lucide-react";
import { agnbPagesApi, type HygieneIssue } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";

const ISSUE_LABELS: Record<string, string> = {
  stale: "Stale", missing_email: "Missing email", missing_phone: "Missing phone",
  missing_close_date: "Missing close date", missing_owner: "Missing owner",
  stuck_in_stage: "Stuck in stage", duplicate: "Duplicate",
};
function sevTone(s: string): "destructive" | "secondary" | "outline" {
  if (s === "fail") return "destructive";
  if (s === "warn") return "secondary";
  return "outline";
}

export function CrmHygiene() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "CRM hygiene" }]), [setBreadcrumbs]);
  const [sev, setSev] = useState<"all" | "fail" | "warn" | "info">("all");

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.crmHygiene,
    queryFn: () => agnbPagesApi.crmHygiene(),
  });

  const issues: HygieneIssue[] = (data ?? []).filter((i) => sev === "all" || i.severity === sev);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="pipeline" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">CRM hygiene</h1>
        <div className="flex items-center gap-1">
          {(["all", "fail", "warn", "info"] as const).map((s) => (
            <button key={s} onClick={() => setSev(s)}
              className={cn("rounded-md border px-2 py-0.5 text-xs capitalize",
                sev === s ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {s}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : issues.length === 0 ? (
        <EmptyState icon={ShieldAlert} message="No open issues." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Object</th><th className="p-2">Type</th><th className="p-2">Issue</th><th className="p-2">Details</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.id} className="border-b border-border/60">
                  <td className="p-2">{i.hubspot_object_name ?? i.hubspot_object_id}</td>
                  <td className="p-2 font-mono text-xs uppercase">{i.hubspot_object_type}</td>
                  <td className="p-2"><Badge variant={sevTone(i.severity)}>{ISSUE_LABELS[i.issue_type] ?? i.issue_type}</Badge></td>
                  <td className="p-2 text-xs text-muted-foreground">{i.details ?? "—"}</td>
                  <td className="p-2">
                    <a href={`https://app.hubspot.com/contacts/${i.hubspot_object_type}/${i.hubspot_object_id}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
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
