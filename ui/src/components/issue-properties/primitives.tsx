import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function PropertySection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-1", className)}>{children}</div>;
}

export function PropertyRow({
  label,
  children,
  labelClassName,
}: {
  label: ReactNode;
  children: ReactNode;
  labelClassName?: string;
}) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className={cn("text-xs text-muted-foreground shrink-0 w-20 mt-0.5", labelClassName)}>{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
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
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border", className)}
      style={style}
    >
      {children}
    </span>
  );
}
