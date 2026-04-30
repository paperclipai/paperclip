/**
 * Thin HTTP helpers for the Ollama API. Isolated here so they can be reused
 * by execute/test without pulling the whole request-building machinery into
 * either call site.
 */

const USER_AGENT = "paperclip-ollama-local/0.1";

export interface OllamaHttpError extends Error {
  code:
    | "connection_refused"
    | "dns_failure"
    | "network_error"
    | "timeout"
    | "model_not_found"
    | "server_error"
    | "bad_response"
    | "aborted";
  status?: number | null;
  hint?: string | null;
}

export function createOllamaHttpError(
  code: OllamaHttpError["code"],
  message: string,
  extra?: { status?: number | null; hint?: string | null },
): OllamaHttpError {
  const err = new Error(message) as OllamaHttpError;
  err.name = "OllamaHttpError";
  err.code = code;
  err.status = extra?.status ?? null;
  err.hint = extra?.hint ?? null;
  return err;
}

function mapNativeFetchError(err: unknown, baseUrl: string): OllamaHttpError {
  const message = err instanceof Error ? err.message : String(err);
  // Node's undici surfaces both ECONNREFUSED and UND_ERR_CONNECT_TIMEOUT via
  // error.cause. On some platforms (notably WSL2) a connect to a closed port
  // does not return ECONNREFUSED and instead times out via undici's default
  // connect timeout — we treat both as a user-facing "can't reach server"
  // error and surface the same install hint.
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? "";
  if (code === "ECONNREFUSED" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return createOllamaHttpError(
      "connection_refused",
      `Could not reach Ollama at ${baseUrl} (${code === "ECONNREFUSED" ? "connection refused" : "connect timeout"}).`,
      {
        hint:
          "Start Ollama (`ollama serve`) or install it from https://ollama.com/download. " +
          "Verify the baseUrl in the agent adapter config.",
      },
    );
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return createOllamaHttpError(
      "dns_failure",
      `Could not resolve Ollama host for ${baseUrl}: ${message}`,
      { hint: "Check the baseUrl host name in the agent adapter config." },
    );
  }
  if (err instanceof Error && err.name === "AbortError") {
    return createOllamaHttpError("aborted", "Ollama request aborted.", {});
  }
  return createOllamaHttpError(
    "network_error",
    `Network error contacting ${baseUrl}: ${message}`,
    {},
  );
}

/**
 * Fetch a JSON endpoint on the Ollama server with a hard timeout.
 * Returns the parsed JSON on success. On error, throws OllamaHttpError.
 */
export async function ollamaGetJson<T = unknown>(
  baseUrl: string,
  route: string,
  timeoutSec: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSec) * 1000);
  let res: Response;
  try {
    res = await fetch(joinUrl(baseUrl, route), {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // Prefer the underlying cause code (ECONNREFUSED / ENOTFOUND) when present —
    // fetch aborts the request on those errors AND the AbortController timer
    // fires around the same time; checking signal.aborted first would mask
    // the real network error.
    const cause = (err as { cause?: { code?: string } })?.cause;
    if (!cause?.code && controller.signal.aborted) {
      throw createOllamaHttpError(
        "timeout",
        `Ollama request to ${route} timed out after ${timeoutSec}s.`,
        {},
      );
    }
    throw mapNativeFetchError(err, baseUrl);
  }
  clearTimeout(timer);
  if (!res.ok) {
    throw createOllamaHttpError(
      "server_error",
      `Ollama ${route} returned HTTP ${res.status}: ${await safeReadText(res)}`,
      { status: res.status },
    );
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw createOllamaHttpError(
      "bad_response",
      `Ollama ${route} returned a non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
      {},
    );
  }
}

export interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream: boolean;
  keepAliveSec: number;
  options: {
    num_ctx: number;
    temperature?: number;
    top_p?: number;
    num_predict?: number;
  };
}

export async function openOllamaChat(
  baseUrl: string,
  request: OllamaChatRequest,
  timeoutSec: number,
  externalSignal?: AbortSignal,
): Promise<{ response: Response; cleanupTimer: () => void }> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSec) * 1000);
  let res: Response;
  try {
    res = await fetch(joinUrl(baseUrl, "/api/chat"), {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: request.stream,
        keep_alive: `${request.keepAliveSec}s`,
        options: request.options,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    const cause = (err as { cause?: { code?: string } })?.cause;
    if (!cause?.code && controller.signal.aborted && !externalSignal?.aborted) {
      throw createOllamaHttpError(
        "timeout",
        `Ollama /api/chat timed out after ${timeoutSec}s.`,
        {},
      );
    }
    throw mapNativeFetchError(err, baseUrl);
  }
  const cleanupTimer = () => {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  };
  if (!res.ok) {
    cleanupTimer();
    const bodyText = await safeReadText(res);
    if (res.status === 404 && /model/i.test(bodyText)) {
      throw createOllamaHttpError(
        "model_not_found",
        `Model "${request.model}" is not available on the Ollama server.`,
        {
          status: 404,
          hint: `Pull it locally with \`ollama pull ${request.model}\`.`,
        },
      );
    }
    throw createOllamaHttpError(
      "server_error",
      `Ollama /api/chat returned HTTP ${res.status}: ${bodyText}`,
      { status: res.status },
    );
  }
  return { response: res, cleanupTimer };
}

