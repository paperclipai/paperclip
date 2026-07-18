/**
 * Per-tool-call telemetry for the company-scoped MCP client (NEO-286 D2-5).
 *
 * Every MCP tool invocation an agent makes through agentMcpToolService emits
 * one structured event carrying the tool, the target server, the actor
 * (agentId), the company, the terminal outcome, and wall-clock duration —
 * mirroring the NEO-296 mcp-server token-policy telemetry so both halves of
 * the MCP surface audit the same way.
 *
 * Credential redaction is by construction: events never include tool
 * arguments, request headers, env, or credential material — only the
 * identifier fields declared on {@link McpToolCallTelemetryEvent}.
 *
 * The default sink writes one JSON line per call to stderr, keeping stdout
 * clean for anything that multiplexes it.
 */

/** A single MCP tool-call outcome. `actor`/`company` are null when the run context is unscoped. */
export interface McpToolCallTelemetryEvent {
  /** The MCP tool name, e.g. "create_issue". */
  tool: string;
  /** Slug of the MCP server the call was routed to. */
  server: string;
  /** The acting agent id, or null when unscoped. */
  actor: string | null;
  /** The company id the call executed under, or null when unscoped. */
  company: string | null;
  /** Terminal outcome: "error" covers both thrown failures and tool-level errors. */
  status: "ok" | "error";
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
  /** Constructor name of the thrown error, present only when the call threw. */
  errorName?: string;
}

export type McpToolTelemetrySink = (event: McpToolCallTelemetryEvent) => void;

/**
 * Default sink: emit one structured JSON line to stderr, stamped with an ISO
 * timestamp at emit time. The timestamp is added here rather than on the event
 * so {@link McpToolCallTelemetryEvent} stays deterministic for tests while the
 * emitted wire record remains audit-complete.
 */
export function createStderrMcpTelemetrySink(
  write: (line: string) => void = (line) => console.error(line),
): McpToolTelemetrySink {
  return (event) => {
    write(
      `[paperclip-mcp-client][telemetry] ${JSON.stringify({
        at: new Date().toISOString(),
        ...event,
      })}`,
    );
  };
}
