/**
 * Parse Hermes chat output into structured result.
 * Hermes --quiet mode outputs plain text. We extract the final answer
 * and reconstruct a minimal JSONL-like structure for Paperclip compatibility.
 */

export interface ParsedHermesOutput {
  finalMessage: string;
  messages: string[];
  errors: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number | null;
  };
}

/**
 * Extract the final non-empty line as the answer, collect all lines as messages.
 * Hermes output format with --quiet:
 *   session_id: <id>
 *   <answer text>
 *
 * The answer may be multi-line for complex responses.
 */
export function parseHermesOutput(stdout: string, stderr: string): ParsedHermesOutput {
  const lines = stdout.split(/\r?\n/).map((l) => l.trimEnd());
  const messages: string[] = [];
  let finalMessage = "";
  let sessionId: string | null = null;

  for (const line of lines) {
    if (line.startsWith("session_id:")) {
      sessionId = line.slice("session_id:".length).trim();
      continue;
    }
    if (line.length > 0) {
      messages.push(line);
    }
  }

  // Last non-session-id line is the final answer
  if (messages.length > 0) {
    finalMessage = messages[messages.length - 1];
  }

  // Collect errors from stderr
  const errors: string[] = [];
  if (stderr.trim()) {
    const errorLines = stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
    errors.push(...errorLines);
  }

  return {
    finalMessage,
    messages,
    errors,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
    },
  };
}

/**
 * Check if stderr indicates an unknown session error (for session resume failures).
 */
export function isHermesUnknownSessionError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("session") &&
    (lower.includes("not found") || lower.includes("does not exist") || lower.includes("unknown"))
  );
}
