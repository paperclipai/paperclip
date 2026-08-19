import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CodexRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexRpcServerRequest extends CodexRpcNotification {
  id: string | number;
}

export type CodexServerRequestHandler = (
  request: CodexRpcServerRequest,
) => Promise<Record<string, unknown>>;

export interface CodexAppServerTransport {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  notifications(): AsyncIterable<CodexRpcNotification>;
  setServerRequestHandler(handler: CodexServerRequestHandler): void;
  close(): Promise<void>;
  processInfo?(): CodexTransportProcessInfo;
}

export interface CodexTransportProcessInfo {
  pid: number | null;
  processGroupId: number | null;
  startedAt: string;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  #values: Array<{ value: T; bytes: number }> = [];
  #waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  #queuedBytes = 0;
  #closed = false;
  #error: Error | null = null;

  constructor(
    private readonly maxValues: number,
    private readonly maxBytes: number,
  ) {}

  push(value: T, bytes: number): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return true;
    }
    if (this.#values.length >= this.maxValues || this.#queuedBytes + bytes > this.maxBytes) {
      return false;
    }
    this.#values.push({ value, bytes });
    this.#queuedBytes += bytes;
    return true;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values = [];
    this.#queuedBytes = 0;
    this.#error = error ?? null;
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ value: undefined, done: true });
      else waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const queued = this.#values.shift();
        if (queued !== undefined) {
          this.#queuedBytes -= queued.bytes;
          return { value: queued.value, done: false };
        }
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

class BoundedLineDecoder {
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string, bytes: number) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  write(chunk: Buffer | string): void {
    if (this.#closed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < incoming.length) {
      const newline = incoming.indexOf(0x0a, offset);
      const end = newline < 0 ? incoming.length : newline;
      const segment = incoming.subarray(offset, end);
      if (this.#buffer.length + segment.length > this.maxLineBytes) {
        this.#fail(new Error(`codex app-server line exceeded ${this.maxLineBytes} bytes`));
        return;
      }
      if (segment.length > 0) this.#buffer = Buffer.concat([this.#buffer, segment]);
      if (newline < 0) return;
      const line = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      this.onLine(line.toString("utf8"), line.length);
      if (this.#closed) return;
      offset = newline + 1;
    }
  }

  end(): void {
    if (this.#closed) return;
    if (this.#buffer.length > 0) {
      this.#fail(new Error("codex app-server ended with an unterminated JSON-RPC line"));
    }
    this.#closed = true;
  }

  close(): void {
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
  }

  #fail(error: Error): void {
    this.close();
    this.onError(error);
  }
}

const SAFE_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "CODEX_HOME",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
] as const;

/**
 * Environment for the trusted app-server process itself. HOME and CODEX_HOME
 * are retained so Codex can authenticate; model-issued commands receive a
 * separate empty-by-default environment and filesystem permission profile.
 */
export function createSanitizedCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (key.includes("PROXY") && proxyContainsCredentials(value)) continue;
    environment[key] = value;
  }
  return environment;
}

export function sanitizedEnvironmentKeys(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(createSanitizedCodexEnvironment(source)).sort();
}

export function redactCodexDiagnostic(message: string): string {
  return message
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(["'](?:api[_-]?key|token|secret|password|authorization)["']\s*:\s*["'])[^"']+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(PAPERCLIP_API_KEY|OPENAI_API_KEY)=[^\s]+/g, "$1=[REDACTED]");
}

function proxyContainsCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return true;
  }
}

export const CODEX_METHOD_NOT_FOUND = -32_601;
export const CODEX_INVALID_REQUEST = -32_600;

/**
 * Codes where the provider refused the call itself rather than failing while
 * serving it: the method is absent (-32601), or the request was rejected
 * outright, which is how the Codex app-server reports a feature it has
 * switched off (-32600 `goals feature is disabled`). Server-error codes
 * (-32603 and the -32000..-32099 implementation range) and transport failures
 * describe one attempt, not what the build supports.
 */
const METHOD_UNAVAILABLE_CODES: readonly number[] = [
  CODEX_METHOD_NOT_FOUND,
  CODEX_INVALID_REQUEST,
];

/**
 * A provider error response, carrying its JSON-RPC code. Callers need the code
 * to tell "this provider build will not serve the method" apart from "the call
 * failed this time", which are different facts about a capability.
 */
export class CodexRpcError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
  }

  get methodUnavailable(): boolean {
    return this.code !== null && METHOD_UNAVAILABLE_CODES.includes(this.code);
  }
}

/**
 * True only when the provider answered and its answer denies the method. A
 * plain `Error` here means the call never got an answer — a transport or
 * protocol failure — which must not be read as a missing capability.
 */
export function isCodexMethodUnavailable(error: unknown): boolean {
  return error instanceof CodexRpcError && error.methodUnavailable;
}

