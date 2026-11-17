import type {
  CloudflareBridgeAcquireLeaseRequest,
  CloudflareBridgeExecuteRequest,
  CloudflareBridgeExecuteResponse,
  CloudflareBridgeHealthResponse,
  CloudflareBridgeLeaseResponse,
  CloudflareBridgeProbeRequest,
  CloudflareBridgeProbeResponse,
  CloudflareBridgeReleaseLeaseRequest,
  CloudflareBridgeResumeLeaseRequest,
  CloudflareDriverConfig,
} from "./types.js";

interface BridgeClientHeaders {
  environmentId?: string;
  runId?: string;
  issueId?: string | null;
}

interface BridgeClientOptions {
  config: CloudflareDriverConfig;
}

interface BridgeExecuteOptions {
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

interface BridgeErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
}

interface ParsedErrorBody {
  errorBody: BridgeErrorBody;
  rawText: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CloudflareBridgeError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(input: { status: number; code?: string | null; message: string; details?: unknown }) {
    super(input.message);
    this.name = "CloudflareBridgeError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.details = input.details;
  }
}

function buildHeaders(config: CloudflareDriverConfig, extra: BridgeClientHeaders = {}): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${config.bridgeAuthToken}`);
  headers.set("Content-Type", "application/json");
  if (extra.environmentId) headers.set("X-Paperclip-Environment-Id", extra.environmentId);
  if (extra.runId) headers.set("X-Paperclip-Run-Id", extra.runId);
  if (extra.issueId) headers.set("X-Paperclip-Issue-Id", extra.issueId);
  return headers;
}

async function parseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }
  return await response.json();
}

async function parseErrorBody(response: Response): Promise<ParsedErrorBody> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      const body = await response.json();
      return {
        errorBody: isRecord(body) ? body as BridgeErrorBody : {},
        rawText: null,
      };
    } catch (error) {
      return {
        errorBody: {},
        rawText: `Malformed JSON error response: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const rawText = await response.text().catch(() => "");
  return {
    errorBody: {},
    rawText,
  };
}

function buildBridgeErrorMessage(status: number, errorBody: BridgeErrorBody, rawText: string | null): string {
  if (typeof errorBody.message === "string" && errorBody.message.trim().length > 0) {
    return errorBody.message.trim();
  }

  const text = rawText?.replace(/\s+/g, " ").trim() ?? "";
  if (status === 403 && /\b1010\b/i.test(text) && /cloudflare/i.test(text)) {
    return "Cloudflare sandbox bridge request was blocked by Cloudflare 1010 bot protection. Exempt the bridge endpoint or token-authenticated API path from bot/security rules.";
  }

  if (text.length > 0) {
    return `Cloudflare sandbox bridge request failed with HTTP ${status}: ${text.slice(0, 240)}`;
  }

  return `Cloudflare sandbox bridge request failed with HTTP ${status}.`;
}

function normalizeExecuteResponse(body: unknown): CloudflareBridgeExecuteResponse {
  if (!isRecord(body)) {
    throw new CloudflareBridgeError({
      status: 502,
      code: "malformed_execute_response",
      message: "Cloudflare sandbox bridge returned a malformed exec response.",
      details: body,
    });
  }

  const exitCode = body.exitCode;
  const timedOut = body.timedOut;
  const stdout = body.stdout;
  const stderr = body.stderr;
  if (
    !(typeof exitCode === "number" || exitCode === null) ||
    typeof timedOut !== "boolean" ||
    typeof stdout !== "string" ||
    typeof stderr !== "string"
  ) {
    throw new CloudflareBridgeError({
      status: 502,
      code: "malformed_execute_response",
      message: "Cloudflare sandbox bridge returned a malformed exec response.",
      details: body,
    });
  }

  return {
    exitCode,
    signal: typeof body.signal === "string" || body.signal === null ? body.signal : null,
    timedOut,
    stdout,
    stderr,
    metadata: isRecord(body.metadata) ? body.metadata : undefined,
  };
}

function encodeExecuteRequestBody(body: CloudflareBridgeExecuteRequest, options?: BridgeExecuteOptions): string {
  return JSON.stringify({
    ...body,
    streamOutput: typeof options?.onOutput === "function",
  });
}

function parseExecuteTimeoutMs(body: RequestInit["body"]): number | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body) as { timeoutMs?: unknown };
    const timeoutMs = Number(parsed.timeoutMs);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : null;
  } catch {
    return null;
  }
}

export function resolveRequestTimeoutMs(
  config: CloudflareDriverConfig,
  path: string,
  init: RequestInit,
): number {
  if (!path.endsWith("/exec")) {
    return config.bridgeRequestTimeoutMs;
  }
  const requestedTimeoutMs = parseExecuteTimeoutMs(init.body);
  return requestedTimeoutMs === null
    ? config.bridgeRequestTimeoutMs
    : Math.max(config.bridgeRequestTimeoutMs, requestedTimeoutMs);
}

