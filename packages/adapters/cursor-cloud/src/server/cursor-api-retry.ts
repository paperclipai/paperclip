export type CursorApiErrorKind =
  | { kind: "agent_busy"; retryable: false }
  | { kind: "stream_expired"; retryable: false; fallback: "get_run" }
  | { kind: "rate_limited"; retryable: true; retryAfterMs?: number }
  | { kind: "transient"; retryable: true }
  | { kind: "fatal"; retryable: false };

export function classifyCursorApiError(err: unknown): CursorApiErrorKind {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("agent_busy") || lower.includes("409")) {
    return { kind: "agent_busy", retryable: false };
  }
  if (lower.includes("stream_expired") || lower.includes("410")) {
    return { kind: "stream_expired", retryable: false, fallback: "get_run" };
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return { kind: "rate_limited", retryable: true, retryAfterMs: 30_000 };
  }
  if (lower.includes("500") || lower.includes("502") || lower.includes("503") || lower.includes("timeout")) {
    return { kind: "transient", retryable: true };
  }
  return { kind: "fatal", retryable: false };
}

export async function withCursorRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = classifyCursorApiError(err);
      if (!classified.retryable || attempt >= maxAttempts) throw err;
      const delay =
        classified.kind === "rate_limited" && classified.retryAfterMs
          ? classified.retryAfterMs
          : baseDelayMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
