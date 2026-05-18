/**
 * Phase 4A-S4 (LET-366): live E2B HTTP transport.
 *
 * This module is the live counterpart to LET-351's `MockOnlyManagedSandboxTransport`.
 * It is only constructed once the three-gate fail-closed check in
 * `E2BSandboxProvider.acquireLease` (or any other live lifecycle entry point)
 * has resolved an E2B API key from the platform secret store and registered
 * that value into the pre-provider redaction registry. The transport itself
 * never reads `process.env` and never resolves secrets — it receives an
 * already-resolved API key and a redactor closure that has been primed with
 * that key.
 *
 * Wire protocol (post-QA remediation against E2B docs):
 *   Sandbox CRUD on api.e2b.app — header `X-API-Key: <apiKey>` (NOT Bearer).
 *   Process/exec on the sandbox-side envd host — Connect protocol with
 *   `Content-Type: application/connect+json`, `X-Access-Token: <envd-token>`,
 *   `Authorization: Basic <base64(apiKey)>`.
 *
 * Lifecycle mapping (LET-365 plan, default pilot policy):
 *   Paperclip acquireLease  → POST   {apiBase}/sandboxes            (E2B create)
 *   Paperclip start         → POST   {apiBase}/sandboxes/{id}/resume (E2B resume)
 *   Paperclip exec          → POST   {envdHost}/process.Process/Start (E2B Connect)
 *   Paperclip release       → DELETE {apiBase}/sandboxes/{id}        (pilot default; warm reuse is opt-in pause)
 *   Paperclip destroy       → DELETE {apiBase}/sandboxes/{id}
 *
 * `release` can be remapped to pause via `releaseMode: "pause"` once warm
 * reuse becomes part of pilot scope. The pilot default is `delete` to keep
 * cost accounting trivial.
 */

import { SandboxProviderError, throwIfAborted } from "./provider-contract.js";
import type {
  SandboxExecuteResult,
  SandboxProviderLogLine,
  SandboxProviderLogsResult,
  SandboxProviderStreamEvent,
} from "./provider-contract.js";
import type { PreProviderRedactionRegistry } from "./pre-provider-redaction.js";
import {
  redactArrayBeforeProvider,
  redactBeforeProvider,
  redactRecordBeforeProvider,
} from "./pre-provider-redaction.js";

export type E2BLiveReleaseMode = "delete" | "pause";

export interface E2BLiveTransportOptions {
  /** Resolved E2B API key bytes — never read from env. */
  apiKey: string;
  /** Base URL of the E2B control-plane HTTP surface (sandbox CRUD).
   *  Defaults to the public production host. */
  baseUrl?: string;
  /** Optional sandbox-side envd host template. Tests can override this so
   *  the captured `process.Process/Start` URL is deterministic. Supported
   *  placeholders: `{sandboxId}`, `{clientId}`, `{port}`. */
  envdHostTemplate?: string;
  /** Default envd port that the sandbox subdomain exposes. E2B uses 49983
   *  for the envd HTTP surface; the value is configurable so callers can
   *  pin a different port in development. */
  envdPort?: number;
  /** Injectable fetch (defaults to globalThis.fetch). Tests pass a mock. */
  fetchImpl?: typeof fetch;
  /** Pre-egress redaction registry primed with the resolved API key (and any
   *  per-run secrets). Applied to every string before the transport handles it. */
  redactor: PreProviderRedactionRegistry;
  /** Default lifecycle policy for `releaseSandbox`. Pilot default is "delete". */
  releaseMode?: E2BLiveReleaseMode;
  /** Optional outbound request hook for tests / audit capture. The hook runs
   *  AFTER redaction and BEFORE fetch is dispatched. */
  onRequest?: (request: E2BCapturedRequest) => void;
}

export interface E2BCapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

interface E2BCreateSandboxResponse {
  /** Documented field on api.e2b.app create response. */
  sandboxID?: string;
  /** Alias accepted defensively. */
  sandboxId?: string;
  id?: string;
  templateID?: string;
  clientID?: string;
  /** Token used by the sandbox-side envd Connect endpoint. */
  envdAccessToken?: string;
  domain?: string;
  state?: string;
  metadata?: Record<string, unknown>;
}

