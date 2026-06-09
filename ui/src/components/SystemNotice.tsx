import { useId, useState, type ReactNode } from "react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Info,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type SystemNoticeTone = "neutral" | "info" | "success" | "warning" | "danger";

export type SystemNoticeMetadataRow =
  | { kind: "text"; label: string; value: string }
  | { kind: "code"; label: string; value: string }
  | { kind: "issue"; label: string; identifier: string; href?: string; title?: string }
  | { kind: "agent"; label: string; name: string; href?: string }
  | { kind: "run"; label: string; runId: string; href?: string; status?: string };

export type SystemNoticeMetadataSection = {
  title?: string;
  rows: SystemNoticeMetadataRow[];
};

export type SystemNoticeProps = {
  tone?: SystemNoticeTone;
  /** Short label that names the system actor + tone, e.g. "System warning". Required so tone is not color-only. */
  label?: string;
  /** Short visible body — one or two sentences from the system perspective. */
  body: ReactNode;
  /** Optional small chip for the originating run link. */
  source?: { label: string; href?: string };
  /** Hidden-by-default metadata. Renders the Details affordance only when present. */
  metadata?: SystemNoticeMetadataSection[];
  /** Force the details panel open initially. Defaults to false (collapsed). */
  detailsDefaultOpen?: boolean;
  /** Optional ISO timestamp shown next to the label. */
  timestamp?: string;
  className?: string;
};

type ToneTokens = {
  container: string;
  iconWrap: string;
  icon: LucideIcon;
  iconClass: string;
  label: string;
  divider: string;
};

const TONE_TOKENS: Record<SystemNoticeTone, ToneTokens> = {
  neutral: {
    container:
      "border-border bg-muted/35 dark:bg-muted/20",
    iconWrap: "bg-muted text-foreground/70",
    icon: Info,
    iconClass: "text-muted-foreground",
    label: "text-muted-foreground",
    divider: "border-border/70",
  },
  info: {
    container:
      "border-sky-300/70 bg-sky-50/70 dark:border-sky-500/30 dark:bg-sky-500/10",
    iconWrap: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200",
    icon: Info,
    iconClass: "text-sky-700 dark:text-sky-300",
    label: "text-sky-800 dark:text-sky-200",
    divider: "border-sky-300/50 dark:border-sky-500/30",
  },
  success: {
    container:
      "border-emerald-300/70 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10",
    iconWrap: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200",
    icon: CircleCheck,
    iconClass: "text-emerald-700 dark:text-emerald-300",
    label: "text-emerald-800 dark:text-emerald-200",
    divider: "border-emerald-300/50 dark:border-emerald-500/30",
  },
  warning: {
    container:
      "border-amber-300/70 bg-amber-50/80 dark:border-amber-500/30 dark:bg-amber-500/10",
    iconWrap: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
    icon: TriangleAlert,
    iconClass: "text-amber-700 dark:text-amber-300",
    label: "text-amber-900 dark:text-amber-200",
    divider: "border-amber-300/60 dark:border-amber-500/30",
  },
  danger: {
    container:
      "border-red-400/60 bg-red-50/80 dark:border-red-500/35 dark:bg-red-500/10",
    iconWrap: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-200",
    icon: OctagonAlert,
    iconClass: "text-red-700 dark:text-red-300",
    label: "text-red-900 dark:text-red-200",
    divider: "border-red-400/50 dark:border-red-500/30",
  },
};

