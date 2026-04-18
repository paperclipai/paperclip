import { type ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

interface EntityRowProps {
  leading?: ReactNode;
  identifier?: string;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
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
  selected,
  to,
  onClick,
  className,
}: EntityRowProps) {
  const isClickable = !!(to || onClick);
  const baseClasses = cn(
    "flex items-center gap-3 px-4 py-2 text-sm border-b border-border last:border-b-0 transition-colors",
    isClickable && "cursor-pointer hover:bg-accent/50",
    selected && "bg-accent/30",
    className
  );

  const leadingEl = leading ? (
    <div className="flex items-center gap-2 shrink-0">{leading}</div>
  ) : null;

  const bodyEl = (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        {identifier && (
          <span className="text-xs text-muted-foreground font-mono shrink-0 relative top-[1px]">
            {identifier}
          </span>
        )}
        <span className="truncate">{title}</span>
      </div>
      {subtitle && (
        <p className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</p>
      )}
    </div>
  );

  const trailingEl = trailing ? (
    <div className="flex items-center gap-2 shrink-0">{trailing}</div>
  ) : null;

  // When there is both a nav target and trailing interactive content, split the
  // row: a Link covers the leading + body (left side), while trailing sits in
  // normal flow at a higher z-index so its buttons/menus are never swallowed
  // by the link's click area.
  if (to && trailing) {
    return (
      <div className={cn(baseClasses, "relative")}>
        <Link
          to={to}
          className="absolute inset-0 no-underline"
          onClick={onClick}
          tabIndex={-1}
          aria-hidden="true"
        />
        {leadingEl}
        {bodyEl}
        <div className="relative z-10 flex items-center gap-2 shrink-0">
          {trailing}
        </div>
      </div>
    );
  }

  if (to) {
    return (
      <Link to={to} className={cn(baseClasses, "no-underline text-inherit")} onClick={onClick}>
        {leadingEl}
        {bodyEl}
      </Link>
    );
  }

  return (
    <div className={baseClasses} onClick={onClick}>
      {leadingEl}
      {bodyEl}
      {trailingEl}
    </div>
  );
}
