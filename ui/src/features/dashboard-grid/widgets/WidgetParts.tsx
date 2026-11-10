import type { ReactNode } from "react";
import type { DashboardWidgetPlacement } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { useQueryView, type QueryViewSource } from "@/components/QueryView";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

export interface DashboardWidgetProps {
  companyId: string;
  placement: DashboardWidgetPlacement;
}

export function WidgetFrame({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: { label: string; to: string };
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex h-full min-h-0 flex-col gap-3 rounded-lg border border-border p-4", className)}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action ? (
          <Link to={action.to} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
            {action.label}
          </Link>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export function WidgetMessage({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <p role={tone === "error" ? "alert" : undefined} className={cn("text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </p>
  );
}

export function WidgetQueryState<TData>({ query, action }: { query: QueryViewSource<TData>; action: string }) {
  const view = useQueryView(query);
  if (view.kind === "error") {
    return <WidgetMessage tone="error">{describeError(view.error, { action }).body}</WidgetMessage>;
  }
  return <WidgetMessage>Loading…</WidgetMessage>;
}
