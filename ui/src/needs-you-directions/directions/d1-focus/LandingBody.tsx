import { ChevronRight, ListFilter, Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SurfaceData } from "../../kit";
import { FocusCard } from "./FocusCard";

export function LandingBody({ records, receipts, counts }: SurfaceData["landing"]) {
  const live = records.filter((record) => !record.stale);
  const stale = records.filter((record) => record.stale);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-bold text-foreground">Needs you</h1>
          <span className="text-sm text-muted-foreground">{counts.mine} to decide</span>
        </div>
        <div className="flex items-center gap-1.5">
          {counts.unassigned > 0 ? (
            <Button type="button" variant="ghost" size="xs">
              Unassigned<Badge variant="secondary">{counts.unassigned}</Badge>
            </Button>
          ) : null}
          {counts.company > 0 ? (
            <Button type="button" variant="ghost" size="xs">
              Company<Badge variant="secondary">{counts.company}</Badge>
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="xs">
            View ▾
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Filter and search">
            <ListFilter className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <button type="button" className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted">
        <Mail className="h-4 w-4 shrink-0" />
        <span className="font-medium text-foreground">{receipts.length} updates</span>
        on your requests
        <ChevronRight className="ml-auto h-4 w-4" />
      </button>

      <div className="flex flex-col gap-3">
        {live.map((record, index) => (
          <FocusCard key={record.id} record={record} featured={index === 0} />
        ))}
      </div>

      {stale.length > 0 ? (
        <button type="button" className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50">
          <ChevronRight className="h-4 w-4 shrink-0" />
          <span className="font-medium text-foreground">Stale ({stale.length})</span>
          <span className="ml-auto underline underline-offset-2">Withdraw all stale</span>
        </button>
      ) : null}
    </div>
  );
}
