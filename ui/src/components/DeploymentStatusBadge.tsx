import { cn } from "../lib/utils";

const deploymentStatusColors: Record<string, string> = {
  pending: "bg-[var(--status-warning)]/15 text-[var(--status-warning)]",
  running: "bg-[var(--primary)]/15 text-[var(--primary)]",
  succeeded: "bg-[var(--status-active)]/15 text-[var(--status-active)]",
  failed: "bg-[var(--status-error)]/15 text-[var(--status-error)]",
  cancelled: "bg-muted text-muted-foreground",
  rolling_back: "bg-[var(--status-warning)]/15 text-[var(--status-warning)]",
};

const defaultColor = "bg-muted text-muted-foreground";

const environmentColors: Record<string, string> = {
  production: "bg-[var(--status-error)]/10 text-[var(--status-error)] border-[var(--status-error)]/25",
  staging: "bg-[var(--primary)]/10 text-[var(--primary)] border-[var(--primary)]/25",
  development: "bg-[var(--status-active)]/10 text-[var(--status-active)] border-[var(--status-active)]/25",
  preview: "bg-[var(--primary)]/10 text-[var(--primary)] border-[var(--primary)]/25",
};

const defaultEnvColor = "bg-muted/50 text-muted-foreground border-border";

export function DeploymentStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[2px] px-2.5 py-0.5 text-[9px] font-[var(--font-mono)] font-medium uppercase whitespace-nowrap shrink-0",
        deploymentStatusColors[status] ?? defaultColor,
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function EnvironmentBadge({ environment }: { environment: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[2px] border px-2 py-0.5 text-[9px] font-[var(--font-mono)] font-medium uppercase whitespace-nowrap shrink-0",
        environmentColors[environment] ?? defaultEnvColor,
      )}
    >
      {environment}
    </span>
  );
}