async function requestJson<T>(
  config: CloudflareDriverConfig,
  path: string,
  init: RequestInit,
  extraHeaders: BridgeClientHeaders = {},
): Promise<T> {
  const controller = new AbortController();
  const requestTimeoutMs = resolveRequestTimeoutMs(config, path, init);
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const baseUrl = config.bridgeBaseUrl.replace(/\/+$/, "");

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: buildHeaders(config, extraHeaders),
      signal: controller.signal,
    });
    if (!response.ok) {
      const { errorBody, rawText } = await parseErrorBody(response);
      throw new CloudflareBridgeError({
        status: response.status,
        code: typeof errorBody.error === "string" ? errorBody.error : null,
        message: buildBridgeErrorMessage(response.status, errorBody, rawText),
        details: errorBody.details,
      });
    }
    const body = await parseJson(response);
    return body as T;
  } catch (error) {
    if (error instanceof CloudflareBridgeError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new Error(
        `Cloudflare sandbox bridge request timed out after ${requestTimeoutMs}ms.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestResponse(
  config: CloudflareDriverConfig,
  path: string,
  init: RequestInit,
  extraHeaders: BridgeClientHeaders = {},
): Promise<Response> {
  const controller = new AbortController();
  const requestTimeoutMs = resolveRequestTimeoutMs(config, path, init);
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const baseUrl = config.bridgeBaseUrl.replace(/\/+$/, "");

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: buildHeaders(config, extraHeaders),
      signal: controller.signal,
    });
    if (!response.ok) {
      const { errorBody, rawText } = await parseErrorBody(response);
      throw new CloudflareBridgeError({
        status: response.status,
        code: typeof errorBody.error === "string" ? errorBody.error : null,
        message: buildBridgeErrorMessage(response.status, errorBody, rawText),
        details: errorBody.details,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof CloudflareBridgeError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new Error(
        `Cloudflare sandbox bridge request timed out after ${requestTimeoutMs}ms.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

function parseSseChunk(buffer: string): { events: ParsedSseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: ParsedSseEvent[] = [];

  for (const frame of frames) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    events.push({
      event,
      data: dataLines.join("\n"),
    });
  }

  return { events, rest };
}

async function consumeExecuteEventStream(
  response: Response,
  options: BridgeExecuteOptions,
): Promise<CloudflareBridgeExecuteResponse> {
  if (!response.body) {
    throw new Error("Cloudflare sandbox bridge streaming response had no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CloudflareBridgeExecuteResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const parsed = parseSseChunk(done && buffer.length > 0 ? `${buffer}\n\n` : buffer);
    buffer = parsed.rest;

    for (const event of parsed.events) {
      if (event.event === "stdout" || event.event === "stderr") {
        const payload = JSON.parse(event.data) as { data?: unknown };
        const chunk = typeof payload.data === "string" ? payload.data : "";
        if (chunk) {
          await options.onOutput?.(event.event, chunk);
        }
        continue;
      }

      if (event.event === "complete") {
        result = normalizeExecuteResponse(JSON.parse(event.data));
        continue;
      }

      if (event.event === "error") {
        const payload = JSON.parse(event.data) as { error?: unknown };
        const message = typeof payload.error === "string" && payload.error.trim().length > 0
          ? payload.error
          : "Cloudflare sandbox bridge streaming command failed.";
        throw new Error(message);
      }
    }

    if (done) break;
  }

  if (result) return result;
  throw new Error("Cloudflare sandbox bridge streaming response ended without a completion event.");
}

export function createCloudflareBridgeClient(options: BridgeClientOptions) {
  const { config } = options;
  const apiPrefix = "/api/paperclip-sandbox/v1";

  return {
    health(extraHeaders?: BridgeClientHeaders): Promise<CloudflareBridgeHealthResponse> {
      return requestJson<CloudflareBridgeHealthResponse>(config, `${apiPrefix}/health`, { method: "GET" }, extraHeaders);
    },

    probe(body: CloudflareBridgeProbeRequest, extraHeaders?: BridgeClientHeaders): Promise<CloudflareBridgeProbeResponse> {
      return requestJson<CloudflareBridgeProbeResponse>(
        config,
        `${apiPrefix}/probe`,
        { method: "POST", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    acquireLease(
      body: CloudflareBridgeAcquireLeaseRequest,
      extraHeaders?: BridgeClientHeaders,
    ): Promise<CloudflareBridgeLeaseResponse> {
      return requestJson<CloudflareBridgeLeaseResponse>(
        config,
        `${apiPrefix}/leases/acquire`,
        { method: "POST", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    resumeLease(
      body: CloudflareBridgeResumeLeaseRequest,
      extraHeaders?: BridgeClientHeaders,
    ): Promise<CloudflareBridgeLeaseResponse> {
      return requestJson<CloudflareBridgeLeaseResponse>(
        config,
        `${apiPrefix}/leases/resume`,
        { method: "POST", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    releaseLease(
      body: CloudflareBridgeReleaseLeaseRequest,
      extraHeaders?: BridgeClientHeaders,
    ): Promise<{ ok: true }> {
      return requestJson<{ ok: true }>(
        config,
        `${apiPrefix}/leases/release`,
        { method: "POST", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    destroyLease(providerLeaseId: string, extraHeaders?: BridgeClientHeaders): Promise<{ ok: true }> {
      return requestJson<{ ok: true }>(
        config,
        `${apiPrefix}/leases/${encodeURIComponent(providerLeaseId)}`,
        { method: "DELETE" },
        extraHeaders,
      );
    },

    execute(
      body: CloudflareBridgeExecuteRequest,
      extraHeaders?: BridgeClientHeaders,
      options?: BridgeExecuteOptions,
    ): Promise<CloudflareBridgeExecuteResponse> {
      const encodedBody = encodeExecuteRequestBody(body, options);
      if (typeof options?.onOutput === "function") {
        return requestResponse(
          config,
          `${apiPrefix}/exec`,
          { method: "POST", body: encodedBody },
          extraHeaders,
        ).then((response) => consumeExecuteEventStream(response, options));
      }
      return requestJson<unknown>(
        config,
        `${apiPrefix}/exec`,
        { method: "POST", body: encodedBody },
        extraHeaders,
      ).then(normalizeExecuteResponse);
    },
  };
}
