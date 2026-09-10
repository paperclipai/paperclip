import { OPERATOR_DECISION_VIEWS, type OperatorDecisionView } from "../../lib/operator-dashboard";
import { cn } from "../../lib/utils";

/**
 * Decision view tabs for the operator queue (All / Your decision /
 * System fixing / Needs operator setup). The active view's rule renders
 * underneath so the filter's semantics are always visible — a filter whose
 * rule is printed on screen cannot silently hide a business gate.
 */
export function OperatorDecisionViewTabs({
  value,
  counts,
  onChange,
}: {
  value: OperatorDecisionView;
  counts: Record<OperatorDecisionView, number>;
  onChange: (next: OperatorDecisionView) => void;
}) {
  const active = OPERATOR_DECISION_VIEWS.find((view) => view.id === value) ?? OPERATOR_DECISION_VIEWS[0]!;
  return (
    <div className="space-y-1.5">
      <div
        role="group"
        aria-label="Decision views"
        className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
      >
        {OPERATOR_DECISION_VIEWS.map((view) => {
          const selected = view.id === value;
          return (
            <button
              key={view.id}
              type="button"
              aria-pressed={selected}
              title={view.rule}
              onClick={() => onChange(view.id)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                "focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none",
                selected
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {view.label}
              <span
                className={cn(
                  "rounded-full px-1.5 text-(length:--text-nano) tabular-nums",
                  selected ? "bg-muted text-foreground" : "bg-muted/60 text-muted-foreground",
                )}
              >
                {counts[view.id]}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground" role="note">
        {active.rule}
      </p>
    </div>
  );
}
