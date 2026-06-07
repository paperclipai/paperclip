import { AgentFace } from "./AgentFace";

/**
 * Full-surface loading state — the signature Robo eyes (thinking) so a slow/cold
 * load reads as "the system is working," not a frozen blank. Use for page/app-gate
 * loads and lag windows; use <PageSkeleton> for in-page content placeholders.
 */
export function RoboLoading({
  label = "Loading",
  size = 56,
  className,
}: {
  label?: string;
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={
        "flex min-h-[45vh] flex-col items-center justify-center gap-4 text-center" +
        (className ? ` ${className}` : "")
      }
      role="status"
      aria-live="polite"
    >
      <AgentFace state="thinking" size={size} />
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}…
      </p>
    </div>
  );
}
