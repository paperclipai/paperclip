import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function PropertySection({
  children,
  className,
  title,
  first,
}: {
  children: ReactNode;
  className?: string;
  /** Labeled section header (§4). When set, renders the uppercase header above the rows. */
  title?: string;
  /** First section drops the top padding on its header. */
  first?: boolean;
}) {
  return (
    <div className={className}>
      {title ? (
        <div
          className={cn(
            "text-xs font-semibold uppercase tracking-wide text-muted-foreground pb-1",
            first ? "pt-0" : "pt-3",
          )}
        >
          {title}
        </div>
      ) : null}
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export function PropertyRow({
  label,
  children,
  wrap,
}: {
  label: ReactNode;
  children: ReactNode;
  /** Opt-in wrapping for chip-collection rows only (§5). Default rows stay one line. */
  wrap?: boolean;
}) {
  return (
    <div className="flex w-full min-w-0 items-start gap-3 py-1.5">
      <span
        className="text-xs text-muted-foreground shrink-0 w-24 mt-0.5 truncate"
        title={typeof label === "string" ? label : undefined}
      >
        {label}
      </span>
      <div className={cn("flex min-w-0 flex-1 items-center gap-1.5", wrap && "flex-wrap")}>{children}</div>
    </div>
  );
}

export function PropertyChip({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={cn("inline-flex max-w-full min-w-0 items-center gap-1 truncate rounded-full border px-2 py-0.5 text-xs", className)}
      style={style}
    >
      {children}
    </span>
  );
}
