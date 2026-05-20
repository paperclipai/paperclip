export type EaosStateTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "live"
  | "preview";

const TONE_STYLES: Record<EaosStateTone, string> = {
  neutral:
    "border-slate-300 bg-white text-slate-700 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-200",
  info: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-200",
  success:
    "border-green-400 bg-green-50 text-green-800 dark:border-green-500 dark:bg-green-950 dark:text-green-200",
  warning:
    "border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-200",
  danger:
    "border-red-300 bg-red-50 text-red-800 dark:border-red-500 dark:bg-red-950 dark:text-red-200",
  live: "border-red-700 bg-red-700 text-white dark:border-red-400 dark:bg-red-600",
  preview:
    "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500 dark:bg-violet-950 dark:text-violet-200",
};

const TONE_BY_LABEL: Record<string, EaosStateTone> = {
  REAL: "neutral",
  "BACKEND-BACKED": "info",
  PREVIEW: "preview",
  DEMO: "neutral",
  "DESIGN-ONLY": "warning",
  "DRY-RUN": "info",
  "APPROVAL REQUIRED": "warning",
  LIVE: "live",
  APPLIED: "success",
  FAILED: "danger",
  "ROLLBACK NEEDED": "warning",
  PUBLISHED: "info",
  DRAFT: "preview",
  DEPRECATED: "neutral",
  ACTIVE: "info",
  QUEUED: "neutral",
  "IN REVIEW": "warning",
  BLOCKED: "danger",
  DONE: "success",
  CANCELLED: "neutral",
  BACKLOG: "neutral",
};

export interface EaosStateChipProps {
  label: string;
  prefix?: string;
  title?: string;
  className?: string;
  tone?: EaosStateTone;
}

export function EaosStateChip({ label, prefix, title, className, tone }: EaosStateChipProps) {
  const text = prefix ? `${prefix} · ${label}` : label;
  const resolvedTone: EaosStateTone = tone ?? TONE_BY_LABEL[label] ?? "neutral";
  const palette = TONE_STYLES[resolvedTone];
  return (
    <span
      data-testid={`eaos-state-chip-${label.toLowerCase().replace(/\s+/g, "-")}`}
      data-eaos-state={label}
      data-eaos-state-tone={resolvedTone}
      title={title ?? text}
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide " +
        palette +
        (className ? " " + className : "")
      }
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {text}
    </span>
  );
}
