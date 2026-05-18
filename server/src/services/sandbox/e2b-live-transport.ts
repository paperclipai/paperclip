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
 * Wire protocol (post-QA remediation against the official E2B JS SDK source
 * — `e2b@2.20.x`, `packages/js-sdk/dist/index.mjs`):
 *   Sandbox CRUD on api.e2b.app — header `X-API-Key: <apiKey>`.
 *   Sandbox connect on api.e2b.app — `POST /sandboxes/{id}/connect` returns
 *     `{ sandboxID, domain, envdVersion, envdAccessToken, trafficAccessToken }`.
 *   Process/exec on the sandbox-side envd host — Connect protocol with
 *     `Content-Type: application/connect+json`,
 *     `X-Access-Token: <envdAccessToken>`,
 *     optional `Authorization: Basic base64("<user>:")` ONLY when a sudo
 *     user is requested. The E2B API key is NOT sent as Basic auth — the
 *     envd channel is authorised by the access token returned from connect.
 *   Process start uses `cmd: "/bin/bash", args: ["-l", "-c", <combined>]`,
 *     mirroring `Commands.run` → `Commands.start` → `rpc.start` in the SDK.
 *   The Connect server-streaming response is parsed frame-by-frame
 *     (5-byte envelope: flags + uint32 BE length, end-of-stream flag bit 1)
 *     and aggregated into `{ exitCode, stdout, stderr }`.
 *
 * Lifecycle mapping (LET-365 plan, default pilot policy):
 *   Paperclip acquireLease  → POST   {apiBase}/sandboxes              (E2B create)
 *   Paperclip start         → POST   {apiBase}/sandboxes/{id}/connect (E2B connect/resume)
 *   Paperclip exec          → POST   {envdHost}/process.Process/Start (E2B Connect server-stream)
 *   Paperclip release       → DELETE {apiBase}/sandboxes/{id}         (pilot default; warm reuse is opt-in pause)
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
   *  placeholders: `{sandboxId}`, `{clientId}`, `{port}`, `{domain}`. */
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
  /** envd build version returned by create/connect. */
  envdVersion?: string;
  /** Sandbox-side domain (overrides `e2b.app` when set, e.g. for staging). */
  domain?: string;
  trafficAccessToken?: string;
  state?: string;
  metadata?: Record<string, unknown>;
}

interface E2BConnectResponse {
  sandboxID?: string;
  sandboxId?: string;
  id?: string;
  clientID?: string;
  envdAccessToken?: string;
  envdVersion?: string;
  domain?: string;
  trafficAccessToken?: string;
  state?: string;
  metadata?: Record<string, unknown>;
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
const DEFAULT_ENVD_HOST_TEMPLATE = "https://{port}-{sandboxId}.{domain}";
const DEFAULT_ENVD_PORT = 49983;
const DEFAULT_ENVD_DOMAIN = "e2b.app";
const API_KEY_HEADER = "X-API-Key" as const;
const CONTENT_TYPE_HEADER = "Content-Type" as const;
const ACCEPT_HEADER = "Accept" as const;
const ACCESS_TOKEN_HEADER = "X-Access-Token" as const;
const AUTHORIZATION_HEADER = "Authorization" as const;
const CONNECT_PROTOCOL_VERSION_HEADER = "Connect-Protocol-Version" as const;
const CONNECT_TIMEOUT_HEADER = "Connect-Timeout-Ms" as const;
const CONNECT_CONTENT_TYPE = "application/connect+json" as const;
const CONNECT_PROTOCOL_VERSION = "1" as const;
const PROCESS_START_PATH = "/process.Process/Start" as const;
const DEFAULT_BASH_COMMAND = "/bin/bash" as const;
const DEFAULT_BASH_ARGS = Object.freeze(["-l", "-c"]) as readonly string[];

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
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeBase64ToString(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

const SHELL_SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Shell-quote a single argument so it can be embedded into a bash -c string.
 *  Wraps in single quotes (literal) and escapes any embedded single quote. */
function shellQuoteArg(arg: string): string {
  if (arg.length > 0 && SHELL_SAFE_TOKEN.test(arg)) return arg;
  return `'${arg.split("'").join("'\"'\"'")}'`;
}

/** Combine the caller's command + args into a single bash command string,
 *  matching the SDK's `Commands.run(cmd)` → `cmd: '/bin/bash', args: ['-l', '-c', cmd]`. */
function buildBashCommand(command: string, args: string[] | undefined): string {
  if (!args || args.length === 0) return command;
  return [command, ...args.map(shellQuoteArg)].join(" ");
}

interface E2BSandboxSession {
  clientId: string | null;
  envdAccessToken: string | null;
  envdVersion: string | null;
  domain: string | null;
  trafficAccessToken: string | null;
}

const EMPTY_SESSION: E2BSandboxSession = Object.freeze({
  clientId: null,
  envdAccessToken: null,
  envdVersion: null,
  domain: null,
  trafficAccessToken: null,
});

/**
 * Encode a single Connect protocol envelope. Both directions of a Connect
 * streaming RPC wrap each message in this 5-byte envelope:
 *   byte 0      : flag byte (bit 1 / 0x02 = end-of-stream)
 *   bytes 1..4  : uint32 big-endian message length
 *   bytes 5..N  : payload bytes (here: JSON-encoded message)
 *
 * The official E2B JS SDK uses `createConnectTransport({ useBinaryFormat: false })`
 * which sends Start as one enveloped JSON request message; a real envd server
 * reads the flag + length prefix before parsing the payload. Sending raw
 * JSON without the envelope causes envd to interpret `{` as flag/length and
 * fail to parse. We therefore frame every envd request message via this
 * helper before handing the bytes to fetch.
 */
function encodeConnectFrame(payload: Uint8Array, endOfStream = false): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = endOfStream ? 0x02 : 0x00;
  const len = payload.length;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, 5);
  return out;
}

