/**
 * Per-tool-call telemetry for the Paperclip MCP server.
 *
 * Every tool invocation — in either transport mode — emits one structured event
 * carrying the actor (agentId), company (companyId), tool name, terminal status,
 * and wall-clock duration. These events feed the audit trail and anomaly
 * detection required by NEO-296 (NEO-283 plan doc rev 1, Phase A.4).
 *
 * The default sink writes one JSON line per call to stderr. In stdio mode stdout
 * carries the MCP JSON-RPC stream, so telemetry must never be written there.
 */

/** A single tool-call outcome. `actor`/`company` are null when the token/env is unscoped. */
export interface ToolCallTelemetryEvent {
  /** The MCP tool name, e.g. "paperclipUpdateIssue". */
  tool: string;
  /** The acting agent id (from the token binding / env), or null when unscoped. */
  actor: string | null;
  /** The bound company id (from the token binding / env), or null when unscoped. */
  company: string | null;
  /** Terminal status of the call. */
  status: "ok" | "error";
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
  /** Constructor name of the thrown error, present only when status is "error". */
  errorName?: string;
}

export type ToolTelemetrySink = (event: ToolCallTelemetryEvent) => void;

export interface ToolTelemetry {
  sink: ToolTelemetrySink;
}

/**
 * Default sink: emit one structured JSON line to stderr, stamped with an ISO
 * timestamp at emit time. The timestamp is added here rather than on the event
 * so the {@link ToolCallTelemetryEvent} stays deterministic for tests while the
 * emitted wire record remains audit-complete.
 */
export function createStderrTelemetrySink(
  write: (line: string) => void = (line) => console.error(line),
): ToolTelemetrySink {
  return (event) => {
    write(
      `[paperclip-mcp][telemetry] ${JSON.stringify({
        at: new Date().toISOString(),
        ...event,
      })}`,
    );
  };
}
