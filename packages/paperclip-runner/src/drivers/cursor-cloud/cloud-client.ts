export type CursorCloudRunStatus =
  | "CREATING" | "RUNNING" | "WAITING_FOR_BACKGROUND_WORK"
  | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";

export interface CursorCloudModelRef {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

export interface CursorCloudRepo {
  url: string;
  startingRef?: string;
  prUrl?: string;
}

export type CursorCloudMcpServer = {
  name: string;
  type?: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  auth?: { CLIENT_ID: string; CLIENT_SECRET?: string; scopes?: string[] };
} | {
  name: string;
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export interface CursorCloudFollowupInput {
  prompt: { text: string };
  model?: CursorCloudModelRef;
  mcpServers?: CursorCloudMcpServer[];
  envVars?: Record<string, string>;
  mode?: "agent" | "plan";
}

export interface CursorCloudCreateInput extends CursorCloudFollowupInput {
  agentId?: string;
  name?: string;
  env?: { type: "cloud" | "pool" | "machine"; name?: string };
  repos?: CursorCloudRepo[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  customSubagents?: Array<{
    name: string;
    description: string;
    prompt: string;
    model?: "inherit" | string | CursorCloudModelRef;
  }>;
}

export interface CursorCloudAgent {
  id: string;
  status: "ACTIVE" | "IDLE" | "ARCHIVED";
  env: { type: "cloud" | "pool" | "machine"; name?: string };
  url: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  latestRunId?: string;
  repos?: CursorCloudRepo[];
}

export interface CursorCloudRun {
  id: string;
  agentId: string;
  status: CursorCloudRunStatus;
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
  result?: string;
  git?: { branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }> };
}

export interface CursorCloudModel {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: Array<{ id: string; displayName?: string; values: Array<{ value: string; displayName?: string }> }>;
  variants?: Array<{ params: Array<{ id: string; value: string }>; displayName: string; description?: string; isDefault?: boolean }>;
}

export interface CursorCloudArtifact {
  path: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface CursorCloudTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface CursorCloudUsage {
  totalUsage: CursorCloudTokenUsage;
  runs: Array<{ id: string; usageUuid?: string; usage: CursorCloudTokenUsage }>;
}

export interface CursorCloudSseEvent {
  event: string;
  id?: string;
  data: unknown;
}

export interface CursorCloudRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CursorCloudMutationOptions extends CursorCloudRequestOptions {
  idempotencyKey?: string;
}

export interface CursorCloudStreamOptions extends CursorCloudRequestOptions {
  lastEventId?: string;
}

export interface CursorCloudClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  streamTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxSseFrameBytes?: number;
}

type ClientErrorCode = "configuration" | "invalid_request" | "http_error" | "network_error"
  | "invalid_response" | "payload_too_large" | "cancelled" | "timeout";

export class CursorCloudClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status?: number;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(code: ClientErrorCode, details: {
    status?: number; providerCode?: string; retryAfterMs?: number;
  } = {}) {
    super(`Cursor Cloud request failed (${code}${details.status ? `, HTTP ${details.status}` : ""}).`);
    this.name = "CursorCloudClientError";
    this.code = code;
    this.status = details.status;
    this.providerCode = details.providerCode;
    this.retryAfterMs = details.retryAfterMs;
    this.retryable = code === "network_error" || code === "timeout"
      || (details.status !== undefined && (details.status === 408 || details.status === 429 || details.status >= 500));
  }
}

// This private brand is minted only before fetch. The shared error code also
// describes oversized responses, downloads and SSE frames after dispatch.
class CursorCloudUnsentRequestError extends CursorCloudClientError {
  constructor() { super("payload_too_large"); }
}

export function isCursorCloudUnsentRequestError(error: unknown): boolean {
  return error instanceof CursorCloudUnsentRequestError;
}

const RUN_STATUSES = new Set<CursorCloudRunStatus>([
  "CREATING", "RUNNING", "WAITING_FOR_BACKGROUND_WORK", "FINISHED", "ERROR", "CANCELLED", "EXPIRED",
]);
const SAFE_PROVIDER_CODES = new Set([
  "validation_error", "unauthorized", "unauthenticated", "forbidden", "feature_unavailable",
  "not_found", "agent_not_found", "run_not_found", "agent_busy", "agent_archived", "agent_id_conflict",
  "run_not_cancellable", "invalid_model", "invalid_last_event_id", "stream_expired", "rate_limited",
  "rate_limit_exceeded", "internal_error", "repository_access", "key_not_supported", "integration_not_connected",
]);
const UUID_BODY = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const AGENT_ID = new RegExp(`^bc-${UUID_BODY}$`);
const RUN_ID = new RegExp(`^run-${UUID_BODY}$`);

export function isCursorCloudRunActive(status: CursorCloudRunStatus): boolean {
  return status === "CREATING" || status === "RUNNING" || status === "WAITING_FOR_BACKGROUND_WORK";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): never { throw new CursorCloudClientError("invalid_response"); }
function invalidRequest(): never { throw new CursorCloudClientError("invalid_request"); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function agentId(value: unknown): asserts value is string { if (typeof value !== "string" || !AGENT_ID.test(value)) invalidRequest(); }
function runId(value: unknown): asserts value is string { if (typeof value !== "string" || !RUN_ID.test(value)) invalidRequest(); }
function headerValue(value: string): string {
  if (!value || value.length > 1_024 || /[\r\n\0]/.test(value)) invalidRequest();
  return value;
}

function parseAgent(value: unknown, expectedId?: string): CursorCloudAgent {
  if (!record(value) || typeof value.id !== "string" || !AGENT_ID.test(value.id)
    || (expectedId !== undefined && value.id !== expectedId)
    || !["ACTIVE", "IDLE", "ARCHIVED"].includes(String(value.status))
    || !record(value.env) || !["cloud", "pool", "machine"].includes(String(value.env.type))
    || !nonempty(value.url) || !nonempty(value.createdAt) || !nonempty(value.updatedAt)
    || (value.latestRunId !== undefined && (typeof value.latestRunId !== "string" || !RUN_ID.test(value.latestRunId)))) invalidResponse();
  return value as unknown as CursorCloudAgent;
}

function parseRun(value: unknown, expectedAgentId?: string, expectedRunId?: string): CursorCloudRun {
  if (!record(value) || typeof value.id !== "string" || !RUN_ID.test(value.id)
    || typeof value.agentId !== "string" || !AGENT_ID.test(value.agentId)
    || (expectedAgentId !== undefined && value.agentId !== expectedAgentId)
    || (expectedRunId !== undefined && value.id !== expectedRunId)
    || !RUN_STATUSES.has(value.status as CursorCloudRunStatus)
    || !nonempty(value.createdAt) || !nonempty(value.updatedAt)
    || (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0))
    || (value.result !== undefined && typeof value.result !== "string")) invalidResponse();
  return value as unknown as CursorCloudRun;
}

function validatePrompt(input: CursorCloudFollowupInput): void {
  if (!record(input) || !record(input.prompt) || !nonempty(input.prompt.text)) invalidRequest();
  if (input.model !== undefined && (!record(input.model) || !nonempty(input.model.id))) invalidRequest();
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new CursorCloudClientError("configuration");
  return limit;
}

function requestScope(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    abort: () => { timedOut = true; controller.abort(); },
    error: () => new CursorCloudClientError(timedOut ? "timeout" : "cancelled"),
    dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); },
  };
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new CursorCloudClientError("payload_too_large");
  }
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new CursorCloudClientError("payload_too_large");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const bytes = await readBoundedBytes(response, maxBytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { invalidResponse(); }
}

