export interface VibeParseResult {
  finalMessage: string | null;
  toolCallCount: number;
  errors: string[];
}

/**
 * Parse Vibe CLI streaming output.
 *
 * Vibe --output streaming emits newline-delimited JSON events:
 *   {"type":"tool_call", ...}
 *   {"type":"message", "role":"assistant", "content":"..."}
 *   {"type":"error", "message":"..."}
 *
 * Plain-text lines (non-JSON) are ignored — Vibe may emit progress
 * or debug lines that are not structured events.
 */
export function parseVibeStream(stdout: string): VibeParseResult {
  const lines = stdout.split("\n");
  let finalMessage: string | null = null;
  let toolCallCount = 0;
  const errors: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const eventType = event.type;
      if (eventType === "tool_call" || eventType === "tool_use") {
        toolCallCount++;
      } else if (eventType === "message") {
        const role = event.role;
        const content = event.content;
        if (role === "assistant" && typeof content === "string" && content.trim().length > 0) {
          finalMessage = content.trim();
        }
      } else if (eventType === "error") {
        const msg = typeof event.message === "string" ? event.message.trim() : "";
        if (msg) errors.push(msg);
      }
    } catch {
      // Non-JSON line — skip
    }
  }

  return { finalMessage, toolCallCount, errors };
}

/**
 * Detect Mistral / Vibe CLI authentication errors.
 */
export function detectVibeAuthRequired(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("not authenticated") ||
    combined.includes("authentication failed") ||
    combined.includes("invalid api key") ||
    combined.includes("unauthorized") ||
    combined.includes("vibe --setup")
  );
}
