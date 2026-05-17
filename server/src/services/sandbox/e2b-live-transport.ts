/**
 * Phase 4A-S4 (LET-366): live E2B HTTP transport.
 *
 * This module is the live counterpart to LET-351's `MockOnlyManagedSandboxTransport`.
 * It is only constructed once the three-gate fail-closed check in
 * `E2BSandboxProvider.acquireLease` has resolved an E2B API key from the
 * platform secret store and registered that value into the pre-provider
 * redaction registry. The transport itself never reads `process.env` and
 * never resolves secrets — it receives an already-resolved API key and a
 * redactor closure that has been primed with that key.
 *
 * Lifecycle mapping (per LET-365 plan, default pilot policy):
 *   Paperclip acquireLease  → POST {baseUrl}/sandboxes        (E2B create)
 *   Paperclip start         → POST {baseUrl}/sandboxes/{id}/resume
 *   Paperclip exec          → POST {baseUrl}/sandboxes/{id}/commands
 *   Paperclip release       → DELETE {baseUrl}/sandboxes/{id} (default delete, no warm reuse)
 *   Paperclip destroy       → DELETE {baseUrl}/sandboxes/{id}
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
  /** Base URL of the E2B HTTP surface. Defaults to the public production host. */
  baseUrl?: string;
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

interface E2BSandboxRecordResponse {
  id?: string;
  sandboxId?: string;
  state?: string;
  metadata?: Record<string, unknown>;
}

interface E2BExecuteResponse {
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
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
const AUTH_HEADER = "Authorization" as const;
const CONTENT_TYPE_HEADER = "Content-Type" as const;
const ACCEPT_HEADER = "Accept" as const;

function withTrailingSlashStripped(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isLogStream(value: unknown): value is SandboxProviderLogLine["stream"] {
  return value === "stdout" || value === "stderr" || value === "system";
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
    const redactedEnv = redactRecordBeforeProvider(input.config.env, this.redactor);
    const body = {
      image: this.redact(input.config.image),
      snapshot: this.redact(input.config.snapshot),
      template: this.redact(input.config.template),
      timeoutMs: input.config.timeoutMs,
      region: this.redact(input.config.region),
      language: this.redact(input.config.language),
      resources: input.config.resources,
      env: redactedEnv,
      metadata: {
        environmentId: this.redact(input.environmentId),
        heartbeatRunId: this.redact(input.heartbeatRunId),
        issueId: this.redact(input.issueId ?? null),
      },
    };
    const response = await this.request<E2BSandboxRecordResponse>({
      method: "POST",
      path: "/sandboxes",
      body,
    });
    const sandboxId = response.id ?? response.sandboxId;
    if (typeof sandboxId !== "string" || sandboxId.length === 0) {
      throw new SandboxProviderError(
        "PROVIDER_FAILURE",
        "E2B create response did not include a sandbox id.",
        { details: { provider: "e2b" } },
      );
    }
    return {
      id: sandboxId,
      state: "created",
      metadata: {
        ...(response.metadata ?? {}),
        provider: "e2b",
        sandboxState: response.state ?? "created",
        transport: this.mode,
      },
    };
  }

  async startSandbox(input: { sandboxId: string; signal?: AbortSignal }): Promise<{
    id: string;
    state: "running";
    metadata: Record<string, unknown>;
  }> {
    throwIfAborted(input.signal);
    const response = await this.request<E2BSandboxRecordResponse>({
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
    const body = {
      command: this.redact(input.command),
      args: redactArrayBeforeProvider(input.args, this.redactor),
      cwd: this.redact(input.cwd),
      env: redactRecordBeforeProvider(input.env, this.redactor),
      stdin: this.redact(input.stdin),
      timeoutMs: input.timeoutMs,
    };
    const response = await this.request<E2BExecuteResponse>({
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(input.sandboxId)}/commands`,
      body,
      signal: input.signal,
    });
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
    const response = await this.request<E2BLogsResponse>({
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
    const response = await this.request<E2BEventsResponse>({
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
      await this.request<unknown>({
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
    await this.request<unknown>({
      method: "DELETE",
      path: `/sandboxes/${encodeURIComponent(input.sandboxId)}`,
      signal: input.signal,
    });
  }

  private redact<T extends string | null | undefined>(value: T): T {
    if (typeof value !== "string") return value;
    return redactBeforeProvider(value, this.redactor) as T;
  }

  private async request<T>(input: {
    method: string;
    path: string;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T> {
    const url = `${this.baseUrl}${input.path}`;
    const headers: Record<string, string> = {
      [AUTH_HEADER]: `Bearer ${this.apiKey}`,
      [ACCEPT_HEADER]: "application/json",
    };
    let serializedBody: string | null = null;
    if (input.body !== undefined) {
      headers[CONTENT_TYPE_HEADER] = "application/json";
      serializedBody = JSON.stringify(input.body ?? null);
    }
    // Capture the redacted view (auth header stripped) for the test hook —
    // never expose the raw bearer token to callers, even via the hook.
    if (this.onRequest) {
      this.onRequest({
        method: input.method,
        url: redactBeforeProvider(url, this.redactor),
        headers: redactCapturedHeaders(headers, this.apiKey, this.redactor),
        body: serializedBody === null ? null : redactBeforeProvider(serializedBody, this.redactor),
      });
    }
    const response = await this.fetchImpl(url, {
      method: input.method,
      headers,
      body: serializedBody ?? undefined,
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
    if (name.toLowerCase() === AUTH_HEADER.toLowerCase()) {
      out[name] = "Bearer [REDACTED]";
      continue;
    }
    let redacted = redactBeforeProvider(value, registry);
    if (apiKey.length > 0) redacted = redacted.split(apiKey).join("[REDACTED]");
    out[name] = redacted;
  }
  return out;
}
