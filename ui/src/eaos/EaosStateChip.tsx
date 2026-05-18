import type { EaosStateLabel } from "./state-labels";

const CHIP_STYLES: Record<EaosStateLabel, string> = {
  REAL: "border-slate-400 bg-white text-slate-700 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-200",
  "BACKEND-BACKED":
    "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950 dark:text-blue-200",
  PREVIEW:
    "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500 dark:bg-violet-950 dark:text-violet-200",
  DEMO: "border-dashed border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-500 dark:bg-zinc-900 dark:text-zinc-200",
  "DESIGN-ONLY":
    "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-500 dark:bg-orange-950 dark:text-orange-200",
  "DRY-RUN":
    "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500 dark:bg-sky-950 dark:text-sky-200",
  "APPROVAL REQUIRED":
    "border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-200",
  LIVE: "border-red-700 bg-red-700 text-white dark:border-red-400 dark:bg-red-600",
  APPLIED:
    "border-green-400 bg-green-50 text-green-800 dark:border-green-500 dark:bg-green-950 dark:text-green-200",
  FAILED:
    "border-red-300 bg-red-50 text-red-800 dark:border-red-500 dark:bg-red-950 dark:text-red-200",
  "ROLLBACK NEEDED":
    "border-orange-400 bg-orange-50 text-orange-900 dark:border-orange-500 dark:bg-orange-950 dark:text-orange-200",
};

export interface EaosStateChipProps {
  label: EaosStateLabel;
  prefix?: string;
  title?: string;
  className?: string;
}

export function EaosStateChip({ label, prefix, title, className }: EaosStateChipProps) {
  const text = prefix ? `${prefix} · ${label}` : label;
  const palette = CHIP_STYLES[label];
  return (
    <span
      data-testid={`eaos-state-chip-${label.toLowerCase().replace(/\s+/g, "-")}`}
      data-eaos-state={label}
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