interface E2BResumeResponse {
  sandboxID?: string;
  sandboxId?: string;
  state?: string;
  metadata?: Record<string, unknown>;
}

interface E2BProcessStartResponse {
  /** Connect protocol unary response. Tests can assert this shape. */
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  /** Connect protocol may also return an `error` envelope for failed unary calls. */
  error?: { code?: string; message?: string };
}

interface E2BLogsResponse {
  lines?: Array<{ timestamp?: string; stream?: string; message?: string }>;
  nextCursor?: string | null;
  truncated?: boolean;
}

interface E2BEventsResponse {
  events?: Array<{ type?: string; timestamp?: string; data?: Record<string, unknown> }>;
}

const DEFAULT_BASE_URL = "https://api.e2b.app";
const DEFAULT_ENVD_HOST_TEMPLATE = "https://{port}-{sandboxId}.e2b.app";
const DEFAULT_ENVD_PORT = 49983;
const API_KEY_HEADER = "X-API-Key" as const;
const CONTENT_TYPE_HEADER = "Content-Type" as const;
const ACCEPT_HEADER = "Accept" as const;
const ACCESS_TOKEN_HEADER = "X-Access-Token" as const;
const BASIC_AUTH_HEADER = "Authorization" as const;
const CONNECT_CONTENT_TYPE = "application/connect+json" as const;
const PROCESS_START_PATH = "/process.Process/Start" as const;

