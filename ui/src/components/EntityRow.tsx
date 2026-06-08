import { type ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

interface EntityRowProps {
  leading?: ReactNode;
  identifier?: string;
  title: string;
  subtitle?: string;
  /**
   * Optional metadata columns rendered immediately after the title. When set,
   * the title stops flex-growing and a spacer is inserted between `meta` and
   * `trailing`, so meta sits next to the name while trailing stays pinned right.
   */
  meta?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  to?: string;
  onClick?: () => void;
  className?: string;
  titleClassName?: string;
  reserveSubtitleSpace?: boolean;
  /**
   * Stack the row vertically below `sm` (title → meta → trailing on their own
   * lines) instead of forcing the single horizontal flex layout. Use for rows
   * with heavy `meta`/`trailing` (e.g. `DocumentRow`) that otherwise collapse
   * the title cell and clip trailing chips on narrow viewports. Desktop layout
   * is unchanged.
   */
  responsive?: boolean;
}

export function EntityRow({
  leading,
  identifier,
  title,
  subtitle,
  meta,
  trailing,
  selected,
  to,
  onClick,
  className,
  titleClassName,
  reserveSubtitleSpace,
  responsive,
}: EntityRowProps) {
  const isClickable = !!(to || onClick);
  const classes = cn(
    "flex gap-3 px-4 py-2 text-sm border-b border-border last:border-b-0 transition-colors",
    // Top-align the leading column while stacked so the status dot sits with the
    // title line; recenter once the row collapses back to a single line at sm.
    responsive ? "items-start sm:items-center" : "items-center",
    isClickable && "cursor-pointer hover:bg-accent/50",
    selected && "bg-accent/30",
    className
  );

  const titleBlock = (
    <div className={cn("min-w-0", !meta && "flex-1", titleClassName)}>
      <div className="flex items-center gap-2">
        {identifier && (
          <span className="text-xs text-muted-foreground font-mono shrink-0 relative top-[1px]">
            {identifier}
          </span>
        )}
        <span className="truncate" title={title}>{title}</span>
      </div>
      {(subtitle || reserveSubtitleSpace) && (
        <p
          className={cn("text-xs text-muted-foreground truncate mt-0.5 min-h-4", !subtitle && "invisible")}
          aria-hidden={!subtitle}
        >
          {subtitle}
        </p>
      )}
    </div>
  );

  // Responsive variant: below `sm` the title, meta, and trailing stack onto
  // their own lines (title cell keeps full width, nothing clips); at `sm`+ the
  // inner wrapper reflows to the same single-row layout as the default path
  // (content-sized title, meta hugging it, flex-1 spacer, trailing pinned right).
  const content = responsive ? (
    <>
      {leading && <div className="flex items-center gap-2 shrink-0 pt-0.5 sm:pt-0">{leading}</div>}
      <div className="min-w-0 flex-1 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        {titleBlock}
        {meta && <div className="flex items-center gap-2 shrink-0">{meta}</div>}
        <div className="hidden sm:block sm:flex-1" />
        {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
      </div>
    </>
  ) : (
    <>
      {leading && <div className="flex items-center gap-2 shrink-0">{leading}</div>}
      {titleBlock}
      {meta && <div className="flex items-center gap-2 shrink-0">{meta}</div>}
      {meta && <div className="flex-1" />}
      {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={cn("no-underline text-inherit", classes)} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <div className={classes} onClick={onClick}>
      {content}
    </div>
  );
}
