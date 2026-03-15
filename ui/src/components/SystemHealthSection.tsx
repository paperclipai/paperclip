import type { SubsystemHealthResponse } from "@paperclipai/shared";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";

const STATUS_CLASSES = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
  unknown: "bg-zinc-400",
} as const;

function StatusDot({ status }: { status: keyof typeof STATUS_CLASSES }) {
  return <span className={cn("inline-block h-2.5 w-2.5 rounded-full", STATUS_CLASSES[status])} />;
}

interface SystemHealthSectionProps {
  data?: SubsystemHealthResponse;
  error?: Error | null;
  isLoading: boolean;
  isRefetching: boolean;
  onRefresh: () => void;
}

export function SystemHealthSection({
  data,
  error,
  isLoading,
  isRefetching,
  onRefresh,
}: SystemHealthSectionProps) {
  return (
    <section className="paperclip-monitor-card space-y-4 p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="paperclip-monitor-title">System Health</h2>
          <p className="paperclip-monitor-subtitle mt-2 text-sm">
            Instance-level diagnostics for the control plane and local runtimes.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={isRefetching}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", isRefetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {isLoading && (
        <div className="paperclip-monitor-card rounded-[calc(var(--radius)-0.05rem)] px-4 py-3 text-sm text-muted-foreground">
          Loading subsystem diagnostics...
        </div>
      )}

      {error && (
        <div className="rounded-[calc(var(--radius)-0.05rem)] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
          {error.message}
        </div>
      )}

      {data && (
        <div className="space-y-4">
          <div className="paperclip-chip flex items-center gap-2 rounded-[calc(var(--radius)-0.1rem)] px-3 py-2 text-sm text-muted-foreground">
            <StatusDot status={data.status} />
            <span className="capitalize">{data.status}</span>
            <span>checked {timeAgo(data.testedAt)}</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.checks.map((check) => (
              <article key={check.id} className="paperclip-monitor-card h-full space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <StatusDot status={check.status} />
                    <h3 className="text-sm font-medium">{check.label}</h3>
                  </div>
                  <span className="paperclip-nav-meta text-[0.58rem] text-muted-foreground">
                    {check.blocking ? "blocking" : "advisory"}
                  </span>
                </div>
                <p className="text-sm">{check.summary}</p>
                {check.detail && (
                  <p className="text-xs text-muted-foreground">{check.detail}</p>
                )}
                {check.hint && (
                  <p className="text-xs text-muted-foreground">Hint: {check.hint}</p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Checked {timeAgo(check.testedAt)}
                </p>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
