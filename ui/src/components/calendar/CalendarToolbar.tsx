import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarEventKind } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CALENDAR_VIEW_MODES, type CalendarViewMode } from "@/lib/calendar-grid";
import { CALENDAR_KIND_META } from "./calendar-visuals";

const VIEW_LABELS: Record<CalendarViewMode, string> = {
  month: "Month",
  week: "Week",
  day: "Day",
  agenda: "Agenda",
};

/** The key that switches to each view, mirroring Google Calendar's bindings. */
const VIEW_SHORTCUTS: Record<CalendarViewMode, string> = {
  month: "M",
  week: "W",
  day: "D",
  agenda: "A",
};

interface CalendarToolbarProps {
  title: string;
  mode: CalendarViewMode;
  activeKinds: CalendarEventKind[];
  onModeChange: (mode: CalendarViewMode) => void;
  onNavigate: (direction: 1 | -1) => void;
  onToday: () => void;
  onToggleKind: (kind: CalendarEventKind) => void;
}

export function CalendarToolbar({
  title,
  mode,
  activeKinds,
  onModeChange,
  onNavigate,
  onToday,
  onToggleKind,
}: CalendarToolbarProps) {
  return (
    <div className="flex flex-col gap-3">
      <div
        role="toolbar"
        aria-label="Calendar controls"
        className="flex flex-wrap items-center gap-2"
      >
        <Button variant="outline" size="sm" onClick={onToday}>
          Today
        </Button>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous period"
            onClick={() => onNavigate(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next period"
            onClick={() => onNavigate(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <h2 className="text-sm font-medium text-foreground" aria-live="polite">
          {title}
        </h2>
        <div className="ml-auto flex items-center border border-border">
          {CALENDAR_VIEW_MODES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={mode === candidate}
              title={`${VIEW_LABELS[candidate]} (${VIEW_SHORTCUTS[candidate]})`}
              onClick={() => onModeChange(candidate)}
              className={cn(
                "px-2.5 py-1 text-xs transition-colors",
                mode === candidate
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {VIEW_LABELS[candidate]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" aria-label="Filter by entry type">
        {(Object.keys(CALENDAR_KIND_META) as CalendarEventKind[]).map((kind) => {
          const meta = CALENDAR_KIND_META[kind];
          const Icon = meta.icon;
          const active = activeKinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={active}
              title={meta.description}
              onClick={() => onToggleKind(kind)}
              className={cn(
                "flex items-center gap-1.5 border px-2 py-0.5 text-[11px] transition-colors",
                active
                  ? "border-border bg-accent/60 text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-2 w-2 shrink-0",
                  !active
                    ? "border border-border"
                    : meta.projected
                      ? "border border-dashed"
                      : "status-fill",
                )}
                style={
                  active
                    ? ({
                        "--sc": meta.hue,
                        ...(meta.projected ? { borderColor: meta.hue } : {}),
                      } as React.CSSProperties)
                    : undefined
                }
              />
              <Icon className="h-3 w-3" aria-hidden="true" />
              {meta.shortLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}
