import { useEffect, useState } from "react";
import { Pill, Check, X, RotateCcw, ChevronLeft, ChevronRight } from "lucide-react";
import { useSupplementsIntake, useTakeSupplement, useSkipSupplement, useUndoSupplement, formatIntakeDate, type SupplementIntake } from "../hooks/useSupplements";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

function offsetDate(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function isToday(date: Date): boolean {
  return formatIntakeDate(date) === formatIntakeDate(new Date());
}

interface IntakeRowProps {
  intake: SupplementIntake;
  date: string;
}

function IntakeRow({ intake, date }: IntakeRowProps) {
  const takeMutation = useTakeSupplement(date);
  const skipMutation = useSkipSupplement(date);
  const undoMutation = useUndoSupplement(date);
  const isBusy = takeMutation.isPending || skipMutation.isPending || undoMutation.isPending;

  const taken = !!intake.takenAt;
  const skipped = !!intake.skippedAt;

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0",
        taken && "bg-green-50/50 dark:bg-green-950/20",
        skipped && "bg-muted/40",
      )}
    >
      <div className="flex-1 min-w-0">
        <p className={cn("text-sm font-medium truncate", skipped && "text-muted-foreground line-through")}>
          {intake.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {intake.dose} {intake.unit}
          {intake.scheduledAt && (
            <span className="ml-2">
              {new Date(intake.scheduledAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </p>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {taken || skipped ? (
          <>
            <span className={cn(
              "text-xs font-medium px-2 py-0.5 rounded-full",
              taken ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400" : "bg-muted text-muted-foreground",
            )}>
              {taken ? "Taken" : "Skipped"}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={isBusy}
              onClick={() => undoMutation.mutate(intake.supplementId)}
              title="Undo"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => takeMutation.mutate(intake.supplementId)}
              className="h-7 px-2.5 text-xs gap-1"
            >
              <Check className="h-3 w-3" />
              Take
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={() => skipMutation.mutate(intake.supplementId)}
              className="h-7 px-2.5 text-xs gap-1 text-muted-foreground"
            >
              <X className="h-3 w-3" />
              Skip
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function Supplements() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [currentDate, setCurrentDate] = useState(() => new Date());

  useEffect(() => {
    setBreadcrumbs([{ label: "Supplements" }]);
  }, [setBreadcrumbs]);

  const dateStr = formatIntakeDate(currentDate);
  const { data, isLoading, error } = useSupplementsIntake(dateStr);

  if (!selectedCompanyId) {
    return <EmptyState icon={Pill} message="Select a company to view supplements." />;
  }

  const taken = data?.intakes.filter((i) => i.takenAt).length ?? 0;
  const total = data?.intakes.length ?? 0;

  return (
    <div className="space-y-4">
      {/* Date nav */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCurrentDate((d) => offsetDate(d, -1))}
          title="Previous day"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 text-center">
          <p className="text-sm font-medium">
            {isToday(currentDate) ? "Today" : formatDisplayDate(currentDate)}
          </p>
          {!isToday(currentDate) && (
            <p className="text-xs text-muted-foreground">{dateStr}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={isToday(currentDate)}
          onClick={() => setCurrentDate((d) => offsetDate(d, 1))}
          title="Next day"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {isLoading && <PageSkeleton variant="list" />}

      {error && (
        <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load supplements"}</p>
      )}

      {!isLoading && !error && data && (
        <>
          {data.intakes.length === 0 ? (
            <EmptyState
              icon={Pill}
              message="No supplements scheduled for this day."
            />
          ) : (
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              {/* Progress header */}
              <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  {dateStr === formatIntakeDate(new Date()) ? "Today's schedule" : "Schedule"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {taken} / {total} taken
                </p>
              </div>

              {/* Supplement rows */}
              {data.intakes.map((intake) => (
                <IntakeRow key={intake.supplementId} intake={intake} date={dateStr} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
