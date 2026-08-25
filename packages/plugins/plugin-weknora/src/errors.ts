export type WeknoraErrorKind =
  | "invalid_config"
  | "auth"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "contract"
  | "upstream";

const SECRET_PATTERN = /(authorization|api[-_ ]?key|bearer|secret|token|password)\s*[:=]?\s*[^\s,;]+/gi;

export class WeknoraPluginError extends Error {
  readonly kind: WeknoraErrorKind;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(kind: WeknoraErrorKind, message: string, retryable: boolean, status?: number, requestId?: string) {
    super(sanitizeMessage(message));
    this.name = "WeknoraPluginError";
    this.kind = kind;
    this.status = status;
    this.requestId = requestId;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.status == null ? {} : { status: this.status }),
      ...(this.requestId == null ? {} : { requestId: this.requestId }),
      retryable: this.retryable,
    };
  }
}

export function sanitizeMessage(value: unknown): string {
  const text = typeof value === "string" ? value : "WeKnora request failed";
  const withoutMarkup = text.replace(/<[^>]*>/g, " ").replace(SECRET_PATTERN, "$1: [redacted]");
  return withoutMarkup.replace(/[\r\n\t]+/g, " ").trim().slice(0, 300) || "WeKnora request failed";
}

export function asWeknoraError(error: unknown): WeknoraPluginError {
  if (error instanceof WeknoraPluginError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new WeknoraPluginError("timeout", "WeKnora request timed out", true);
  }
  if (error instanceof Error) return new WeknoraPluginError("unavailable", error.message, true);
  return new WeknoraPluginError("unavailable", "WeKnora request failed", true);
}

export function errorKindForStatus(status: number): { kind: WeknoraErrorKind; retryable: boolean } {
  if (status === 401) return { kind: "auth", retryable: false };
  if (status === 403) return { kind: "forbidden", retryable: false };
  if (status === 404) return { kind: "not_found", retryable: false };
  if (status === 409) return { kind: "conflict", retryable: false };
  if (status === 429) return { kind: "rate_limited", retryable: true };
  if (status >= 500) return { kind: "unavailable", retryable: true };
  return { kind: "upstream", retryable: false };
}

export function mapHttpError(status: number, payload: unknown, requestId?: string): WeknoraPluginError {
  const details = typeof payload === "object" && payload !== null
    ? payload as Record<string, unknown>
    : {};
  const error = typeof details.error === "object" && details.error !== null ? details.error as Record<string, unknown> : details;
  const message = typeof error.message === "string"
    ? error.message
    : typeof error.detail === "string"
      ? error.detail
      : `WeKnora returned HTTP ${status}`;
  const mapped = errorKindForStatus(status);
  return new WeknoraPluginError(mapped.kind, message, mapped.retryable, status, requestId);
}