export class CursorCloudClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestTimeoutMs: number;
  readonly #streamIdleTimeoutMs: number;
  readonly #streamTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxSseFrameBytes: number;

  constructor(options: CursorCloudClientOptions) {
    if (!nonempty(options.apiKey) || /[\r\n\0]/.test(options.apiKey)) throw new CursorCloudClientError("configuration");
    let base: URL;
    try { base = new URL(options.baseUrl ?? "https://api.cursor.com"); }
    catch { throw new CursorCloudClientError("configuration"); }
    if ((base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
      || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new CursorCloudClientError("configuration");
    this.#apiKey = options.apiKey;
    this.#baseUrl = base.origin;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = positiveLimit(options.requestTimeoutMs, 30_000);
    this.#streamIdleTimeoutMs = positiveLimit(options.streamIdleTimeoutMs, 60_000);
    this.#streamTimeoutMs = positiveLimit(options.streamTimeoutMs, 7_200_000);
    this.#maxRequestBytes = positiveLimit(options.maxRequestBytes, 2_097_152);
    this.#maxResponseBytes = positiveLimit(options.maxResponseBytes, 4_194_304);
    this.#maxSseFrameBytes = positiveLimit(options.maxSseFrameBytes, 1_048_576);
  }

  async createAgent(input: CursorCloudCreateInput, options: CursorCloudMutationOptions = {}): Promise<{ agent: CursorCloudAgent; run: CursorCloudRun }> {
    validatePrompt(input);
    if (input.agentId !== undefined) agentId(input.agentId);
    if (input.agentId !== undefined && input.envVars !== undefined) invalidRequest();
    const response = await this.#json("POST", "/v1/agents", input, options);
    if (!record(response)) invalidResponse();
    const agent = parseAgent(response.agent, input.agentId);
    const run = parseRun(response.run, agent.id);
    return { agent, run };
  }

  async createRun(id: string, input: CursorCloudFollowupInput, options: CursorCloudMutationOptions = {}): Promise<{ run: CursorCloudRun }> {
    agentId(id);
    validatePrompt(input);
    const response = await this.#json("POST", `/v1/agents/${id}/runs`, input, options);
    if (!record(response)) invalidResponse();
    return { run: parseRun(response.run, id) };
  }

  async getAgent(id: string, options: CursorCloudRequestOptions = {}): Promise<CursorCloudAgent> {
    agentId(id);
    return parseAgent(await this.#json("GET", `/v1/agents/${id}`, undefined, options), id);
  }

  async getRun(id: string, run: string, options: CursorCloudRequestOptions = {}): Promise<CursorCloudRun> {
    agentId(id); runId(run);
    return parseRun(await this.#json("GET", `/v1/agents/${id}/runs/${run}`, undefined, options), id, run);
  }

  async cancelRun(id: string, run: string, options: CursorCloudRequestOptions = {}): Promise<{ id: string }> {
    agentId(id); runId(run);
    return this.#idResponse(await this.#json("POST", `/v1/agents/${id}/runs/${run}/cancel`, undefined, options), run);
  }

  async deleteAgent(id: string, options: CursorCloudRequestOptions = {}): Promise<{ id: string }> {
    agentId(id);
    return this.#idResponse(await this.#json("DELETE", `/v1/agents/${id}`, undefined, options), id);
  }

  async listModels(options: CursorCloudRequestOptions = {}): Promise<{ items: CursorCloudModel[] }> {
    const response = await this.#json("GET", "/v1/models", undefined, options);
    if (!record(response) || !Array.isArray(response.items)
      || !response.items.every(item => record(item) && nonempty(item.id) && nonempty(item.displayName))) invalidResponse();
    return { items: response.items as CursorCloudModel[] };
  }

  async listArtifacts(id: string, options: CursorCloudRequestOptions = {}): Promise<{ items: CursorCloudArtifact[] }> {
    agentId(id);
    const response = await this.#json("GET", `/v1/agents/${id}/artifacts`, undefined, options);
    if (!record(response) || !Array.isArray(response.items) || response.items.length > 100
      || !response.items.every(item => record(item) && nonempty(item.path) && Number.isSafeInteger(item.sizeBytes)
        && Number(item.sizeBytes) >= 0 && nonempty(item.updatedAt))) invalidResponse();
    return { items: response.items as CursorCloudArtifact[] };
  }

  async getArtifactDownloadUrl(id: string, path: string, options: CursorCloudRequestOptions = {}): Promise<{ url: string; expiresAt: string }> {
    agentId(id);
    if (!nonempty(path) || path.startsWith("/") || /[\\\0]/.test(path) || path.split("/").some(segment => segment === "..")) invalidRequest();
    const response = await this.#json("GET", `/v1/agents/${id}/artifacts/download?${new URLSearchParams({ path })}`, undefined, options);
    if (!record(response) || !nonempty(response.url) || !nonempty(response.expiresAt)) invalidResponse();
    let url: URL;
    try { url = new URL(response.url); } catch { invalidResponse(); }
    if (url.protocol !== "https:" || url.username || url.password) invalidResponse();
    return { url: response.url, expiresAt: response.expiresAt };
  }

  async getUsage(id: string, query: { runId?: string } = {}, options: CursorCloudRequestOptions = {}): Promise<CursorCloudUsage> {
    agentId(id);
    if (query.runId !== undefined) runId(query.runId);
    const suffix = query.runId ? `?${new URLSearchParams({ runId: query.runId })}` : "";
    const response = await this.#json("GET", `/v1/agents/${id}/usage${suffix}`, undefined, options);
    const validUsage = (value: unknown): boolean => record(value)
      && ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens", "totalTokens"]
        .every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
    if (!record(response) || !validUsage(response.totalUsage) || !Array.isArray(response.runs)
      || !response.runs.every(item => record(item) && typeof item.id === "string" && RUN_ID.test(item.id)
        && (query.runId === undefined || item.id === query.runId) && validUsage(item.usage)
        && (item.usageUuid === undefined || nonempty(item.usageUuid)))) invalidResponse();
    return response as unknown as CursorCloudUsage;
  }

  async downloadArtifact(id: string, path: string, options: CursorCloudRequestOptions & { maxBytes?: number } = {}): Promise<Buffer> {
    const maxBytes = positiveLimit(options.maxBytes, 16_777_216);
    if (maxBytes > 16_777_216) invalidRequest();
    const scope = requestScope(options.signal, positiveLimit(options.timeoutMs, this.#requestTimeoutMs));
    try {
      const { url } = await this.getArtifactDownloadUrl(id, path, { ...options, signal: scope.signal });
      const target = new URL(url);
      if (target.hostname !== "agent-stores.s3.us-east-1.amazonaws.com" || target.port || target.protocol !== "https:") invalidResponse();
      if (scope.signal.aborted) throw scope.error();
      const response = await this.#fetch(url, { method: "GET", signal: scope.signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new CursorCloudClientError("http_error", { status: response.status });
      }
      return await readBoundedBytes(response, maxBytes);
    } catch (error) { throw this.#safeError(error, scope); }
    finally { scope.dispose(); }
  }

  async *streamRun(id: string, run: string, options: CursorCloudStreamOptions = {}): AsyncGenerator<CursorCloudSseEvent> {
    agentId(id); runId(run);
    const headers = this.#headers("text/event-stream");
    if (options.lastEventId !== undefined) headers["Last-Event-ID"] = headerValue(options.lastEventId);
    const scope = requestScope(options.signal, positiveLimit(options.timeoutMs, this.#streamTimeoutMs));
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(scope.abort, this.#streamIdleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdle();
    try {
      if (scope.signal.aborted) throw scope.error();
      const response = await this.#fetch(`${this.#baseUrl}/v1/agents/${id}/runs/${run}/stream`, {
        method: "GET", headers, signal: scope.signal, redirect: "error",
      });
      if (!response.ok) throw await this.#httpError(response);
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
        await response.body?.cancel().catch(() => {});
        invalidResponse();
      }
      reader = response.body.getReader();
      clearTimeout(idleTimer);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parser = new CursorCloudSseParser(this.#maxSseFrameBytes);
      while (true) {
        resetIdle();
        const chunk = await reader.read();
        clearTimeout(idleTimer);
        if (scope.signal.aborted) throw scope.error();
        if (chunk.done) { yield* parser.push(decoder.decode(), true); break; }
        for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          yield event;
          if (event.event === "done") return;
        }
      }
    } catch (error) { throw this.#safeError(error, scope); }
    finally {
      clearTimeout(idleTimer);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      scope.dispose();
    }
  }

  #idResponse(response: unknown, expected: string): { id: string } {
    if (!record(response) || response.id !== expected) invalidResponse();
    return { id: expected };
  }

  #headers(accept = "application/json"): Record<string, string> {
    return { Authorization: `Bearer ${this.#apiKey}`, Accept: accept };
  }

  async #json(method: string, path: string, input: unknown, options: CursorCloudMutationOptions): Promise<unknown> {
    const headers = this.#headers();
    let body: string | undefined;
    if (input !== undefined) {
      try { body = JSON.stringify(input); } catch { invalidRequest(); }
      if (Buffer.byteLength(body) > this.#maxRequestBytes) throw new CursorCloudUnsentRequestError();
      headers["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = headerValue(options.idempotencyKey);
    const scope = requestScope(options.signal, positiveLimit(options.timeoutMs, this.#requestTimeoutMs));
    try {
      if (scope.signal.aborted) throw scope.error();
      const response = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers, body, signal: scope.signal, redirect: "error" });
      if (!response.ok) throw await this.#httpError(response);
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        await response.body?.cancel().catch(() => {});
        invalidResponse();
      }
      const text = await readBoundedBody(response, this.#maxResponseBytes);
      try { return JSON.parse(text); } catch { invalidResponse(); }
    } catch (error) { throw this.#safeError(error, scope); }
    finally { scope.dispose(); }
  }

  #safeError(error: unknown, scope: ReturnType<typeof requestScope>): CursorCloudClientError {
    if (scope.signal.aborted) return scope.error();
    if (error instanceof CursorCloudClientError) return error;
    return new CursorCloudClientError(error instanceof TypeError ? "network_error" : "invalid_response");
  }

  async #httpError(response: Response): Promise<CursorCloudClientError> {
    let providerCode: string | undefined;
    try {
      const value: unknown = JSON.parse(await readBoundedBody(response, Math.min(this.#maxResponseBytes, 65_536)));
      const code = record(value) ? (record(value.error) ? value.error.code : value.code) : undefined;
      if (typeof code === "string" && SAFE_PROVIDER_CODES.has(code)) providerCode = code;
    } catch {  }
    const retryHeader = response.headers.get("retry-after");
    const delay = retryHeader && /^\d+(\.\d+)?$/.test(retryHeader) ? Number(retryHeader) * 1_000 : undefined;
    return new CursorCloudClientError("http_error", {
      status: response.status, providerCode,
      ...(delay !== undefined && Number.isFinite(delay) ? { retryAfterMs: Math.min(delay, 86_400_000) } : {}),
    });
  }
}

class CursorCloudSseParser {
  #buffer = "";
  #frameBytes = 0;
  #event = "";
  #id: string | undefined;
  #data: string[] = [];

  constructor(readonly maxBytes: number) {}

  *push(text: string, end = false): Generator<CursorCloudSseEvent> {
    this.#buffer += text;
    while (true) {
      const boundary = /[\r\n]/.exec(this.#buffer);
      if (!boundary || (!end && boundary.index === this.#buffer.length - 1 && boundary[0] === "\r")) break;
      const delimiter = this.#buffer.startsWith("\r\n", boundary.index) ? 2 : 1;
      const line = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + delimiter);
      this.#frameBytes += Buffer.byteLength(line) + delimiter;
      if (this.#frameBytes > this.maxBytes) throw new CursorCloudClientError("payload_too_large");
      if (!line) {
        const event = this.#finish();
        if (event) yield event;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") this.#event = value;
        if (field === "id" && !value.includes("\0")) this.#id = value;
        if (field === "data") this.#data.push(value);
      }
    }
    if (this.#frameBytes + Buffer.byteLength(this.#buffer) > this.maxBytes) throw new CursorCloudClientError("payload_too_large");
    if (end && this.#buffer) invalidResponse();
  }

  #finish(): CursorCloudSseEvent | undefined {
    let data: unknown = null;
    const event = this.#event || "message";
    const id = this.#id;
    const present = this.#data.length > 0 || this.#event.length > 0;
    if (this.#data.length) {
      try { data = JSON.parse(this.#data.join("\n")); } catch { invalidResponse(); }
    }
    this.#data = [];
    this.#event = "";
    this.#id = undefined;
    this.#frameBytes = 0;
    if (!present) return undefined;
    if (event.length > 128 || /[\0]/.test(event) || (id !== undefined && (id.length > 1_024 || /[\0]/.test(id)))) invalidResponse();
    return { event, ...(id !== undefined ? { id } : {}), data };
  }
}
