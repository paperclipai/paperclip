import { HttpError } from "../errors.js";

const phases = ["fetch", "http_response", "response_body", "response_write"] as const;
export type CloudPortfolioPhase = typeof phases[number];
const networkCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ABORT_ERR",
]);

// Inspect data properties only. A provider error can contain getters, cycles,
// arbitrary messages or nested request objects; none are diagnostic payloads.
function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function networkCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    const code = ownValue(current, "code");
    if (typeof code === "string" && networkCodes.has(code)) return code;
    current = ownValue(current, "cause");
  }
  return "unknown";
}

/** Server-only diagnostics. The existing HTTP response details stay unchanged. */
export class CloudPortfolioError extends HttpError {
  readonly #diagnostics: Readonly<Record<string, string | number | null>>;

  constructor(
    kind: "upstream" | "invalid_response",
    input: { phase: CloudPortfolioPhase; elapsedMs: number; upstreamStatus: number | null; deadlineExceeded?: boolean },
    error?: unknown,
  ) {
    super(502, kind === "invalid_response"
      ? "Paperclip Cloud portfolio returned invalid JSON"
      : "Paperclip Cloud portfolio request failed", {
      code: kind === "invalid_response" ? "cloud_portfolio_invalid_response" : "cloud_portfolio_upstream_error",
    });
    Error.captureStackTrace?.(this, CloudPortfolioError);
    const phase = phases.includes(input.phase) ? input.phase : "unknown";
    this.#diagnostics = Object.freeze({
      phase,
      upstreamStatus: Number.isInteger(input.upstreamStatus) && input.upstreamStatus! >= 100 && input.upstreamStatus! <= 599
        ? input.upstreamStatus : null,
      elapsedMs: Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0 && input.elapsedMs <= 60_000
        ? Math.round(input.elapsedMs) : null,
      networkCode: phase === "fetch" || phase === "response_body"
        ? input.deadlineExceeded === true ? "DEADLINE_EXCEEDED" : networkCode(error)
        : "unknown",
    });
  }

  get diagnostics() {
    return this.#diagnostics;
  }

  static diagnosticsFor(error: CloudPortfolioError) {
    return error.#diagnostics;
  }
}
