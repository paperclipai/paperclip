import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { agnbPagesApi, type DemoRow } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "../lib/utils";

function tone(s: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (s === "ACCEPTED" || s === "COMPLETED") return "default";
  if (s === "PENDING") return "secondary";
  if (s === "CANCELLED" || s === "REJECTED" || s === "NO_SHOW") return "destructive";
  return "outline";
}

function Table({ rows }: { rows: DemoRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="p-2">When</th>
            <th className="p-2">Event</th>
            <th className="p-2">Attendee</th>
            <th className="p-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border/60">
              <td className="p-2 font-mono text-xs">{r.start_at ? formatDateTime(r.start_at) : "—"}</td>
              <td className="p-2">{r.title ?? r.event_type_slug ?? "—"}</td>
              <td className="p-2">
                {r.attendee_name ?? "—"}
                {r.attendee_email && <span className="block text-xs text-muted-foreground">{r.attendee_email}</span>}
              </td>
              <td className="p-2"><Badge variant={tone(r.status)}>{r.status ?? "—"}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Demos() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Pipeline" }, { label: "Demos" }]), [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.demos,
    queryFn: () => agnbPagesApi.demos(),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Demos</h1>
      <AgnbSubnav group="pipeline" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || (data.upcoming.length === 0 && data.past.length === 0) ? (
        <EmptyState icon={CalendarClock} message="No bookings." />
      ) : (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Upcoming ({data.upcoming.length})</h2>
          {data.upcoming.length > 0 ? <Table rows={data.upcoming} /> : <p className="text-xs text-muted-foreground">none</p>}
          <h2 className="text-sm font-medium text-muted-foreground">Past 30 ({data.past.length})</h2>
          {data.past.length > 0 ? <Table rows={data.past} /> : <p className="text-xs text-muted-foreground">none</p>}
        </>
      )}
    </div>
  );
}
