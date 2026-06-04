import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare } from "lucide-react";
import { inboxApi } from "../api/agnbInbox";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

function tone(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "finalized") return "default";
  if (s === "approved") return "secondary";
  if (s === "rejected") return "destructive";
  return "outline";
}

export function Approval() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Inbox" }, { label: "Approval queue" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.approvals, queryFn: () => inboxApi.approvals() });

  const pending = (data ?? []).filter((d) => d.status === "pending" || d.status === "draft" || d.status === "approved");
  const history = (data ?? []).filter((d) => d.status === "finalized" || d.status === "rejected");

  const Row = ({ d }: { d: NonNullable<typeof data>[number] }) => (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2"><span className="font-medium">{d.name}</span><Badge variant={tone(d.status)}>{d.status}</Badge></div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{[d.product_id, d.persona_id, d.created_by].filter(Boolean).join(" · ")} · {relativeTime(d.created_at)}</div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <AgnbSubnav group="inbox" />
      <h1 className="text-lg font-semibold">Approval queue</h1>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={CheckSquare} message="No drafts." />
      ) : (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Pending ({pending.length})</h2>
          <div className="flex flex-col gap-2">{pending.map((d) => <Row key={d.id} d={d} />)}</div>
          {history.length > 0 && <>
            <h2 className="text-sm font-medium text-muted-foreground">History</h2>
            <div className="flex flex-col gap-2">{history.map((d) => <Row key={d.id} d={d} />)}</div>
          </>}
        </>
      )}
    </div>
  );
}
