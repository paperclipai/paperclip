import { cn } from "@/lib/utils";
import {
  agentStatusDot,
  agentStatusDotDefault,
} from "@/lib/status-colors";

type Size = "sm" | "md";

const sizeMap: Record<Size, { container: string; dot: string; gap: string }> = {
  sm: { container: "h-2 w-3.5", dot: "h-1 w-1", gap: "gap-[2px]" },
  md: { container: "h-2.5 w-4", dot: "h-1.5 w-1.5", gap: "gap-[2px]" },
};

/**
 * Agent status indicator dot.
 *
 * When the agent status is "running", renders three dots that bounce
 * sequentially (typing-indicator style) to convey live activity.
 * All other statuses render a single static dot.
 */
export function StatusDot({
  status,
  size = "md",
  className,
}: {
  status: string;
  size?: Size;
  className?: string;
}) {
  const colorClass = agentStatusDot[status] ?? agentStatusDotDefault;

  if (status === "running") {
    const s = sizeMap[size];
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center",
          s.container,
          s.gap,
          className,
        )}
        aria-label="Running"
      >
        <span className={cn("rounded-full bg-primary animate-status-bounce", s.dot)} style={{ animationDelay: "0ms" }} />
        <span className={cn("rounded-full bg-primary animate-status-bounce", s.dot)} style={{ animationDelay: "160ms" }} />
        <span className={cn("rounded-full bg-primary animate-status-bounce", s.dot)} style={{ animationDelay: "320ms" }} />
      </span>
    );
  }

  const dotSize = size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";
  return (
    <span className={cn("relative flex", dotSize, className)}>
      <span
        className={cn(
          "absolute inline-flex h-full w-full rounded-full",
          colorClass,
        )}
      />
    </span>
  );
}