function withTrailingSlashStripped(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isLogStream(value: unknown): value is SandboxProviderLogLine["stream"] {
  return value === "stdout" || value === "stderr" || value === "system";
}

function toBase64(value: string): string {
  // Use Buffer in Node; `btoa` would also work but Buffer is canonical here.
  return Buffer.from(value, "utf8").toString("base64");
}

interface E2BSandboxSession {
  clientId: string | null;
  envdAccessToken: string | null;
  domain: string | null;
}

/**
 * Constructs the live E2B HTTP transport. The shape mirrors the
 * `ManagedSandboxTransport` interface so the existing `E2BSandboxProvider`
 * lifecycle methods can swap from the mock-disabled placeholder to this
 * implementation without further branching at the provider layer.
 */
export class E2BLiveHttpTransport {
  readonly mode = "live-http" as const;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly redactor: PreProviderRedactionRegistry;
  private readonly releaseMode: E2BLiveReleaseMode;
  private readonly onRequest: ((request: E2BCapturedRequest) => void) | undefined;
  private readonly envdHostTemplate: string;
  private readonly envdPort: number;
  /** Per-sandbox session details parsed from the create response. We need
   *  clientId + envdAccessToken to talk to the sandbox-side envd Connect
   *  endpoint. The map is keyed by sandboxId so subsequent exec calls in
   *  the same provider instance can reuse them. */
  private readonly sessions = new Map<string, E2BSandboxSession>();

  constructor(options: E2BLiveTransportOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new SandboxProviderError(
        "PROVIDER_DISABLED",
        "E2B live transport requires a resolved API key.",
        { details: { provider: "e2b", reason: "missing_resolved_api_key" } },
      );
    }
    this.apiKey = options.apiKey;
    this.baseUrl = withTrailingSlashStripped(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.redactor = options.redactor;
    this.releaseMode = options.releaseMode ?? "delete";
    this.onRequest = options.onRequest;
    this.envdHostTemplate = options.envdHostTemplate ?? DEFAULT_ENVD_HOST_TEMPLATE;
    this.envdPort = options.envdPort ?? DEFAULT_ENVD_PORT;
  }

  async createSandbox(input: {
    config: {
      image?: string;
      snapshot?: string;
      template?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      region?: string;
      language?: string;
      resources?: Record<string, number>;
    };
    environmentId: string;
    heartbeatRunId: string;
    issueId: string | null;
  }): Promise<{ id: string; state: "created"; metadata: Record<string, unknown> }> {
    const redactedEnvVars = redactRecordBeforeProvider(input.config.env, this.redactor);
    // E2B documented create body: templateID, timeout (seconds), envVars, metadata.
    // Template precedence: explicit `template` → `image` (treated as templateID by
    // operators that key on image strings) → `snapshot` → undefined (server-side default).
    const templateID = this.redact(input.config.template ?? input.config.image ?? input.config.snapshot);
    const timeoutSeconds = typeof input.config.timeoutMs === "number"
      ? Math.max(1, Math.ceil(input.config.timeoutMs / 1000))
      : undefined;
    const body = {
      templateID,
      timeout: timeoutSeconds,
      envVars: redactedEnvVars,
      metadata: {
        environmentId: this.redact(input.environmentId),
        heartbeatRunId: this.redact(input.heartbeatRunId),
        issueId: this.redact(input.issueId ?? null),
        region: this.redact(input.config.region),
        language: this.redact(input.config.language),
        resources: input.config.resources,
      },
    };
    const response = await this.controlPlaneRequest<E2BCreateSandboxResponse>({
      method: "POST",
      path: "/sandboxes",
      body,
    });
    const sandboxId = response.sandboxID ?? response.sandboxId ?? response.id;
    if (typeof sandboxId !== "string" || sandboxId.length === 0) {
      throw new SandboxProviderError(
        "PROVIDER_FAILURE",
        "E2B create response did not include a sandbox id.",
        { details: { provider: "e2b" } },
      );
    }
    this.sessions.set(sandboxId, {
      clientId: typeof response.clientID === "string" ? response.clientID : null,
      envdAccessToken: typeof response.envdAccessToken === "string" ? response.envdAccessToken : null,
      domain: typeof response.domain === "string" ? response.domain : null,
    });
    return {
      id: sandboxId,
      state: "created",
      metadata: {
        ...(response.metadata ?? {}),
        provider: "e2b",
        sandboxState: response.state ?? "created",
        transport: this.mode,
        templateID: response.templateID ?? templateID ?? null,
        clientID: response.clientID ?? null,
      },
    };
  }

  async startSandbox(input: { sandboxId: string; signal?: AbortSignal }): Promise<{
    id: string;
    state: "running";
    metadata: Record<string, unknown>;
  }> {
    throwIfAborted(input.signal);
    const response = await this.controlPlaneRequest<E2BResumeResponse>({
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/resume`,
      body: {},
      signal: input.signal,
    });
    return {
      id: input.sandboxId,
      state: "running",
      metadata: {
        ...(response.metadata ?? {}),
        provider: "e2b",
        sandboxState: response.state ?? "running",
        transport: this.mode,
      },
    };
  }

  async executeCommand(input: {
    sandboxId: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecuteResult> {
    throwIfAborted(input.signal);
    const session = this.sessions.get(input.sandboxId) ?? {
      clientId: null,
      envdAccessToken: null,
      domain: null,
    };
    // E2B Connect-protocol request body for process.Process/Start. The argv
    // shape mirrors the public SDK (cmd + args + envs + cwd + stdin).
    const body = {
      process: {
        cmd: this.redact(input.command),
        args: redactArrayBeforeProvider(input.args, this.redactor),
        cwd: this.redact(input.cwd),
        envs: redactRecordBeforeProvider(input.env, this.redactor),
      },
      stdin: this.redact(input.stdin),
      timeout: typeof input.timeoutMs === "number" ? Math.max(1, Math.ceil(input.timeoutMs / 1000)) : undefined,
    };
    const url = this.envdHostFor(input.sandboxId, session.clientId);
    const response = await this.envdRequest<E2BProcessStartResponse>({
      method: "POST",
      url: `${url}${PROCESS_START_PATH}`,
      body,
      envdAccessToken: session.envdAccessToken,
      signal: input.signal,
    });
    if (response.error) {
      throw new SandboxProviderError(
        "PROVIDER_FAILURE",
        `E2B process.Process/Start returned error: ${response.error.message ?? response.error.code ?? "unknown"}`,
        { details: { provider: "e2b", connectError: response.error } },
      );
    }
    return {
      exitCode: typeof response.exitCode === "number" ? response.exitCode : null,
      stdout: typeof response.stdout === "string" ? response.stdout : "",
      stderr: typeof response.stderr === "string" ? response.stderr : "",
    };
  }

  async readLogs(input: {
    sandboxId: string;
    tail?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  }): Promise<SandboxProviderLogsResult> {
    throwIfAborted(input.signal);
    const query: string[] = [];
    if (typeof input.tail === "number" && input.tail > 0) {
      query.push(`tail=${input.tail}`);
    }
    if (typeof input.cursor === "string" && input.cursor.length > 0) {
      query.push(`cursor=${encodeURIComponent(this.redact(input.cursor))}`);
    }
    const queryString = query.length > 0 ? `?${query.join("&")}` : "";
    const response = await this.controlPlaneRequest<E2BLogsResponse>({
      method: "GET",
      path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/logs${queryString}`,
      signal: input.signal,
    });
    const lines: SandboxProviderLogLine[] = (response.lines ?? []).reduce<SandboxProviderLogLine[]>(
      (acc, entry) => {
        const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : nowIso();
        const stream = isLogStream(entry.stream) ? entry.stream : "system";
        const message = typeof entry.message === "string" ? entry.message : "";
        acc.push({ timestamp, stream, message });
        return acc;
      },
      [],
    );
    return {
      lines,
      nextCursor: response.nextCursor ?? null,
      truncated: response.truncated ?? false,
    };
  }

  async *streamEvents(input: {
    sandboxId: string;
    signal?: AbortSignal;
  }): AsyncIterable<SandboxProviderStreamEvent> {
    throwIfAborted(input.signal);
    const response = await this.controlPlaneRequest<E2BEventsResponse>({
      method: "GET",
      path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/events`,
      signal: input.signal,
    });
    for (const event of response.events ?? []) {
      if (!event || typeof event.type !== "string") continue;
      yield {
        type: event.type,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : nowIso(),
        data: { ...(event.data ?? {}), provider: "e2b", sandboxId: input.sandboxId },
      };
    }
  }

  async releaseSandbox(input: { sandboxId: string; reason?: string | null; signal?: AbortSignal }): Promise<void> {
    throwIfAborted(input.signal);
    if (this.releaseMode === "pause") {
      await this.controlPlaneRequest<unknown>({
        method: "POST",
        path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/pause`,
        body: { reason: this.redact(input.reason ?? null) },
        signal: input.signal,
      });
      return;
    }
    // Pilot default: release maps to delete (no warm reuse).
    await this.destroySandbox(input);
  }

  async destroySandbox(input: { sandboxId: string; signal?: AbortSignal }): Promise<void> {
    throwIfAborted(input.signal);
    await this.controlPlaneRequest<unknown>({
      method: "DELETE",
      path: `/sandboxes/${encodeURIComponent(input.sandboxId)}`,
      signal: input.signal,
    });
    this.sessions.delete(input.sandboxId);
  }

  private redact<T extends string | null | undefined>(value: T): T {
    if (typeof value !== "string") return value;
    return redactBeforeProvider(value, this.redactor) as T;
  }

  private envdHostFor(sandboxId: string, clientId: string | null): string {
    return this.envdHostTemplate
      .replace("{sandboxId}", encodeURIComponent(sandboxId))
      .replace("{clientId}", clientId ? encodeURIComponent(clientId) : "")
      .replace("{port}", String(this.envdPort));
  }

  /** Sandbox CRUD on api.e2b.app. Uses `X-API-Key` per E2B documentation. */
  private async controlPlaneRequest<T>(input: {
    method: string;
    path: string;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T> {
    const url = `${this.baseUrl}${input.path}`;
    const headers: Record<string, string> = {
      [API_KEY_HEADER]: this.apiKey,
      [ACCEPT_HEADER]: "application/json",
    };
    let serializedBody: string | null = null;
    if (input.body !== undefined) {
      headers[CONTENT_TYPE_HEADER] = "application/json";
      serializedBody = JSON.stringify(input.body ?? null);
    }
    return this.dispatch<T>({
      method: input.method,
      url,
      headers,
      serializedBody,
      signal: input.signal,
    });
  }

  /** Sandbox-side envd Connect endpoint. Uses Connect protocol headers per
   *  E2B documentation: Content-Type application/connect+json, X-Access-Token
   *  with the envd-issued token, and Authorization: Basic <base64(apiKey)>. */
  private async envdRequest<T>(input: {
    method: string;
    url: string;
    body: unknown;
    envdAccessToken: string | null;
    signal?: AbortSignal;
  }): Promise<T> {
    const headers: Record<string, string> = {
      [CONTENT_TYPE_HEADER]: CONNECT_CONTENT_TYPE,
      [ACCEPT_HEADER]: CONNECT_CONTENT_TYPE,
      [BASIC_AUTH_HEADER]: `Basic ${toBase64(this.apiKey)}`,
    };
    if (input.envdAccessToken !== null && input.envdAccessToken.length > 0) {
      headers[ACCESS_TOKEN_HEADER] = input.envdAccessToken;
    }
    const serializedBody = JSON.stringify(input.body ?? null);
    return this.dispatch<T>({
      method: input.method,
      url: input.url,
      headers,
      serializedBody,
      signal: input.signal,
    });
  }

  private async dispatch<T>(input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    serializedBody: string | null;
    signal?: AbortSignal;
  }): Promise<T> {
    // Capture the redacted view (auth/access-token stripped) for the test
    // hook — never expose the raw API key or envd token to callers, even
    // via the observability hook.
    if (this.onRequest) {
      this.onRequest({
        method: input.method,
        url: redactBeforeProvider(input.url, this.redactor),
        headers: redactCapturedHeaders(input.headers, this.apiKey, this.redactor),
        body: input.serializedBody === null ? null : redactBeforeProvider(input.serializedBody, this.redactor),
      });
    }
    const response = await this.fetchImpl(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.serializedBody ?? undefined,
      signal: input.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new SandboxProviderError(
        "CONFIG_INVALID",
        `E2B live transport rejected authentication (HTTP ${response.status}).`,
        { details: { provider: "e2b", status: response.status } },
      );
    }
    if (response.status === 404) {
      throw new SandboxProviderError(
        "LEASE_NOT_FOUND",
        `E2B live transport could not find the sandbox (HTTP 404).`,
        { details: { provider: "e2b", status: 404 } },
      );
    }
    if (response.status === 408 || response.status === 504) {
      throw new SandboxProviderError(
        "TIMEOUT",
        `E2B live transport timed out (HTTP ${response.status}).`,
        { retryable: true, details: { provider: "e2b", status: response.status } },
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new SandboxProviderError(
        "PROVIDER_FAILURE",
        `E2B live transport returned HTTP ${response.status}.`,
        { retryable: true, details: { provider: "e2b", status: response.status } },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SandboxProviderError(
        "PROVIDER_FAILURE",
        `E2B live transport returned HTTP ${response.status}.`,
        { details: { provider: "e2b", status: response.status } },
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SandboxProviderError(
        "PROVIDER_FAILURE",
        "E2B live transport returned a non-JSON response body.",
        { details: { provider: "e2b" } },
      );
    }
  }
}

function redactCapturedHeaders(
  headers: Record<string, string>,
  apiKey: string,
  registry: PreProviderRedactionRegistry,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === API_KEY_HEADER.toLowerCase()) {
      out[name] = "[REDACTED]";
      continue;
    }
    if (lower === BASIC_AUTH_HEADER.toLowerCase()) {
      out[name] = "Basic [REDACTED]";
      continue;
    }
    if (lower === ACCESS_TOKEN_HEADER.toLowerCase()) {
      out[name] = "[REDACTED]";
      continue;
    }
    let redacted = redactBeforeProvider(value, registry);
    if (apiKey.length > 0) redacted = redacted.split(apiKey).join("[REDACTED]");
    out[name] = redacted;
  }
  return out;
}
