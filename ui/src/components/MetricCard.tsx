import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { DotMatrixText } from "./NothingAesthetic";
import { cn } from "../lib/utils";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div
      className={cn(
        "relative h-full overflow-hidden rounded-md border border-border/60 bg-background/55 px-4 py-4 shadow-sm transition-colors sm:px-5 sm:py-5",
        "before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle,rgb(255_255_255/0.14)_1px,transparent_1px)] before:bg-[length:16px_16px] before:opacity-[0.10]",
        "after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:h-px after:bg-foreground/15",
        "dark:border-white/10 dark:bg-[#050914]/88 dark:shadow-[inset_0_1px_0_rgb(252_250_254/0.08),0_10px_30px_rgb(0_0_0/0.18)]",
        isClickable && "cursor-pointer hover:bg-accent/45 dark:hover:border-white/20 dark:hover:bg-[#080D19]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <DotMatrixText className="block text-3xl leading-none text-foreground sm:text-4xl dark:text-[#FCFAFE]">
            {value}
          </DotMatrixText>
          <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:text-xs dark:text-[#E1E5EA]/75">
            {label}
          </p>
          {description && (
            <div className="text-xs text-muted-foreground/70 mt-1.5 hidden sm:block">{description}</div>
          )}
        </div>
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border/70 bg-background/70 dark:border-white/10 dark:bg-white/[0.03]">
          <Icon className="h-4 w-4 text-muted-foreground/65" />
        </span>
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
