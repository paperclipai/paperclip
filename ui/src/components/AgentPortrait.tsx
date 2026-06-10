import { cn } from "@/lib/utils";
import { AgentFace, type AgentFaceState } from "./AgentFace";

/**
 * GLASSHOUSE agent portrait — the agent's IDENTITY. A generated character
 * portrait (see docs/portrait-generation.md) framed in the instrument tile
 * with a status ring + pip: working = teal ring + scanline, idle = desaturated
 * grey, blocked = clay, done = green. When no portrait has been generated yet,
 * it falls back to the animated <AgentFace> eyes.
 *
 * Use on identity surfaces (roster cards, org-chart nodes, the agent's office).
 * For live-work surfaces (activity tape) use <AgentFace> directly.
 * See DESIGN.md → "Portrait vs eyes".
 */
export type AgentPortraitState = "running" | "thinking" | "done" | "blocked" | "idle";

const STATUS_VAR: Record<AgentPortraitState, string> = {
  running: "var(--status-running)",
  thinking: "var(--status-running)",
  done: "var(--status-success)",
  blocked: "var(--status-error)",
  idle: "var(--status-idle)",
};

export interface AgentPortraitProps {
  /** Generated portrait URL. If absent, the animated eyes face is shown instead. */
  src?: string | null;
  name: string;
  state?: AgentPortraitState;
  /** px size of the square tile. */
  size?: number;
  /** Show the corner status pip. Default true. */
  pip?: boolean;
  /** Show the status ring. Default true. */
  ring?: boolean;
  /** Per-agent eye cadence (seconds) so a roster never blinks/scans in unison. */
  look?: number;
  scan?: number;
  className?: string;
}

export function AgentPortrait({
  src,
  name,
  state = "running",
  size = 48,
  pip = true,
  ring = true,
  look,
  scan,
  className,
}: AgentPortraitProps) {
  const dataState = state === "thinking" ? "running" : state;

  if (!src) {
    // No generated identity yet → the living eyes stand in, but keep the portrait
    // FRAME (border + status ring + corner pip) so it reads as an identity tile,
    // not bare floating eyes.
    return (
      <div
        className={cn("agent-portrait", className)}
        data-state={dataState}
        style={
          {
            width: size,
            height: size,
            ["--ap-c" as string]: STATUS_VAR[state],
          } as React.CSSProperties
        }
        title={name}
      >
        <AgentFace state={state as AgentFaceState} chromeless look={look} scan={scan} />
        {dataState === "running" && <div className="ap-scan" />}
        {ring && <span className="ap-ring" />}
        {pip && <span className="ap-pip" />}
      </div>
    );
  }

  return (
    <div
      className={cn("agent-portrait", className)}
      data-state={dataState}
      style={
        {
          width: size,
          height: size,
          ["--ap-c" as string]: STATUS_VAR[state],
        } as React.CSSProperties
      }
      title={name}
    >
      <img className="ap-img" src={src} alt={name} loading="lazy" />
      {dataState === "running" && <div className="ap-scan" />}
      {ring && <span className="ap-ring" />}
      {pip && <span className="ap-pip" />}
    </div>
  );
}
