import type { IssueLabel } from "@paperclipai/shared";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { cn } from "../lib/utils";

function prioritizeLabels(labels: IssueLabel[], preferredFirstName?: string | null) {
  if (!preferredFirstName) return labels;
  const preferred = preferredFirstName.trim().toLowerCase();
  if (!preferred) return labels;
  return [...labels].sort((left, right) => {
    const leftPreferred = left.name.trim().toLowerCase() === preferred ? 0 : 1;
    const rightPreferred = right.name.trim().toLowerCase() === preferred ? 0 : 1;
    if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
    return left.name.localeCompare(right.name);
  });
}

export function LabelPills({
  labels,
  maxVisible = 3,
  preferredFirstName,
  className,
  overflowClassName,
  pillClassName,
}: {
  labels?: IssueLabel[] | null;
  maxVisible?: number;
  preferredFirstName?: string | null;
  className?: string;
  overflowClassName?: string;
  pillClassName?: string;
}) {
  const ordered = prioritizeLabels(labels ?? [], preferredFirstName);
  if (ordered.length === 0) return null;

  const visible = ordered.slice(0, Math.max(0, maxVisible));
  const hiddenCount = Math.max(0, ordered.length - visible.length);

  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {visible.map((label) => (
        <span
          key={label.id}
          className={cn(
            "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
            pillClassName,
          )}
          style={{
            borderColor: label.color,
            backgroundColor: `${label.color}22`,
            color: pickTextColorForPillBg(label.color, 0.13),
          }}
          title={label.name}
        >
          {label.name}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span className={cn("shrink-0 text-[11px] text-muted-foreground", overflowClassName)}>
          +{hiddenCount}
        </span>
      ) : null}
    </span>
  );
}
