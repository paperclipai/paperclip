import { cn } from "@/lib/utils";

/**
 * GLASSHOUSE heartbeat spine — the signature "alive" line. A thin vertical
 * rail beside a working agent that an EKG-style pulse travels down on the
 * agent's own cadence; the whole rail flashes at the beat. A blocked agent
 * flatlines (still, clay-red); a finished one settles green. Each agent should
 * pass a slightly different `beat`/`delay` so a roster shimmers arrhythmically.
 * See DESIGN.md → "The heartbeat spine".
 */
export type HeartbeatState = "running" | "blocked" | "done" | "idle";

export interface HeartbeatSpineProps {
  state?: HeartbeatState;
  /** Beat interval in seconds (vary per agent, ~2.0–3.2). */
  beat?: number;
  /** Phase offset in seconds so agents don't beat in unison. */
  delay?: number;
  className?: string;
}

export function HeartbeatSpine({
  state = "running",
  beat = 2.4,
  delay = 0,
  className,
}: HeartbeatSpineProps) {
  return (
    <div
      className={cn("heartbeat-spine", className)}
      data-state={state}
      style={
        {
          ["--hs-beat" as string]: `${beat}s`,
          ["--hs-delay" as string]: `${delay}s`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {state === "running" && <div className="hs-pulse" />}
    </div>
  );
}
