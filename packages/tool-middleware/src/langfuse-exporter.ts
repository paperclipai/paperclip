/**
 * Langfuse exporter — emits OpenTelemetry-compatible spans to Langfuse.
 *
 * Spans are flushed asynchronously. The agent loop is never blocked on telemetry.
 * If Langfuse is unreachable, the exporter falls back to a stderr no-op logger.
 *
 * Uses native `fetch()` (available in Node 18+) with a short timeout.
 * Does NOT include raw payloads — only artifact refs and summary fields.
 */

export interface ToolSpanData {
  traceId: string;
  spanId: string;
  toolName: string;
  inputTokenCount: number;
  outputTokenCount: number;
  rawOutputBytes: number;
  prunedOutputBytes: number;
  executionDurationMs: number;
  exitCode: number;
  originatingTicketId: string;
  teamId: string;
  artifactRefs: string[];
  status: "success" | "error";
  sessionId: string;
}

export interface LangfuseExporterConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

function isConfigured(config: LangfuseExporterConfig): boolean {
  return Boolean(config.baseUrl && config.publicKey && config.secretKey);
}

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function generateTraceId(): string {
  return generateId();
}

export function generateSpanId(): string {
  return generateId();
}

/** Estimate token count — rough approximation: 1 token ≈ 4 chars. */
function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/**
 * Emit a tool execution span to Langfuse asynchronously.
 * Never throws — errors are logged to stderr.
 */
export function emitToolSpan(span: ToolSpanData, config: LangfuseExporterConfig): void {
  if (!isConfigured(config)) {
    // No-op: Langfuse not configured
    return;
  }

  const traceId = span.traceId || generateTraceId();
  const spanId = span.spanId || generateSpanId();
  const now = new Date().toISOString();

  const body = {
    batch: [
      {
        type: "generation",
        id: spanId,
        traceId,
        name: `tool:${span.toolName}`,
        startTime: new Date(Date.now() - span.executionDurationMs).toISOString(),
        endTime: now,
        metadata: {
          tool_name: span.toolName,
          input_token_count: span.inputTokenCount,
          output_token_count: span.outputTokenCount || estimateTokensFromBytes(span.rawOutputBytes),
          raw_output_bytes: span.rawOutputBytes,
          pruned_output_bytes: span.prunedOutputBytes,
          execution_duration_ms: span.executionDurationMs,
          exit_code: span.exitCode,
          originating_ticket_id: span.originatingTicketId,
          team_id: span.teamId,
          artifact_refs: span.artifactRefs,
          session_id: span.sessionId,
        },
        output: {
          status: span.status,
          artifact_refs: span.artifactRefs,
        },
        level: span.status === "error" ? "ERROR" : "DEFAULT",
        statusMessage: span.status,
      },
    ],
  };

  const credentials = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");

  // Fire-and-forget: do not await, do not block the hook process
  const url = `${config.baseUrl.replace(/\/$/, "")}/api/public/ingestion`;
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).catch((err: unknown) => {
    // Non-blocking — log to stderr and continue
    process.stderr.write(`[tool-middleware] Langfuse export failed: ${String(err)}\n`);
  });
}

/**
 * No-op fallback for when Langfuse is not configured.
 * Writes a brief summary to stderr for local observability.
 */
export function logToStderr(span: ToolSpanData): void {
  process.stderr.write(
    `[tool-middleware] ${span.toolName} ${span.status} ` +
      `${span.executionDurationMs}ms ` +
      `raw=${span.rawOutputBytes}b pruned=${span.prunedOutputBytes}b\n`,
  );
}