export function joinUrl(baseUrl: string, route: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = route.startsWith("/") ? route : `/${route}`;
  return `${base}${suffix}`;
}

/**
 * Which OllamaHttpError codes are worth retrying. `model_not_found` and
 * `bad_response` reflect user config or protocol mismatches and must NOT be
 * retried — the caller has to act. `aborted` means the caller requested
 * cancellation, so it is never retried either. 5xx is handled inline in
 * {@link isRetriableOllamaError} because it depends on status.
 */
const RETRIABLE_CODES: ReadonlySet<OllamaHttpError["code"]> = new Set([
  "connection_refused",
  "dns_failure",
  "network_error",
  "timeout",
]);

export function isRetriableOllamaError(err: OllamaHttpError): boolean {
  if (RETRIABLE_CODES.has(err.code)) return true;
  if (err.code === "server_error") {
    const status = typeof err.status === "number" ? err.status : 0;
    return status >= 500 && status < 600;
  }
  return false;
}

/**
 * Exponential backoff with ±20% jitter. attempt is 0-indexed for the retry
 * (i.e. after the initial call fails, the first retry passes attempt=0).
 */
export function calcBackoffMs(attempt: number, baseMs = 250, maxMs = 4000): number {
  const pure = baseMs * 2 ** Math.max(0, attempt);
  const capped = Math.min(maxMs, pure);
  const jitterFactor = 1 + (Math.random() * 0.4 - 0.2);
  return Math.round(capped * jitterFactor);
}

export interface OllamaRetryOptions {
  maxAttempts: number;
  baseMs?: number;
  maxMs?: number;
  onRetry?: (ctx: { attempt: number; delayMs: number; error: OllamaHttpError }) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Wrap a call that may throw OllamaHttpError and retry transient failures with
 * exponential backoff. `maxAttempts` is the TOTAL number of attempts including
 * the first — e.g. maxAttempts=3 means one initial call + up to two retries.
 *
 * Never catches non-OllamaHttpError exceptions (unexpected bugs rethrow as-is).
 */
export async function withOllamaRetry<T>(
  fn: () => Promise<T>,
  options: OllamaRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.maxAttempts));
  let lastErr: OllamaHttpError | undefined;
  for (let i = 0; i < attempts; i++) {
    if (options.signal?.aborted) {
      throw createOllamaHttpError("aborted", "Ollama request aborted before retry.", {});
    }
    try {
      return await fn();
    } catch (err) {
      if (!isOllamaHttpErrorLike(err)) throw err;
      lastErr = err;
      const isLast = i === attempts - 1;
      if (isLast || !isRetriableOllamaError(err)) {
        throw err;
      }
      const delayMs = calcBackoffMs(i, options.baseMs, options.maxMs);
      if (options.onRetry) {
        await options.onRetry({ attempt: i + 1, delayMs, error: err });
      }
      await sleepWithAbort(delayMs, options.signal);
    }
  }
  // Unreachable — the loop either returns or throws. Included to satisfy TS.
  throw lastErr ?? createOllamaHttpError("network_error", "Retry loop ended without a result.", {});
}

function isOllamaHttpErrorLike(err: unknown): err is OllamaHttpError {
  return err instanceof Error && err.name === "OllamaHttpError";
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 800);
  } catch {
    return "";
  }
}
