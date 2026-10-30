import type { HTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const agentTableHeadClass =
  "grid h-11 items-center gap-3 border-b border-border bg-(--agent-detail-table-head) px-4 text-sm text-muted-foreground";

export const agentTableRowClass = "grid min-h-11 items-center gap-3 border-b border-border px-4 py-2 text-sm last:border-b-0";

export function AgentPanel({
  title,
  meta,
  action,
  className,
  headerClassName,
  children,
  ...rest
}: {
  title?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
  headerClassName?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section data-agent-tile="" className={cn("flex min-w-0 flex-col rounded-lg bg-(--agent-detail-tile)", className)} {...rest}>
      {title ? (
        <header className={cn("flex items-center justify-between gap-3 px-(--agent-detail-module-inset) pt-(--agent-detail-module-inset) pb-3", headerClassName)}>
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">{title}</h3>
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {meta}
            {action}
          </div>
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function AgentSectionHeading({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {action}
    </div>
  );
}

export function AgentTextLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

export function AgentMetricTile({
  icon: Icon,
  value,
  label,
  description,
  onClick,
}: {
  icon: LucideIcon;
  value: ReactNode;
  label: string;
  description: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-(--agent-detail-tile-min-h) min-w-0 flex-col rounded-lg bg-(--agent-detail-tile) p-(--agent-detail-module-inset) text-left transition-colors outline-none hover:bg-(--agent-detail-tile-hover) focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">{value}</span>
        <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </span>
      <span className="mt-1 text-sm text-muted-foreground">{label}</span>
      <span className="mt-1.5 text-xs text-muted-foreground/70">{description}</span>
    </button>
  );
}

export function AgentChip({ tone = "neutral", mono, children }: { tone?: "neutral" | "danger"; mono?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-xs leading-4",
        mono && "font-mono",
        tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-(--agent-detail-tile-chip) text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
