import { Badge } from "@/components/ui/badge";

export function ReleaseResponsibilityCard({
  approvalSummary,
  compact = false,
}: {
  approvalSummary?: string | null;
  compact?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-accent/10 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-[10px] uppercase tracking-[0.18em]">
          Release Line
        </Badge>
        <span className="text-xs text-muted-foreground">
          Final release responsibilities are split by decision, gate, verify, and execution.
        </span>
      </div>

      <div className={compact ? "grid gap-2 md:grid-cols-2" : "grid gap-2"}>
        <div className="rounded-md border border-border bg-background/70 px-3 py-2">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Final editorial sign-off</div>
          <div className="text-sm font-medium">Editor-in-Chief</div>
        </div>
        <div className="rounded-md border border-border bg-background/70 px-3 py-2">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Hard gate owner</div>
          <div className="text-sm font-medium">Validation Engineer</div>
        </div>
        <div className="rounded-md border border-border bg-background/70 px-3 py-2">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Public verify owner</div>
          <div className="text-sm font-medium">Verifier</div>
        </div>
        <div className="rounded-md border border-border bg-background/70 px-3 py-2">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Publish executor</div>
          <div className="text-sm font-medium">Publisher</div>
        </div>
      </div>

      {approvalSummary ? (
        <div className="text-xs text-muted-foreground">
          Current approval state: {approvalSummary}
        </div>
      ) : null}
    </div>
  );
}
