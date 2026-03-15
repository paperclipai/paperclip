import { type ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

interface EntityRowProps {
  leading?: ReactNode;
  identifier?: string;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  trailingOutsideLink?: boolean;
  selected?: boolean;
  to?: string;
  onClick?: () => void;
  className?: string;
}

export function EntityRow({
  leading,
  identifier,
  title,
  subtitle,
  trailing,
  trailingOutsideLink,
  selected,
  to,
  onClick,
  className,
}: EntityRowProps) {
  const isClickable = !!(to || onClick);
  const classes = cn(
    "paperclip-work-row flex items-center gap-3 border-b border-[color:color-mix(in_oklab,var(--primary)_10%,var(--border))] px-4 py-3 text-sm last:border-b-0 transition-colors",
    isClickable && "cursor-pointer",
    selected && "bg-[color:color-mix(in_oklab,var(--surface-panel-strong)_84%,transparent)]",
    className
  );

  const mainContent = (
    <>
      {leading && <div className="flex items-center gap-2 shrink-0">{leading}</div>}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {identifier && (
            <span className="paperclip-work-meta shrink-0 relative top-[1px] text-[0.62rem]">
              {identifier}
            </span>
          )}
          <span className="truncate font-medium">{title}</span>
        </div>
        {subtitle && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
    </>
  );

  if (to && trailingOutsideLink) {
    return (
      <div className={classes}>
        {/* Keep trailing interactive controls outside the row link so we never nest anchors. */}
        <Link to={to} className="flex min-w-0 flex-1 items-center gap-3 no-underline text-inherit" onClick={onClick}>
          {mainContent}
        </Link>
        {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
      </div>
    );
  }

  const content = (
    <>
      {mainContent}
      {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={cn(classes, "no-underline text-inherit")} onClick={onClick}>
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
