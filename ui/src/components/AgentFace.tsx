import { cn } from "@/lib/utils";

/**
 * GLASSHOUSE agent face — the live-work icon. A tiny instrument screen whose
 * eyes scan + blink while the agent is working, settle to content arcs when
 * done, flatline to red dashes when blocked, and shut when idle.
 *
 * Use this on live-work surfaces (the activity tape, run streams). For identity
 * surfaces (roster, org chart, the agent's office) use <AgentPortrait>.
 * See DESIGN.md → "The agent face".
 */
export type AgentFaceState = "running" | "thinking" | "done" | "blocked" | "idle";

export interface AgentFaceProps {
  state?: AgentFaceState;
  /** px size of the (square-ish) screen. Default 36×28. */
  size?: number;
  /** Vary per-agent so a roster never blinks in unison. Seconds. */
  look?: number;
  scan?: number;
  /** Eyes only (no own border/background) so it can sit inside a portrait frame. */
  chromeless?: boolean;
  className?: string;
  title?: string;
}

export function AgentFace({
  state = "running",
  size = 36,
  look,
  scan,
  chromeless,
  className,
  title,
}: AgentFaceProps) {
  // "thinking" is "running" with a busier cadence.
  const dataState = state === "thinking" ? "running" : state;
  const lookDur = look ?? (state === "thinking" ? 2.2 : 3.4);
  const scanDur = scan ?? (state === "thinking" ? 1.8 : 2.6);

  return (
    <div
      className={cn("agent-face", chromeless && "af-chromeless", className)}
      data-state={dataState}
      title={title}
      style={
        {
          width: chromeless ? "100%" : size,
          height: chromeless ? "100%" : Math.round(size * 0.78),
          ["--af-look" as string]: `${lookDur}s`,
          ["--af-scan" as string]: `${scanDur}s`,
        } as React.CSSProperties
      }
      aria-label={`agent ${state}`}
      role="img"
    >
      {dataState === "running" && <div className="af-scan" />}
      <div className="af-eyes">
        <span className="af-eye" />
        <span className="af-eye" />
      </div>
    </div>
  );
}