function rpcErrorCode(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "number" && Number.isFinite(code) ? code : null;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export interface ProcessCodexTransportOptions {
  command?: string;
  args?: string[];
  environment?: NodeJS.ProcessEnv;
  onDiagnostic?: (message: string) => void;
  maxLineBytes?: number;
  maxPendingRequests?: number;
  maxQueuedNotifications?: number;
  maxQueuedNotificationBytes?: number;
  maxInflightServerRequests?: number;
  /** Starts a dedicated process group so runnerd and its Codex child are reaped together. */
  processGroup?: boolean;
  closeGraceMs?: number;
  onProcess?: (info: CodexTransportProcessInfo) => void;
}

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_QUEUED_NOTIFICATIONS = 256;
const DEFAULT_MAX_QUEUED_NOTIFICATION_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_INFLIGHT_SERVER_REQUESTS = 32;
const MAX_DIAGNOSTIC_LINE_BYTES = 16 * 1024;

/** Local stdio JSON-RPC transport. App-server never becomes a WAN endpoint. */
export class ProcessCodexAppServerTransport implements CodexAppServerTransport {
  #process: ChildProcessWithoutNullStreams;
  #notifications: BoundedAsyncQueue<CodexRpcNotification>;
  #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #serverRequestHandler: CodexServerRequestHandler = async () => ({
    success: false,
    contentItems: [{ type: "input_text", text: "Unsupported client request." }],
  });
  #inflightServerRequests = 0;
  #closed = false;
  #exited = false;
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #resolveExit!: () => void;
  readonly #exitPromise: Promise<void>;
  readonly #processGroup: boolean;
  readonly #startedAt: string;
  readonly #closeGraceMs: number;
  readonly #onProcess?: (info: CodexTransportProcessInfo) => void;
  #onDiagnostic?: (message: string) => void;
  readonly #maxLineBytes: number;
  readonly #maxPendingRequests: number;
  readonly #maxInflightServerRequests: number;
  readonly #stdoutDecoder: BoundedLineDecoder;
  readonly #stderrDecoder: BoundedLineDecoder;

  constructor(options: ProcessCodexTransportOptions = {}) {
    this.#onDiagnostic = options.onDiagnostic;
    this.#maxLineBytes = positiveLimit(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES);
    this.#maxPendingRequests = positiveLimit(
      options.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
    );
    this.#maxInflightServerRequests = positiveLimit(
      options.maxInflightServerRequests,
      DEFAULT_MAX_INFLIGHT_SERVER_REQUESTS,
    );
    this.#processGroup = options.processGroup === true && process.platform !== "win32";
    this.#startedAt = new Date().toISOString();
    this.#closeGraceMs = positiveLimit(options.closeGraceMs, 1_000);
    this.#onProcess = options.onProcess;
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#notifications = new BoundedAsyncQueue(
      positiveLimit(options.maxQueuedNotifications, DEFAULT_MAX_QUEUED_NOTIFICATIONS),
      positiveLimit(
        options.maxQueuedNotificationBytes,
        DEFAULT_MAX_QUEUED_NOTIFICATION_BYTES,
      ),
    );
    this.#process = spawn(options.command ?? "codex", options.args ?? ["app-server"], {
      env: options.environment ?? createSanitizedCodexEnvironment(),
      stdio: "pipe",
      detached: this.#processGroup,
    });
    this.#onProcess?.(this.processInfo());
    this.#stdoutDecoder = new BoundedLineDecoder(
      this.#maxLineBytes,
      (line, bytes) => this.#onLine(line, bytes),
      (error) => this.#fatal(error),
    );
    this.#stderrDecoder = new BoundedLineDecoder(
      MAX_DIAGNOSTIC_LINE_BYTES,
      (line) => this.#onDiagnostic?.(redactCodexDiagnostic(line)),
      () => this.#onDiagnostic?.("codex app-server diagnostic line exceeded retention limit"),
    );
    this.#process.stdout.on("data", (chunk: Buffer) => this.#stdoutDecoder.write(chunk));
    this.#process.stdout.on("end", () => this.#stdoutDecoder.end());
    this.#process.stderr.on("data", (chunk: Buffer) => this.#stderrDecoder.write(chunk));
    this.#process.stderr.on("end", () => this.#stderrDecoder.end());
    this.#process.on("error", (error) => this.#fatal(error));
    this.#process.on("exit", (code, signal) => {
      this.#exited = true;
      this.#exitCode = code;
      this.#exitSignal = signal;
      this.#resolveExit();
      this.#onProcess?.(this.processInfo());
      if (!this.#closed) {
        this.#fatal(
          new Error(
            `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          ),
        );
      }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new Error("codex app-server transport is closed"));
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(
        new Error(`codex app-server pending request limit ${this.#maxPendingRequests} exceeded`),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.#notifications;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  async close(): Promise<void> {
    const firstClose = !this.#closed;
    if (firstClose) {
      this.#closed = true;
      this.#stdoutDecoder.close();
      this.#stderrDecoder.close();
      this.#notifications.close();
      this.#failAll(new Error("codex app-server transport closed"));
    }
    if (!this.#exited) {
      if (firstClose) this.#signal("SIGTERM");
      const exited = await Promise.race([
        this.#exitPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), this.#closeGraceMs)),
      ]);
      if (!exited && !this.#exited) {
        this.#signal("SIGKILL");
        await Promise.race([
          this.#exitPromise,
          new Promise<void>((resolve) => setTimeout(resolve, this.#closeGraceMs)),
        ]);
      }
    }
  }

  processInfo(): CodexTransportProcessInfo {
    return {
      pid: this.#process.pid ?? null,
      processGroupId: this.#processGroup ? this.#process.pid ?? null : null,
      startedAt: this.#startedAt,
      exited: this.#exited,
      exitCode: this.#exitCode,
      signal: this.#exitSignal,
    };
  }

  #signal(signal: NodeJS.Signals): void {
    const pid = this.#process.pid;
    if (this.#processGroup && pid !== undefined) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // The group may already be gone; the direct child kill below is idempotent.
      }
    }
    this.#process.kill(signal);
  }

  #write(message: unknown): void {
    if (this.#closed) throw new Error("codex app-server transport is closed");
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized) > this.#maxLineBytes) {
      throw new Error(`outbound codex JSON-RPC line exceeded ${this.#maxLineBytes} bytes`);
    }
    this.#process.stdin.write(`${serialized}\n`);
  }

  #onLine(line: string, bytes: number): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#fatal(new Error("codex app-server emitted malformed JSON"));
      return;
    }
    if (!isRecord(value)) {
      this.#fatal(new Error("codex app-server emitted a non-object JSON-RPC message"));
      return;
    }
    const message = value;
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (typeof message.id === "number" && (hasResult || hasError)) {
      if (!Number.isSafeInteger(message.id) || message.id <= 0 || hasResult === hasError) {
        this.#fatal(new Error("codex app-server emitted a malformed JSON-RPC response"));
        return;
      }
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        this.#fatal(new Error("codex app-server responded to an unknown request id"));
        return;
      }
      this.#pending.delete(message.id);
      if (hasError) {
        pending.reject(new CodexRpcError(
          redactCodexDiagnostic(boundedJson(message.error)),
          rpcErrorCode(message.error),
        ));
      } else if (isRecord(message.result)) {
        pending.resolve(message.result);
      } else {
        const error = new Error("codex app-server response result was not an object");
        pending.reject(error);
        this.#fatal(error);
      }
      return;
    }
    if (typeof message.method !== "string" || message.method.length === 0 || hasResult || hasError) {
      this.#fatal(new Error("codex app-server emitted a malformed JSON-RPC message"));
      return;
    }
    if (message.params !== undefined && !isRecord(message.params)) {
      this.#fatal(new Error("codex app-server message params were not an object"));
      return;
    }
    const params = message.params ?? {};
    if (message.id !== undefined) {
      if (!isValidServerRequestId(message.id)) {
        this.#fatal(new Error("codex app-server request id had an invalid type"));
        return;
      }
      this.#handleServerRequest({ id: message.id, method: message.method, params });
      return;
    }
    if (!this.#notifications.push({ method: message.method, params }, bytes)) {
      this.#fatal(new Error("codex app-server notification queue limit exceeded"));
    }
  }

  #handleServerRequest(request: CodexRpcServerRequest): void {
    if (this.#inflightServerRequests >= this.#maxInflightServerRequests) {
      this.#write({
        id: request.id,
        error: { code: -32_001, message: "Client request queue limit exceeded." },
      });
      return;
    }
    this.#inflightServerRequests += 1;
    void this.#serverRequestHandler(request).then(
      (result) => {
        if (!this.#closed) this.#write({ id: request.id, result });
      },
      (error: unknown) => {
        if (!this.#closed) {
          this.#write({
            id: request.id,
            error: { code: -32_000, message: redactCodexDiagnostic(String(error)) },
          });
        }
      },
    ).finally(() => {
      this.#inflightServerRequests -= 1;
    });
  }

  #fatal(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stdoutDecoder.close();
    this.#stderrDecoder.close();
    this.#signal("SIGKILL");
    this.#notifications.close(error);
    this.#failAll(error);
    this.#onDiagnostic?.(redactCodexDiagnostic(error.message));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function isValidServerRequestId(value: unknown): value is string | number {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 256)
  );
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value) ?? String(value);
  return serialized.length <= MAX_DIAGNOSTIC_LINE_BYTES
    ? serialized
    : `${serialized.slice(0, MAX_DIAGNOSTIC_LINE_BYTES)}...[truncated]`;
}
