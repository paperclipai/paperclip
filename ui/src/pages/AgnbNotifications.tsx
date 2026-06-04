import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { opsApi } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { cn, relativeTime } from "../lib/utils";

const sevColor: Record<string, string> = { critical: "#dc2626", warn: "#d97706", info: "#1d4ed8" };

export function AgnbNotifications() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Notifications" }]), [setBreadcrumbs]);
  const [view, setView] = useState<"unread" | "all">("unread");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.notifications, queryFn: () => opsApi.notifications() });
  const readSet = useMemo(() => new Set(data?.readIds ?? []), [data]);

  const list = (data?.notifications ?? []).filter((n) => view === "all" || !readSet.has(n.id));

  return (
    <div className="space-y-4">
      <AgnbSubnav group="ops" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Notifications</h1>
        <div className="flex items-center gap-1">
          {(["unread", "all"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn("rounded-md border px-2 py-0.5 text-xs capitalize", view === v ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>{v}</button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : list.length === 0 ? (
        <EmptyState icon={Bell} message="No notifications." />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((n) => (
            <div key={n.id} className="rounded-md border border-border p-2.5 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><span className="inline-block size-2 shrink-0 rounded-full" style={{ background: sevColor[n.severity] ?? "#737373" }} /><span className="font-medium">{n.title}</span></div>
                {n.body && <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>}
                <div className="mt-0.5 text-[11px] text-muted-foreground">{n.kind} · {relativeTime(n.created_at)}{n.link ? <> · <a href={n.link} className="underline">link</a></> : null}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
