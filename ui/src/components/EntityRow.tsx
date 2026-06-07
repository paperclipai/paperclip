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
}: EntityRowProps) {
  const isClickable = !!(to || onClick);
  const classes = cn(
    "flex items-center gap-3 px-4 py-2 text-sm border-b border-border last:border-b-0 transition-colors",
    isClickable && "cursor-pointer hover:bg-accent/50",
    selected && "bg-accent/30",
    className
  );

  const content = (
    <>
      {leading && <div className="flex items-center gap-2 shrink-0">{leading}</div>}
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