/**
 * Decode a Connect server-streaming response body. Each frame is a 5-byte
 * envelope (1 flag byte + 4-byte big-endian length) followed by `length`
 * payload bytes. The end-of-stream flag is bit 1 (0x02); the trailing frame
 * payload carries trailers (e.g. error metadata). All non-end frames are
 * collected as JSON message payloads.
 */
function decodeConnectStreamingBody(buffer: Uint8Array): {
  messages: unknown[];
  trailers: unknown | null;
} {
  const messages: unknown[] = [];
  let trailers: unknown | null = null;
  let offset = 0;
  const decoder = new TextDecoder("utf-8");
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset]!;
    const length =
      ((buffer[offset + 1]! << 24) >>> 0) |
      (buffer[offset + 2]! << 16) |
      (buffer[offset + 3]! << 8) |
      buffer[offset + 4]!;
    offset += 5;
    if (offset + length > buffer.length) break;
    const payloadBytes = buffer.subarray(offset, offset + length);
    offset += length;
    const text = decoder.decode(payloadBytes);
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if ((flags & 0x02) !== 0) {
      trailers = payload;
    } else {
      messages.push(payload);
    }
  }
  return { messages, trailers };
}

interface ProcessEventEnvelope {
  result?: {
    event?: ProcessEvent;
  };
  event?: ProcessEvent;
}

interface ProcessEvent {
  start?: { pid?: number };
  data?: { stdout?: string; stderr?: string };
  end?: { exitCode?: number; status?: string; error?: string };
  keepalive?: Record<string, never>;
}

function extractEvent(message: unknown): ProcessEvent | null {
  if (!message || typeof message !== "object") return null;
  const envelope = message as ProcessEventEnvelope;
  if (envelope.result && typeof envelope.result === "object" && envelope.result.event) {
    return envelope.result.event;
  }
  if (envelope.event && typeof envelope.event === "object") {
    return envelope.event;
  }
  return null;
}

