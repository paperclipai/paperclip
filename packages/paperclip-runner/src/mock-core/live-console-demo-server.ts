import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  parseHarnessRuntimeRequestResolution,
  type HarnessDriver,
  type HarnessGoalOperation,
  type HarnessRuntimeRequestResolution,
  type HarnessSession,
} from "../contracts/harness-driver.js";
import {
  createCodexTaskEnvelope,
  type CodexTaskEnvelope,
} from "../contracts/codex.js";
import type { NativeSessionCapabilities } from "../contracts/types.js";
import {
  validatePrpEvent,
  type PrpCapabilities,
  type PrpEvent,
} from "../protocol/replay-contract.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
} from "../reducer/session-reducer.js";
import { redactCodexDiagnostic } from "../drivers/codex/app-server-transport.js";

const MAX_BROWSER_BODY_BYTES = 64 * 1024;
const MAX_BROWSER_EVENTS = 4096;
const MAX_BROWSER_STRING_CHARACTERS = 16 * 1024;
const MAX_BROWSER_TOTAL_STRING_CHARACTERS = 512 * 1024;
const MAX_BROWSER_VALUE_NODES = 65_536;
const MAX_BROWSER_SERIALIZED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ACTIVE_SESSIONS = 16;
const DEFAULT_MAX_SESSION_SUBSCRIBERS = 4;
const MAX_CONFIGURED_ACTIVE_SESSIONS = 64;
const MAX_CONFIGURED_SESSION_SUBSCRIBERS = 16;

const LOOPBACK_ONLY = "Live console transport is available only over loopback";

class LiveConsoleHttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LiveConsoleHttpError";
    this.code = code;
    this.status = status;
  }
}

export interface LiveConsoleDemoServerOptions {
  workingDirectory: string;
  driverFactory: (
    envelope: CodexTaskEnvelope,
    manifestId?: string,
  ) => HarnessDriver;
  host?: string;
  port?: number;
  /** Demo-chat manifests the browser lists; the server owns the catalogue. */
  manifests?: readonly unknown[];
  /** May reduce, but never raise, the package hard limit. */
  maxActiveSessions?: number;
  /** May reduce, but never raise, the package hard limit. */
  maxSessionSubscribers?: number;
}

interface DemoEntry {
  id: string;
  runId: string;
  normalizedSessionId: string;
  manifestId: string | null;
  envelope: CodexTaskEnvelope;
  driver: HarnessDriver;
  session: HarnessSession;
  capabilities: NativeSessionCapabilities;
  events: PrpEvent[];
  subscribers: Set<ServerResponse>;
  consumeTask: Promise<void>;
}

interface BrowserCreateBody {
  objective?: string;
  message?: string;
  manifest?: string;
  startTurn?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface BrowserSafeBudget {
  nodesRemaining: number;
  stringCharactersRemaining: number;
}

const BROWSER_SAFE_CREDENTIAL_METADATA_KEYS = new Set([
  "credentialsexposed",
  "providerauthentication",
]);

const BROWSER_SAFE_USAGE_KEYS = new Set([
  "cachedinputtokens",
  "inputtokens",
  "outputtokens",
  "reasoningoutputtokens",
  "tokenbudget",
  "tokensused",
  "tokenusage",
  "totaltokens",
]);

function browserSafe(value: unknown): unknown {
  return browserSafeValue(value, 0, {
    nodesRemaining: MAX_BROWSER_VALUE_NODES,
    stringCharactersRemaining: MAX_BROWSER_TOTAL_STRING_CHARACTERS,
  });
}

function browserSafeValue(value: unknown, depth: number, budget: BrowserSafeBudget): unknown {
  if (depth > 10) return "[TRUNCATED]";
  if (budget.nodesRemaining <= 0) return "[TRUNCATED]";
  budget.nodesRemaining -= 1;
  if (typeof value === "string") {
    const redacted = redactBrowserString(value);
    const allowedCharacters = Math.min(
      redacted.length,
      budget.stringCharactersRemaining,
    );
    budget.stringCharactersRemaining -= allowedCharacters;
    return allowedCharacters === redacted.length
      ? redacted
      : `${redacted.slice(0, allowedCharacters)}[TRUNCATED]`;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 256)
      .map((entry) => browserSafeValue(entry, depth + 1, budget));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).slice(0, 256).map(([key, entry]) => [
      key,
      isSensitiveBrowserEntry(key, entry)
        ? "[REDACTED]"
        : browserSafeValue(entry, depth + 1, budget),
    ]),
  );
}

