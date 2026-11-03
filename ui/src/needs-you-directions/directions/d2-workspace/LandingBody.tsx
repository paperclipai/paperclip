import { useState } from "react";
import { History, ListFilter } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SurfaceData } from "../../kit";
import { RailRow, WorkspaceDetail } from "./WorkspaceParts";

const SCOPES = ["For you", "Unassigned", "Company", "Everyone"] as const;

export function LandingBody({ records, counts }: SurfaceData["landing"]) {
  const live = records.filter((record) => !record.stale);
  const stale = records.filter((record) => record.stale);
  const [selectedId, setSelectedId] = useState(live[0]?.id ?? records[0]?.id);
  const selected = records.find((record) => record.id === selectedId) ?? records[0];
  const countFor = (scope: (typeof SCOPES)[number]) =>
    scope === "For you" ? counts.mine : scope === "Unassigned" ? counts.unassigned : scope === "Company" ? counts.company : counts.all;

  return (
    <div className="flex min-h-150 w-full overflow-hidden rounded-xl border border-border bg-card">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-sm font-bold text-foreground">Needs you</h1>
            <span className="text-xs text-muted-foreground">{counts.mine}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Filter and search">
              <ListFilter className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="History">
              <History className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
          {SCOPES.map((scope, index) => (
            <button
              key={scope}
              type="button"
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                index === 0 ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {scope}
              {countFor(scope) > 0 ? <span className="tabular-nums opacity-70">{countFor(scope)}</span> : null}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden px-2 pb-3">
          {live.map((record) => (
            <RailRow key={record.id} record={record} selected={record.id === selected?.id} onSelect={() => setSelectedId(record.id)} />
          ))}
          {stale.length > 0 ? (
            <div className="mt-2 border-t border-border pt-2">
              <p className="px-2.5 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">Stale ({stale.length})</p>
              {stale.map((record) => (
                <RailRow key={record.id} record={record} selected={record.id === selected?.id} onSelect={() => setSelectedId(record.id)} />
              ))}
            </div>
          ) : null}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? <WorkspaceDetail record={selected} featured /> : null}
      </section>
    </div>
  );
}
