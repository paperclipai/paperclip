// Status → dot color, as CSS variables holding raw hex (usable in SVG fills and
// inline styles). Shared by the Org chart and the Office view so both render the
// same "is it live" cue. Keys are the AGENT_STATUSES values.
export const statusDotColor: Record<string, string> = {
  running: "var(--hex-22d3ee)",
  active: "var(--hex-4ade80)",
  paused: "var(--hex-facc15)",
  idle: "var(--hex-facc15)",
  error: "var(--hex-f87171)",
  terminated: "var(--hex-a3a3a3)",
};

export const defaultDotColor = "var(--hex-a3a3a3)";