/**
 * Hides absolute host paths under any home root. The provider names its own
 * state directories in session context — `.codex/memories` as well as
 * `.paperclip` — and none of them mean anything to a browser.
 */
function redactBrowserString(value: string): string {
  const truncated = value.length > MAX_BROWSER_STRING_CHARACTERS;
  const visible = truncated ? value.slice(0, MAX_BROWSER_STRING_CHARACTERS) : value;
  const redacted = redactStructuredBrowserCredentials(redactCodexDiagnostic(visible)).replace(
    /\/(?:srv\/paperclip\/home|home\/[^/\s]+|Users\/[^/\s]+)\/\.[^\s"'<>),\]}]*/g,
    "<server-path>",
  );
  return truncated ? `${redacted}[TRUNCATED]` : redacted;
}

function isSensitiveBrowserKey(key: string): boolean {
  const normalized = normalizeBrowserKey(key);
  if (
    BROWSER_SAFE_CREDENTIAL_METADATA_KEYS.has(normalized) ||
    BROWSER_SAFE_USAGE_KEYS.has(normalized)
  ) {
    return false;
  }
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) =>
    [
      "authorization",
      "cookie",
      "cookies",
      "credential",
      "credentials",
      "passwd",
      "passwds",
      "password",
      "passwords",
      "secret",
      "secrets",
      "token",
      "tokens",
    ].includes(word)
  )) {
    return true;
  }
  if (words.some((word, index) =>
    ["access", "api", "private", "signing"].includes(word) &&
    ["key", "keys"].includes(words[index + 1] ?? "")
  )) {
    return true;
  }
  return /(?:apikeys?|accesskeys?|privatekeys?|signingkeys?|credentials?|passwds?|passwords?|secrets?|tokens?)$/.test(
    normalized,
  );
}

function isSensitiveBrowserEntry(key: string, value: unknown): boolean {
  const normalized = normalizeBrowserKey(key);
  if (normalized === "credentialsexposed") return typeof value !== "boolean";
  if (normalized === "providerauthentication") return value !== "server-side";
  if (BROWSER_SAFE_USAGE_KEYS.has(normalized)) {
    if (normalized === "tokenusage") return !isBrowserRecord(value);
    if (normalized === "tokenbudget" && value === null) return false;
    return typeof value !== "number" || !Number.isFinite(value);
  }
  return isSensitiveBrowserKey(key);
}

function isBrowserRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBrowserKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function redactStructuredBrowserCredentials(value: string): string {
  return value
    .replace(
      /(["'])([A-Za-z][A-Za-z0-9_-]{0,127})\1(\s*:\s*)(["'])([^"'\r\n]*)/g,
      (
        match,
        keyQuote: string,
        key: string,
        separator: string,
        valueQuote: string,
        fieldValue: string,
      ) =>
        isSensitiveBrowserDiagnosticField(key, fieldValue)
          ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]`
          : match,
    )
    .replace(
      /\b([A-Za-z][A-Za-z0-9_-]{0,127})(\s*[=:]\s*)([^\s,;}\]]+)/g,
      (match, key: string, separator: string, fieldValue: string) =>
        isSensitiveBrowserDiagnosticField(key, fieldValue)
          ? `${key}${separator}[REDACTED]`
          : match,
    );
}

function isSensitiveBrowserDiagnosticField(key: string, value: string): boolean {
  const normalized = normalizeBrowserKey(key);
  if (normalized === "credentialsexposed") return !/^(?:true|false)$/i.test(value);
  if (normalized === "providerauthentication") return value !== "server-side";
  if (BROWSER_SAFE_USAGE_KEYS.has(normalized)) {
    if (normalized === "tokenusage") return true;
    if (normalized === "tokenbudget" && value === "null") return false;
    return !/^-?\d+(?:\.\d+)?$/.test(value);
  }
  return isSensitiveBrowserKey(key);
}

function serializeBrowserJson(body: unknown): { serialized: string; overflow: boolean } {
  const serialized = JSON.stringify(browserSafe(body)) ?? "null";
  if (Buffer.byteLength(serialized) <= MAX_BROWSER_SERIALIZED_BYTES) {
    return { serialized, overflow: false };
  }
  return {
    serialized: JSON.stringify({
      error: "browser_response_too_large",
      message: `Browser response exceeded ${MAX_BROWSER_SERIALIZED_BYTES} bytes`,
    }),
    overflow: true,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const { serialized, overflow } = serializeBrowserJson(body);
  response.writeHead(overflow ? 413 : status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(serialized),
    "x-content-type-options": "nosniff",
  });
  response.end(serialized);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BROWSER_BODY_BYTES) throw new Error("browser request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("browser request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function prpCapabilities(capabilities: NativeSessionCapabilities): PrpCapabilities {
  return {
    schema: "paperclip.prp.capabilities.v1",
    sessionReusePolicy: "reuse_per_issue",
    driver: { kind: "live-console-demo", version: "1" },
    steer: capabilities.steering,
    interrupt: capabilities.interruption,
    resume: capabilities.resume,
    runtimeRequests: capabilities.runtimeRequestResolution ?? false,
    structuredResult: capabilities.structuredResult,
    typedEvents: capabilities.typedEvents,
    goals: capabilities.goals ?? false,
    threadLineage: capabilities.threadLineage ?? false,
    ...(capabilities.unsupported?.length ? { unsupported: capabilities.unsupported } : {}),
  };
}

/**
 * Splits first, then decodes, so a percent-encoded reserved character stays
 * inside the segment the browser meant it for. Upstream request identities are
 * opaque and may contain `/`, `?`, or `#`.
 */
function pathParts(request: IncomingMessage): string[] {
  const url = new URL(request.url ?? "/", "http://liveConsole.invalid");
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new LiveConsoleHttpError(
          400,
          "invalid_path_encoding",
          "Live console path segments must be valid percent-encoded UTF-8",
        );
      }
    });
}

function errorStatus(error: unknown): number {
  if (error instanceof LiveConsoleHttpError) return error.status;
  const code = record(error).code;
  if (code === "stale_turn" || code === "already_terminal") return 409;
  return 400;
}

function errorCode(error: unknown): string {
  if (error instanceof LiveConsoleHttpError) return error.code;
  return String(record(error).code ?? "invalid_request");
}

function isLoopbackAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "localhost") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/** Reject wildcard and LAN binds before a provider-capable server starts. */
export function assertLiveConsoleLoopbackBindHost(host: string): void {
  if (!isLoopbackAddress(host)) {
    throw new LiveConsoleHttpError(403, "non_loopback_bind_forbidden", LOOPBACK_ONLY);
  }
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

function expectedAuthority(host: string, port: number): string {
  const normalized = normalizedHost(host);
  return normalized.includes(":") ? `[${normalized}]:${port}` : `${normalized}:${port}`;
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasValidCapability(request: IncomingMessage, capability: string): boolean {
  const authorization = singleHeader(request.headers.authorization);
  if (authorization === null) return false;
  const expected = Buffer.from(`Bearer ${capability}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireTransportAdmission(
  request: IncomingMessage,
  bindHost: string,
  capability: string,
): void {
  if (
    !isLoopbackAddress(request.socket.localAddress) ||
    !isLoopbackAddress(request.socket.remoteAddress)
  ) {
    throw new LiveConsoleHttpError(403, "loopback_required", LOOPBACK_ONLY);
  }

  const port = request.socket.localPort;
  const host = singleHeader(request.headers.host);
  if (port === undefined || host === null || host.toLowerCase() !== expectedAuthority(bindHost, port)) {
    throw new LiveConsoleHttpError(
      403,
      "invalid_host",
      "Live console requests require the exact loopback host and listening port",
    );
  }

  const authorization = singleHeader(request.headers.authorization);
  const authenticatedDirectRequest = hasValidCapability(request, capability);
  if (authorization !== null && !authenticatedDirectRequest) {
    throw new LiveConsoleHttpError(401, "invalid_transport_capability", "Invalid Live console capability");
  }

  const mutation = !["GET", "HEAD"].includes(request.method ?? "GET");
  if (mutation) {
    const mediaType = singleHeader(request.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new LiveConsoleHttpError(
        415,
        "json_content_type_required",
        "Live console mutations require application/json",
      );
    }
  }
  if (authenticatedDirectRequest) return;

  const fetchSite = singleHeader(request.headers["sec-fetch-site"]);
  if (fetchSite !== "same-origin") {
    throw new LiveConsoleHttpError(
      403,
      "invalid_fetch_metadata",
      "Live console browser requests require Sec-Fetch-Site: same-origin",
    );
  }

  const origin = singleHeader(request.headers.origin);
  if (origin !== null && origin !== `http://${host.toLowerCase()}`) {
    throw new LiveConsoleHttpError(403, "invalid_origin", "Live console cross-origin requests are forbidden");
  }
  // Only mutations are required to name their origin. A same-origin `GET` —
  // which is what the `EventSource` stream is — sends no `Origin` header at
  // all, so demanding one there rejects the console's own subscription;
  // `Sec-Fetch-Site: same-origin` above is what proves that request safe.
  if (mutation && origin === null) {
    throw new LiveConsoleHttpError(403, "origin_required", "Live console browser request Origin is required");
  }
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return resolved;
}

function browserCredentialField(body: Record<string, unknown>): string | null {
  return Object.keys(body).find((key) => isSensitiveBrowserKey(key)) ?? null;
}

export class LiveConsoleDemoServer {
  readonly #options: Required<Pick<LiveConsoleDemoServerOptions, "host" | "port">> &
    Omit<LiveConsoleDemoServerOptions, "host" | "port">;
  readonly #entries = new Map<string, DemoEntry>();
  readonly #transportCapability = randomBytes(32).toString("base64url");
  readonly #maxActiveSessions: number;
  readonly #maxSessionSubscribers: number;
  #creatingSessions = 0;
  #server: Server | null = null;

  constructor(options: LiveConsoleDemoServerOptions) {
    this.#options = {
      ...options,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
    };
    this.#maxActiveSessions = boundedOption(
      options.maxActiveSessions,
      DEFAULT_MAX_ACTIVE_SESSIONS,
      MAX_CONFIGURED_ACTIVE_SESSIONS,
      "maxActiveSessions",
    );
    this.#maxSessionSubscribers = boundedOption(
      options.maxSessionSubscribers,
      DEFAULT_MAX_SESSION_SUBSCRIBERS,
      MAX_CONFIGURED_SESSION_SUBSCRIBERS,
      "maxSessionSubscribers",
    );
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.#server !== null) throw new Error("Live console demo server is already started");
    assertLiveConsoleLoopbackBindHost(this.#options.host);
    this.#server = createServer(this.middleware());
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#options.port, this.#options.host, () => resolve());
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Live console demo server did not bind a TCP address");
    }
    return {
      host: this.#options.host,
      port: address.port,
      url: `http://${expectedAuthority(this.#options.host, address.port)}`,
    };
  }

  /** Server-side automation can authenticate without browser-controlled headers. */
  directApiAuthorization(): string {
    return `Bearer ${this.#transportCapability}`;
  }

  /**
   * The same handler `start()` binds, so an embedding dev server (the Vite
   * plugin) can mount the identical routes without a second implementation.
   */
  middleware(): (request: IncomingMessage, response: ServerResponse) => void {
    return (request, response) => {
      try {
        assertLiveConsoleLoopbackBindHost(this.#options.host);
        requireTransportAdmission(request, this.#options.host, this.#transportCapability);
      } catch (error) {
        json(response, errorStatus(error), {
          error: errorCode(error),
          message: String(error instanceof Error ? error.message : error),
        });
        return;
      }
      void this.#handle(request, response).catch((error) => {
        if (!response.headersSent) {
          json(response, errorStatus(error), {
            error: errorCode(error),
            message: String(error),
          });
        } else {
          response.end();
        }
      });
    };
  }

  async close(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (entry) => {
      for (const subscriber of entry.subscribers) subscriber.end();
      await entry.session.close({ reason: "demo_server_closed" });
      await entry.consumeTask.catch(() => undefined);
    }));
    if (this.#server === null) return;
    const server = this.#server;
    this.#server = null;
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parts = pathParts(request);
    if (request.method === "GET" && parts.join("/") === "api/liveConsole/health") {
      json(response, 200, {
        status: "ok",
        boundary: "package-local-mock-core",
        providerAuthentication: "server-side",
        credentialsExposed: false,
      });
      return;
    }
    if (request.method === "GET" && parts.join("/") === "api/liveConsole/manifests") {
      json(response, 200, { manifests: this.#options.manifests ?? [] });
      return;
    }
    if (request.method === "POST" && parts.join("/") === "api/liveConsole/sessions") {
      const body = await readJson(request) as BrowserCreateBody & Record<string, unknown>;
      const credentialField = browserCredentialField(body);
      if (credentialField !== null) {
        throw new LiveConsoleHttpError(
          422,
          "browser_credentials_forbidden",
          `Browser bodies cannot provide credentials (${credentialField})`,
        );
      }
      if (this.#entries.size + this.#creatingSessions >= this.#maxActiveSessions) {
        throw new LiveConsoleHttpError(
          429,
          "session_limit_reached",
          `Live console is limited to ${this.#maxActiveSessions} active sessions`,
        );
      }
      const objective = typeof body.objective === "string" && body.objective.trim().length > 0
        ? body.objective.trim()
        : "Complete the Live console demo task safely.";
      const message = typeof body.message === "string" ? body.message : objective;
      const manifestId = typeof body.manifest === "string" && body.manifest.length > 0
        ? body.manifest
        : null;
      this.#creatingSessions += 1;
      let entry: DemoEntry;
      try {
        entry = await this.#create(objective, message, manifestId, body.startTurn !== false);
      } finally {
        this.#creatingSessions -= 1;
      }
      json(response, 201, await this.#publicState(entry));
      return;
    }
    if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "liveConsole" || parts[2] !== "sessions") {
      json(response, 404, { error: "not_found" });
      return;
    }
    const entry = this.#entries.get(parts[3]!);
    if (entry === undefined) {
      json(response, 404, { error: "session_not_found" });
      return;
    }
    const action = parts[4];
    if (request.method === "GET" && action === undefined) {
      json(response, 200, await this.#publicState(entry));
      return;
    }
    if (request.method === "GET" && action === "events") {
      const url = new URL(request.url ?? "/", "http://liveConsole.invalid");
      const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
      json(response, 200, {
        events: entry.events.slice(after),
        cursor: entry.events.length,
        replay: after === 0,
      });
      return;
    }
    if (request.method === "GET" && action === "stream") {
      const url = new URL(request.url ?? "/", "http://liveConsole.invalid");
      const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
      if (entry.subscribers.size >= this.#maxSessionSubscribers) {
        throw new LiveConsoleHttpError(
          429,
          "subscriber_limit_reached",
          `Live console sessions allow ${this.#maxSessionSubscribers} subscribers`,
        );
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      // Flush the headers immediately. A resumed subscriber can start past the
      // last event, and Node would otherwise hold the response open with no
      // bytes sent, leaving the browser stuck in CONNECTING.
      response.write(": stream open\n\n");
      for (const event of entry.events.slice(after)) {
        const output = serializeBrowserJson(event);
        if (!output.overflow) response.write(`data: ${output.serialized}\n\n`);
      }
      entry.subscribers.add(response);
      const unsubscribe = () => entry.subscribers.delete(response);
      request.once("close", unsubscribe);
      response.once("close", unsubscribe);
      return;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }
    const body = await readJson(request);
    if (action === "close") {
      await this.#deleteEntry(entry, "browser_session_closed");
      json(response, 200, { closed: true, sessionId: entry.id });
      return;
    } else if (action === "turns") {
      await entry.session.startTurn({
        message: { role: "user", text: String(body.text ?? "") },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else if (action === "steer") {
      await entry.session.steer?.({
        turnId: String(body.turnId ?? ""),
        message: { role: "user", text: String(body.text ?? "") },
      });
    } else if (action === "interrupt") {
      await entry.session.interrupt?.({
        ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      });
    } else if (action === "requests" && parts[5] && parts[6] === "resolve") {
      const pending = entry.session.pendingRuntimeRequests?.().find(({ requestId }) => requestId === parts[5]);
      if (pending === undefined) {
        throw new LiveConsoleHttpError(
          409,
          "runtime_request_not_pending",
          "Runtime request is missing, expired, or already resolved",
        );
      }
      if (typeof body.turnId !== "string" || body.turnId !== pending.turnId) {
        throw new LiveConsoleHttpError(
          409,
          "runtime_request_scope_mismatch",
          "Runtime request resolution does not match its session and turn",
        );
      }
      // The browser is untrusted, so the shape is validated against the kind of
      // request it answers here as well as inside the driver.
      let resolution: HarnessRuntimeRequestResolution;
      try {
        resolution = parseHarnessRuntimeRequestResolution(pending.requestKind, body.resolution);
      } catch (error) {
        throw new LiveConsoleHttpError(
          422,
          "invalid_runtime_request_resolution",
          error instanceof Error ? error.message : String(error),
        );
      }
      await entry.session.resolveRuntimeRequest?.({
        requestId: parts[5],
        turnId: body.turnId,
        resolution,
      });
    } else if (action === "goal" && parts[5]) {
      await entry.session.goal?.(goalOperation(parts[5], body));
    } else if (action === "reconnect") {
      await this.#reconnect(entry);
    } else {
      json(response, 404, { error: "action_not_found" });
      return;
    }
    json(response, 200, await this.#publicState(entry));
  }

  async #deleteEntry(entry: DemoEntry, reason: string): Promise<void> {
    if (!this.#entries.delete(entry.id)) return;
    for (const subscriber of entry.subscribers) subscriber.end();
    entry.subscribers.clear();
    await entry.session.close({ reason });
    await entry.consumeTask.catch(() => undefined);
  }

  async #create(
    objective: string,
    message: string,
    manifestId: string | null = null,
    startTurn = true,
  ): Promise<DemoEntry> {
    const envelope = createCodexTaskEnvelope({
      objective,
      contractRevision: "live-console-demo-v1",
      criteria: [{ id: "objective", requirement: objective }],
    });
    const driver = this.#options.driverFactory(envelope, manifestId ?? undefined);
    const id = randomUUID();
    const runId = `live-console-run-${id}`;
    const normalizedSessionId = `live-console-session-${id}`;
    const session = await driver.openSession({
      runId,
      normalizedSessionId,
      workingDirectory: this.#options.workingDirectory,
    });
    let entry: DemoEntry | null = null;
    try {
      const descriptor = await driver.descriptor();
      entry = {
        id,
        runId,
        normalizedSessionId,
        manifestId,
        envelope,
        driver,
        session,
        capabilities: descriptor.capabilities,
        events: [],
        subscribers: new Set(),
        consumeTask: Promise.resolve(),
      };
      this.#entries.set(id, entry);
      entry.consumeTask = this.#consume(entry, session);
      if (startTurn) {
        await session.startTurn({ message: { role: "user", text: message } });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return entry;
    } catch (error) {
      this.#entries.delete(id);
      await session.close({ reason: "demo_session_start_failed" }).catch(() => undefined);
      await entry?.consumeTask.catch(() => undefined);
      throw error;
    }
  }

  async #consume(entry: DemoEntry, session: HarnessSession): Promise<void> {
    for await (const rawEvent of session.events()) {
      const event = browserSafe(rawEvent) as PrpEvent;
      const validation = validatePrpEvent(event);
      if (!validation.ok) continue;
      const output = serializeBrowserJson(event);
      if (output.overflow) continue;
      if (entry.events.length >= MAX_BROWSER_EVENTS) entry.events.shift();
      entry.events.push(event);
      const serialized = `data: ${output.serialized}\n\n`;
      for (const subscriber of entry.subscribers) {
        if (subscriber.destroyed || subscriber.writableEnded) {
          entry.subscribers.delete(subscriber);
          continue;
        }
        subscriber.write(serialized);
      }
    }
  }

  async #reconnect(entry: DemoEntry): Promise<void> {
    await entry.session.close({ reason: "browser_reconnect" });
    await entry.consumeTask.catch(() => undefined);
    // The snapshot is taken after the close, not before it. A graceful close
    // already appends the terminal fact for every request it cancels, so a
    // pre-close snapshot would hand those same requests to the driver's
    // stale-request recovery path and append a second terminal fact for each.
    // Reading afterwards also carries the closing events' source sequence into
    // the resumed session, keeping source order continuous across the seam.
    const snapshot = await entry.session.snapshot();
    const recovery = await entry.driver.recoverSession?.(snapshot, {
      signal: new AbortController().signal,
    });
    if (!recovery?.recovered || recovery.session === undefined) {
      throw new Error(`session resume failed: ${recovery?.reason ?? "driver cannot resume"}`);
    }
    entry.session = recovery.session;
    entry.consumeTask = this.#consume(entry, recovery.session);
  }

  async #publicState(entry: DemoEntry): Promise<Record<string, unknown>> {
    const driverSession = entry.session.ids();
    const metadata = {
      fixtureName: "live-console-demo",
      identity: {
        schema: "paperclip.prp.identity.v1" as const,
        companyId: "package-local-demo",
        issueId: "live-console-demo",
        runId: entry.runId,
        environmentLeaseId: "package-local",
        runnerInstanceId: "live-console-demo-server",
        normalizedSessionId: entry.normalizedSessionId,
        driverSessionId: driverSession.driverSessionId,
        ...(driverSession.providerSessionId
          ? { providerSessionId: driverSession.providerSessionId }
          : {}),
      },
      capabilities: prpCapabilities(entry.capabilities),
    };
    const snapshot = entry.events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata(metadata),
    );
    const harnessSnapshot = await entry.session.snapshot();
    return {
      sessionId: entry.id,
      runId: entry.runId,
      normalizedSessionId: entry.normalizedSessionId,
      manifest: entry.manifestId,
      providerAuthentication: "server-side",
      credentialsExposed: false,
      capabilities: entry.capabilities,
      driverSession,
      activeTurnId: harnessSnapshot.activeTurnId ?? snapshot.activeTurnId,
      pendingRequests: entry.session.pendingRuntimeRequests?.() ?? [],
      goal: harnessSnapshot.goal ?? null,
      lineage: entry.session.lineage?.() ?? [],
      cursor: entry.events.length,
      snapshot,
    };
  }
}

function goalOperation(action: string, body: Record<string, unknown>): HarnessGoalOperation {
  if (action === "get" || action === "pause" || action === "resume" || action === "clear") {
    return { action };
  }
  if (action === "set" && typeof body.objective === "string" && body.objective.trim().length > 0) {
    return {
      action,
      objective: body.objective.trim(),
      ...(typeof body.tokenBudget === "number" ? { tokenBudget: body.tokenBudget } : {}),
    };
  }
  throw new Error(`unsupported goal operation ${action}`);
}
