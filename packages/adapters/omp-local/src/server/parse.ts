/**
 * Parse OMP JSONL output
 * OMP outputs JSONL format similar to PI, with each line being a JSON object
 */
export function parseOmpJsonl(stdout: string): {
  result: string;
  usage: unknown;
  sessionId: string | null;
  error?: string;
  errorResponse?: string;
  hasUnknownSessionError?: boolean;
} {
  if (!stdout || !stdout.trim()) {
    return { result: "", usage: null, sessionId: null };
  }

  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return { result: "", usage: null, sessionId: null };
  }

  const lastLine = lines[lines.length - 1];
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(lastLine);
  } catch {
    // If last line isn't valid JSON, try to reconstruct from all lines
    const allText = lines
      .map((l) => {
        try {
          const obj = JSON.parse(l);
          return (obj.content as string) || (obj.text as string) || (obj.message as string) || "";
        } catch {
          return l;
        }
      })
      .join("\n");
    return { result: allText, usage: null, sessionId: null };
  }

  // Extract result from various possible formats
  let result = "";
  let usage: unknown = null;
  let sessionId: string | null = null;
  let error: string | undefined;
  let errorResponse: string | undefined;
  let hasUnknownSessionError = false;

  // OMP might use different field names
  if (typeof parsed === "string") {
    result = parsed;
  } else if (parsed.content) {
    result = parsed.content as string;
  } else if (parsed.text) {
    result = parsed.text as string;
  } else if (parsed.message) {
    result = parsed.message as string;
  } else if (parsed.output) {
    result = parsed.output as string;
  } else if (parsed.result) {
    result = parsed.result as string;
  } else if (parsed.response) {
    result = parsed.response as string;
  }

  // Extract usage if present
  if (parsed.usage || (parsed.meta as Record<string, unknown>)?.usage) {
    usage = (parsed.usage as Record<string, unknown>) || ((parsed.meta as Record<string, unknown>)?.usage as Record<string, unknown>);
  }

  // Extract session ID if present
  if (parsed.sessionId || parsed.session_id || parsed.session) {
    sessionId = (parsed.sessionId as string) || (parsed.session_id as string) || (parsed.session as string);
  }

  // Check for errors
  if (parsed.error) {
    error = String(parsed.error);
    errorResponse = (parsed.errorMessage as string) || (parsed.message as string) || JSON.stringify(parsed.error);
  }

  // Check for unknown session errors
  const errorText = (parsed.error || "").toString().toLowerCase();
  const messageText = (parsed.message || "").toString().toLowerCase();
  if (
    errorText.includes("unknown session") ||
    errorText.includes("session not found") ||
    errorText.includes("invalid session") ||
    messageText.includes("unknown session") ||
    messageText.includes("session not found")
  ) {
    hasUnknownSessionError = true;
  }

  return {
    result,
    usage,
    sessionId,
    error,
    errorResponse,
    hasUnknownSessionError,
  };
}

/**
 * Check if stderr contains an unknown session error
 */
export function isOmpUnknownSessionError(stderr: string | null): boolean {
  if (!stderr) return false;
  const lines = stderr.split("\n");
  return lines.some((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes("unknown session") ||
      lower.includes("session not found") ||
      lower.includes("invalid session") ||
      lower.includes("no such session")
    );
  });
}