function formatTimestamp(ts: string) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function MetadataRow({ row, tone }: { row: SystemNoticeMetadataRow; tone: ToneTokens }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs">
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {row.label}
      </div>
      <div className="min-w-0 break-words text-foreground/90">
        {(() => {
          switch (row.kind) {
            case "text":
              return <span>{row.value}</span>;
            case "code":
              return (
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                  {row.value}
                </code>
              );
            case "issue": {
              const issueLabel = (
                <>
                  <span>{row.identifier}</span>
                  {row.title ? (
                    <span className="text-muted-foreground">— {row.title}</span>
                  ) : null}
                </>
              );
              if (row.href) {
                return (
                  <a
                    href={row.href}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm font-medium underline-offset-2 hover:underline",
                      tone.label,
                    )}
                  >
                    {issueLabel}
                  </a>
                );
              }
              return (
                <span className={cn("inline-flex items-center gap-1 font-medium", tone.label)}>
                  {issueLabel}
                </span>
              );
            }
            case "agent":
              if (row.href) {
                return (
                  <a
                    href={row.href}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm font-medium underline-offset-2 hover:underline",
                      tone.label,
                    )}
                  >
                    {row.name}
                  </a>
                );
              }
              return (
                <span className={cn("font-medium", tone.label)}>{row.name}</span>
              );
            case "run": {
              const runShort = row.runId.length > 12 ? `${row.runId.slice(0, 8)}…` : row.runId;
              const inner = (
                <>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-foreground/80">{runShort}</code>
                  {row.status ? (
                    <span className={cn("font-sans", tone.label)}>{row.status}</span>
                  ) : null}
                </>
              );
              if (row.href) {
                return (
                  <a
                    href={row.href}
                    className="inline-flex items-center gap-2 rounded-sm font-mono text-[11px] underline-offset-2 hover:underline"
                  >
                    {inner}
                  </a>
                );
              }
              return (
                <span className="inline-flex items-center gap-2 font-mono text-[11px]">
                  {inner}
                </span>
              );
            }
          }
        })()}
      </div>
    </div>
  );
}

export function SystemNotice({
  tone = "neutral",
  label,
  body,
  source,
  metadata,
  detailsDefaultOpen = false,
  timestamp,
  className,
}: SystemNoticeProps) {
  const tokens = TONE_TOKENS[tone];
  const ToneIcon = tokens.icon;
  const [open, setOpen] = useState(detailsDefaultOpen);
  const detailsId = useId();
  const hasDetails = Boolean(metadata && metadata.length > 0);
  const resolvedLabel =
    label ??
    {
      neutral: "System notice",
      info: "System notice",
      success: "System notice",
      warning: "System warning",
      danger: "System alert",
    }[tone];

  return (
    <section
      role="status"
      aria-label={resolvedLabel}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border text-sm shadow-[0_1px_0_rgba(15,23,42,0.02)]",
        tokens.container,
        className,
      )}
    >
      <header className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            tokens.iconWrap,
          )}
          aria-hidden
        >
          <ToneIcon className={cn("h-4 w-4", tokens.iconClass)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-semibold uppercase tracking-[0.14em]">
            <span className={tokens.label}>{resolvedLabel}</span>
            {source ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                {source.href ? (
                  <a
                    href={source.href}
                    className="rounded-sm font-medium normal-case tracking-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {source.label}
                  </a>
                ) : (
                  <span className="font-medium normal-case tracking-normal text-muted-foreground">
                    {source.label}
                  </span>
                )}
              </>
            ) : null}
            {timestamp ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>·</span>
                <span className="font-medium normal-case tracking-normal text-muted-foreground">
                  {formatTimestamp(timestamp)}
                </span>
              </>
            ) : null}
          </div>
          <div className="mt-1 break-words text-[14px] leading-6 text-foreground">{body}</div>
        </div>
        {hasDetails ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
            className={cn(
              "ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent px-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-[background-color,border-color,color]",
              "hover:border-border/70 hover:bg-background/70 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            )}
          >
            <span>{open ? "Hide details" : "Details"}</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-150",
                open && "rotate-180",
              )}
            />
          </button>
        ) : null}
      </header>
      {hasDetails && open ? (
        <div
          id={detailsId}
          className={cn(
            "border-t bg-background/50 dark:bg-background/30",
            tokens.divider,
          )}
        >
          <div className="divide-y divide-border/50 px-1 py-1">
            {metadata!.map((section, sectionIdx) => (
              <div key={sectionIdx} className="py-1.5 first:pt-2 last:pb-2">
                {section.title ? (
                  <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {section.title}
                  </div>
                ) : null}
                <div>
                  {section.rows.map((row, rowIdx) => (
                    <MetadataRow key={rowIdx} row={row} tone={tokens} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default SystemNotice;