function aggregateProcessEvents(
  messages: unknown[],
  trailers: unknown | null,
): SandboxExecuteResult {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let endError: string | null = null;
  for (const message of messages) {
    const event = extractEvent(message);
    if (!event) continue;
    if (event.data) {
      if (typeof event.data.stdout === "string" && event.data.stdout.length > 0) {
        stdout += decodeBase64ToString(event.data.stdout);
      }
      if (typeof event.data.stderr === "string" && event.data.stderr.length > 0) {
        stderr += decodeBase64ToString(event.data.stderr);
      }
    }
    if (event.end) {
      if (typeof event.end.exitCode === "number") {
        exitCode = event.end.exitCode;
      }
      if (typeof event.end.error === "string" && event.end.error.length > 0) {
        endError = event.end.error;
      }
    }
  }
  if (trailers && typeof trailers === "object") {
    const error = (trailers as { error?: { code?: string; message?: string } }).error;
    if (error && (error.code || error.message)) {
      throw new SandboxProviderError(
        "PROVIDER_FAILURE",
        `E2B Connect stream returned error: ${error.message ?? error.code ?? "unknown"}`,
        { details: { provider: "e2b", connectError: error } },
      );
    }
  }
  if (endError) {
    throw new SandboxProviderError(
      "PROVIDER_FAILURE",
      `E2B process.Process/Start end event reported error: ${endError}`,
      { details: { provider: "e2b", endError } },
    );
  }
  return { exitCode, stdout, stderr };
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
  /** Per-sandbox session details parsed from the create/connect response.
   *  We need envdAccessToken + domain to talk to the sandbox-side envd
   *  Connect endpoint. The map is keyed by sandboxId so subsequent exec
   *  calls in the same provider instance can reuse them. A fresh provider
   *  instance recovering a persisted lease will populate this lazily via
   *  `ensureSession()`, which issues a connect call before exec. */
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
    this.sessions.set(sandboxId, this.sessionFromCreate(response));
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
        domain: response.domain ?? null,
        envdVersion: response.envdVersion ?? null,
      },
    };
  }

  async startSandbox(input: { sandboxId: string; signal?: AbortSignal }): Promise<{
    id: string;
    state: "running";
    metadata: Record<string, unknown>;
  }> {
    throwIfAborted(input.signal);
    const session = await this.connectSandbox(input.sandboxId, input.signal);
    return {
      id: input.sandboxId,
      state: "running",
      metadata: {
        provider: "e2b",
        sandboxState: "running",
        transport: this.mode,
        domain: session.domain,
        envdVersion: session.envdVersion,
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
    user?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecuteResult> {
    throwIfAborted(input.signal);
    // E2B `StartRequest.stdin` is a boolean (whether the caller will write to
    // stdin), not stdin bytes. Real stdin data flows over the separate
    // `process.Process/SendInput` + `CloseStdin` RPCs after the start stream
    // returns a pid. Wiring that two-RPC flow is out of scope for the first
    // live slice (LET-366 pilot), so we fail closed when a caller hands us
    // stdin bytes rather than silently dropping the input. Follow-up tracked
    // separately in the Phase 4A-S4 plan; default-off CI never exercises this.
    if (typeof input.stdin === "string" && input.stdin.length > 0) {
      throw new SandboxProviderError(
        "CONFIG_INVALID",
        "E2B live transport does not yet support stdin input. " +
          "stdin data requires the separate process.Process/SendInput + CloseStdin RPC chain " +
          "which is not wired in the LET-366 pilot slice.",
        {
          details: {
            provider: "e2b",
            reason: "stdin_not_supported_in_live_pilot",
            followUp: "LET-365 plan B-series: wire SendInput/CloseStdin after pilot baseline.",
          },
        },
      );
    }
    // Lazy session refresh: a fresh provider instance recovering a persisted
    // lease may not yet have envdAccessToken/domain cached. Connect first to
    // populate them, then dispatch the Connect process.Process/Start request.
    const session = await this.ensureSession(input.sandboxId, input.signal);
    // Mirror the official SDK: `Commands.run(cmd)` → `Commands.start(cmd)`
    // → `rpc.start({ process: { cmd: '/bin/bash', args: ['-l', '-c', cmd] } })`.
    // The user's command + args are combined into a single shell string and
    // passed to bash via `-l -c <combined>`.
    const redactedCommand = this.redact(input.command);
    const redactedArgs = redactArrayBeforeProvider(input.args, this.redactor) ?? [];
    const combinedShellCommand = buildBashCommand(redactedCommand, redactedArgs);
    const body: Record<string, unknown> = {
      process: {
        cmd: DEFAULT_BASH_COMMAND,
        args: [...DEFAULT_BASH_ARGS, combinedShellCommand],
        cwd: this.redact(input.cwd),
        envs: redactRecordBeforeProvider(input.env, this.redactor),
      },
      // Matches `StartRequest.stdin?: boolean` in the SDK. Pilot slice never
      // streams stdin (rejected above), so this is always `false` here.
      stdin: false,
    };
    const url = this.envdHostFor(input.sandboxId, session);
    const buffer = await this.envdRequest({
      method: "POST",
      url: `${url}${PROCESS_START_PATH}`,
      body,
      session,
      user: input.user,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const { messages, trailers } = decodeConnectStreamingBody(buffer);
    return aggregateProcessEvents(messages, trailers);
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

  private sessionFromCreate(response: E2BCreateSandboxResponse): E2BSandboxSession {
    return {
      clientId: typeof response.clientID === "string" ? response.clientID : null,
      envdAccessToken: typeof response.envdAccessToken === "string" ? response.envdAccessToken : null,
      envdVersion: typeof response.envdVersion === "string" ? response.envdVersion : null,
      domain: typeof response.domain === "string" ? response.domain : null,
      trafficAccessToken:
        typeof response.trafficAccessToken === "string" ? response.trafficAccessToken : null,
    };
  }

  private sessionFromConnect(response: E2BConnectResponse): E2BSandboxSession {
    return {
      clientId: typeof response.clientID === "string" ? response.clientID : null,
      envdAccessToken: typeof response.envdAccessToken === "string" ? response.envdAccessToken : null,
      envdVersion: typeof response.envdVersion === "string" ? response.envdVersion : null,
      domain: typeof response.domain === "string" ? response.domain : null,
      trafficAccessToken:
        typeof response.trafficAccessToken === "string" ? response.trafficAccessToken : null,
    };
  }

  private async connectSandbox(sandboxId: string, signal?: AbortSignal): Promise<E2BSandboxSession> {
    const response = await this.controlPlaneRequest<E2BConnectResponse>({
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(sandboxId)}/connect`,
      body: {},
      signal,
    });
    const session = this.sessionFromConnect(response);
    this.sessions.set(sandboxId, session);
    return session;
  }

  /** Return the cached session for `sandboxId`, or call /connect to refresh
   *  when no envdAccessToken/domain has been observed yet. This is the
   *  persisted-lease recovery path: a fresh provider instance receives an
   *  existing providerLeaseId and needs envd session data before exec. */
  private async ensureSession(sandboxId: string, signal?: AbortSignal): Promise<E2BSandboxSession> {
    const cached = this.sessions.get(sandboxId);
    if (cached && cached.envdAccessToken && cached.domain) return cached;
    return await this.connectSandbox(sandboxId, signal);
  }

  private redact<T extends string | null | undefined>(value: T): T {
    if (typeof value !== "string") return value;
    return redactBeforeProvider(value, this.redactor) as T;
  }

  private envdHostFor(sandboxId: string, session: E2BSandboxSession): string {
    const domain = session.domain ?? DEFAULT_ENVD_DOMAIN;
    return this.envdHostTemplate
      .replace("{sandboxId}", encodeURIComponent(sandboxId))
      .replace("{clientId}", session.clientId ? encodeURIComponent(session.clientId) : "")
      .replace("{domain}", domain)
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
    return this.dispatchJson<T>({
      method: input.method,
      url,
      headers,
      serializedBody,
      signal: input.signal,
    });
  }

  /** Sandbox-side envd Connect endpoint. Uses Connect protocol headers per
   *  the official E2B JS SDK: Content-Type/Accept application/connect+json,
   *  Connect-Protocol-Version: 1, X-Access-Token from connect response, and
   *  optional Connect-Timeout-Ms when the caller supplied `timeoutMs`. The
   *  request body is wrapped in one Connect envelope (5-byte header + JSON
   *  payload) — a real envd server reads the flag/length prefix before
   *  parsing the payload, so a bare JSON body is rejected as a protocol
   *  error. Basic auth is omitted unless an explicit `user` is requested
   *  (mirrors `authenticationHeader(version, user)` in the SDK, which only
   *  sets Basic for the supplied user, never the API key). */
  private async envdRequest(input: {
    method: string;
    url: string;
    body: unknown;
    session: E2BSandboxSession;
    user?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    const headers: Record<string, string> = {
      [CONTENT_TYPE_HEADER]: CONNECT_CONTENT_TYPE,
      [ACCEPT_HEADER]: CONNECT_CONTENT_TYPE,
      [CONNECT_PROTOCOL_VERSION_HEADER]: CONNECT_PROTOCOL_VERSION,
    };
    if (input.session.envdAccessToken && input.session.envdAccessToken.length > 0) {
      headers[ACCESS_TOKEN_HEADER] = input.session.envdAccessToken;
    }
    if (typeof input.user === "string" && input.user.length > 0) {
      // SDK semantics: `Basic base64("<user>:")` — the API key is never used as Basic auth.
      headers[AUTHORIZATION_HEADER] = `Basic ${toBase64(`${input.user}:`)}`;
    }
    if (
      typeof input.timeoutMs === "number" &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs > 0
    ) {
      // Connect protocol propagates per-request deadlines via this header.
      // The official SDK passes `timeoutMs` as an RPC option which the
      // generated transport translates into the same header. We do the
      // mapping ourselves so envd honours the caller's timeout contract
      // even before the AbortSignal fires.
    headers[CONNECT_TIMEOUT_HEADER] = String(Math.ceil(input.timeoutMs));
    }
    // Frame the request body as one Connect envelope (flag=0, end-of-stream=false).
    // The captured-hook projection still shows the JSON payload as a string so
    // observability stays human-readable; only the bytes handed to fetch are
    // the binary envelope.
    const payloadJson = JSON.stringify(input.body ?? {});
    const framedBody = encodeConnectFrame(new TextEncoder().encode(payloadJson), false);
    return this.dispatchEnvelopeStream({
      method: input.method,
      url: input.url,
      headers,
      framedBody,
      capturedPayloadJson: payloadJson,
      signal: input.signal,
    });
  }

  private capture(input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    capturedBodyString: string | null;
  }): void {
    if (!this.onRequest) return;
    this.onRequest({
      method: input.method,
      url: redactBeforeProvider(input.url, this.redactor),
      headers: redactCapturedHeaders(input.headers, this.apiKey, this.redactor),
      body:
        input.capturedBodyString === null
          ? null
          : redactBeforeProvider(input.capturedBodyString, this.redactor),
    });
  }

  private async fetchWithStatusGuard(input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: BodyInit | undefined;
    signal?: AbortSignal;
  }): Promise<Response> {
    const response = await this.fetchImpl(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
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
    return response;
  }

  private async dispatchJson<T>(input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    serializedBody: string | null;
    signal?: AbortSignal;
  }): Promise<T> {
    this.capture({
      method: input.method,
      url: input.url,
      headers: input.headers,
      capturedBodyString: input.serializedBody,
    });
    const response = await this.fetchWithStatusGuard({
      method: input.method,
      url: input.url,
      headers: input.headers,
      body: input.serializedBody ?? undefined,
      signal: input.signal,
    });
    if (response.status === 204) return undefined as T;
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

  private async dispatchEnvelopeStream(input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    framedBody: Uint8Array;
    capturedPayloadJson: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    this.capture({
      method: input.method,
      url: input.url,
      headers: input.headers,
      capturedBodyString: input.capturedPayloadJson,
    });
    const response = await this.fetchWithStatusGuard({
      method: input.method,
      url: input.url,
      headers: input.headers,
      body: input.framedBody as BodyInit,
      signal: input.signal,
    });
    if (response.status === 204) return new Uint8Array(0);
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
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
    if (lower === AUTHORIZATION_HEADER.toLowerCase()) {
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

export const __testing = {
  decodeConnectStreamingBody,
  encodeConnectFrame,
  aggregateProcessEvents,
  buildBashCommand,
  shellQuoteArg,
  EMPTY_SESSION,
};
