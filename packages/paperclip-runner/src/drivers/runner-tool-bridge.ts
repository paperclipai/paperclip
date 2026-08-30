import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import {
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_TOOL_NAME,
} from "../contracts/completion-result.js";

export interface RunnerToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface RunnerToolCall {
  tool: string;
  callId: string;
  arguments: unknown;
  signal: AbortSignal;
}

export interface RunnerToolBridgeOptions {
  tools?: readonly Readonly<Record<string, unknown>>[];
  /** Runner-owned operations that are callable but never model-visible. */
  privateTools?: readonly Readonly<Record<string, unknown>>[];
  handler(call: RunnerToolCall): Promise<unknown>;
  timeoutMs?: number;
  privateToolTimeoutMs?: number;
  maxBodyBytes?: number;
  /** Internal test seam; production bounds headers and body reads to 30 seconds. */
  requestBodyTimeoutMs?: number;
  secret?: string;
}

export interface RunnerToolBridge {
  readonly url: string;
  readonly secret: string;
  close(): Promise<void>;
}

interface AdmittedCall {
  fingerprint: string;
  promise: Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PRIVATE_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 30_000;
const MAX_CALLS = 2_048;
const MAX_RESULT_TEXT_BYTES = 64 * 1024;
const RESERVED_TOOLS: readonly RunnerToolDefinition[] = [
  {
    name: PRP_COMPLETION_TOOL_NAME,
    description: "Return the semantic completion result.",
    inputSchema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  },
  {
    name: PRP_BLOCK_TOOL_NAME,
    description: "Return the semantic blocked result.",
    inputSchema: PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  },
];

export function canonicalRunnerToolName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === PRP_COMPLETION_TOOL_NAME || trimmed === PRP_BLOCK_TOOL_NAME) {
    return trimmed;
  }
  for (const prefix of ["paperclip__", "paperclip_", "paperclip."]) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

/** Start one authenticated, loopback-only MCP endpoint for a closed run catalog. */
export async function startRunnerToolBridge(
  options: RunnerToolBridgeOptions,
): Promise<RunnerToolBridge> {
  const secret = options.secret ?? randomBytes(32).toString("base64url");
  if (secret.length === 0) throw new Error("Runner tool bridge secret is empty");
  const tools = normalizeTools(options.tools ?? [], "public");
  const privateTools = normalizeTools(options.privateTools ?? [], "private");
  const publicNames = new Set(tools.map((tool) => tool.name));
  for (const tool of privateTools) {
    if (publicNames.has(tool.name)) {
      throw new Error(`Runner tool ${tool.name} cannot be both public and private`);
    }
  }
  const visibleTools = [...tools, ...structuredClone(RESERVED_TOOLS)];
  const admittedTools = [...visibleTools, ...privateTools];
  const validators = compileValidators(admittedTools);
  const calls = new Map<string, AdmittedCall>();
  const controllers = new Map<string, AbortController>();
  const context = {
    secret,
    visibleTools,
    admittedTools: new Map(admittedTools.map((tool) => [tool.name, tool])),
    validators,
    calls,
    controllers,
    handler: options.handler,
    timeoutMs: positiveBoundedInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1,
      24 * 60 * 60 * 1_000,
      "tool timeout",
    ),
    privateToolTimeoutMs: positiveBoundedInteger(
      options.privateToolTimeoutMs,
      DEFAULT_PRIVATE_TOOL_TIMEOUT_MS,
      1,
      24 * 60 * 60 * 1_000,
      "private tool timeout",
    ),
    privateToolNames: new Set(privateTools.map((tool) => tool.name)),
    maxBodyBytes: positiveBoundedInteger(
      options.maxBodyBytes,
      DEFAULT_MAX_BODY_BYTES,
      1,
      16 * 1024 * 1024,
      "request size",
    ),
    requestBodyTimeoutMs: positiveBoundedInteger(
      options.requestBodyTimeoutMs,
      DEFAULT_REQUEST_BODY_TIMEOUT_MS,
      1,
      5 * 60 * 1_000,
      "request body timeout",
    ),
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, context).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end();
    });
  });
  server.requestTimeout = context.requestBodyTimeoutMs;
  server.headersTimeout = context.requestBodyTimeoutMs;
  server.on("clientError", (_error, socket) => socket.destroy());
  await listenLoopback(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Runner tool bridge failed to bind a loopback port");
  }
  let closed = false;
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}/mcp`,
    secret,
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers.values()) controller.abort();
      await closeServer(server);
    },
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    secret: string;
    visibleTools: RunnerToolDefinition[];
    admittedTools: Map<string, RunnerToolDefinition>;
    validators: Map<string, ValidateFunction>;
    calls: Map<string, AdmittedCall>;
    controllers: Map<string, AbortController>;
    handler: RunnerToolBridgeOptions["handler"];
    timeoutMs: number;
    privateToolTimeoutMs: number;
    privateToolNames: ReadonlySet<string>;
    maxBodyBytes: number;
    requestBodyTimeoutMs: number;
  },
): Promise<void> {
  setSecurityHeaders(response);
  if (!authorized(request.headers.authorization, context.secret)) {
    response.statusCode = 401;
    response.end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.statusCode = request.method === "GET" ? 405 : 404;
    if (request.method === "GET") response.setHeader("Allow", "POST");
    response.end();
    return;
  }
  if (!isJsonContentType(request.headers["content-type"])) {
    response.statusCode = 415;
    response.end();
    return;
  }
  let message: Record<string, unknown>;
  try {
    message = parseMessage(await readBody(
      request,
      context.maxBodyBytes,
      context.requestBodyTimeoutMs,
    ));
  } catch (error) {
    writeRpc(response, null, undefined, rpcError(-32700, safeError(error)));
    return;
  }
  const id = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";
  if (method === "notifications/cancelled") {
    const params = isRecord(message.params) ? message.params : {};
    const requestId = params.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      context.controllers.get(rpcIdKey(requestId))?.abort();
    }
    response.statusCode = 202;
    response.end();
    return;
  }
  if (method === "notifications/initialized") {
    response.statusCode = 202;
    response.end();
    return;
  }
  if (method === "initialize") {
    response.setHeader("Mcp-Session-Id", randomBytes(16).toString("hex"));
    writeRpc(response, id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "paperclip-runner", version: "1" },
    });
    return;
  }
  if (method === "ping") {
    writeRpc(response, id, {});
    return;
  }
  if (method === "tools/list") {
    writeRpc(response, id, { tools: context.visibleTools });
    return;
  }
  if (method !== "tools/call") {
    writeRpc(response, id, undefined, rpcError(-32601, "Method not found"));
    return;
  }

  const params = isRecord(message.params) ? message.params : {};
  const rawName = typeof params.name === "string" ? params.name : "";
  const tool = canonicalRunnerToolName(rawName);
  if (!context.admittedTools.has(tool)) {
    writeToolError(response, id, "Unsupported tool.");
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    writeRpc(response, null, undefined, rpcError(-32600, "Tool calls require a request id"));
    return;
  }
  const callId = String(id);
  const callKey = rpcIdKey(id);
  const args = params.arguments ?? {};
  const validator = context.validators.get(tool);
  if (validator === undefined || !validator(args)) {
    const detail = validator?.errors
      ?.map(
        (error) =>
          `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      )
      .join("; ");
    writeToolError(
      response,
      id,
      `Invalid tool input${detail ? `: ${detail}` : "."}`,
    );
    return;
  }

  const fingerprint = canonicalJson({ tool, args });
  const existing = context.calls.get(callKey);
  if (existing && existing.fingerprint !== fingerprint) {
    writeToolError(response, id, "Duplicate call identity conflict.");
    return;
  }
  if (!existing && context.calls.size >= MAX_CALLS) {
    for (const admittedId of context.calls.keys()) {
      if (context.controllers.has(admittedId)) continue;
      context.calls.delete(admittedId);
      break;
    }
    if (context.calls.size >= MAX_CALLS) {
      writeToolError(response, id, "Runner tool bridge is at call capacity.");
      return;
    }
  }
  const controller = existing === undefined ? new AbortController() : undefined;
  const execution =
    existing?.promise ??
    withCancellationAndTimeout(
      Promise.resolve().then(() =>
        context.handler({
          tool,
          callId,
          arguments: structuredClone(args),
          signal: controller!.signal,
        }),
      ),
      controller!,
      context.privateToolNames.has(tool)
        ? context.privateToolTimeoutMs
        : context.timeoutMs,
    );
  if (!existing) {
    context.calls.set(callKey, { fingerprint, promise: execution });
    context.controllers.set(callKey, controller!);
    void execution
      .finally(() => context.controllers.delete(callKey))
      .catch(() => undefined);
  }
  try {
    const result = await execution;
    writeRpc(response, id, {
      content: [{ type: "text", text: safeJson(result) }],
    });
  } catch (error) {
    writeToolError(response, id, safeError(error));
  }
}

function normalizeTools(
  input: readonly Readonly<Record<string, unknown>>[],
  visibility: "public" | "private",
): RunnerToolDefinition[] {
  const tools: RunnerToolDefinition[] = [];
  const seen = new Set<string>();
  const reservedNames = new Set(RESERVED_TOOLS.map((tool) => tool.name));
  for (const raw of input) {
    const name =
      typeof raw.name === "string" ? canonicalRunnerToolName(raw.name) : "";
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(name)) {
      throw new Error(`Runner ${visibility} tool has an invalid name`);
    }
    if (reservedNames.has(name)) {
      throw new Error(`Runner tool ${name} is reserved by the protocol`);
    }
    if (seen.has(name)) {
      throw new Error(`Runner ${visibility} tool ${name} is duplicated`);
    }
    if (!isRecord(raw.inputSchema)) {
      throw new Error(`Runner tool ${name} requires an object input schema`);
    }
    tools.push({
      name,
      ...(typeof raw.description === "string"
        ? { description: raw.description.slice(0, 4_096) }
        : {}),
      inputSchema: structuredClone(raw.inputSchema),
    });
    seen.add(name);
  }
  return tools;
}

function compileValidators(
  tools: readonly RunnerToolDefinition[],
): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
}

function authorized(value: string | undefined, secret: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readBody(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: Error, destroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy && !request.destroyed) request.destroy();
      reject(error);
    };
    const onData = (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length > maxBytes - size) {
        fail(
          new Error("MCP request exceeded the retained payload limit"),
          true,
        );
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error("MCP request body was aborted"));
    const timer = setTimeout(() => {
      fail(new Error("MCP request body timed out"), true);
    }, timeoutMs);
    timer.unref?.();
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function parseMessage(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (
    !isRecord(parsed) ||
    parsed.jsonrpc !== "2.0" ||
    typeof parsed.method !== "string"
  ) {
    throw new Error("Invalid JSON-RPC request");
  }
  return parsed;
}

function writeToolError(
  response: ServerResponse,
  id: unknown,
  message: string,
): void {
  writeRpc(response, id, {
    isError: true,
    content: [{ type: "text", text: message }],
  });
}

function writeRpc(
  response: ServerResponse,
  id: unknown,
  result?: unknown,
  error?: unknown,
): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      ...(error === undefined ? { result } : { error }),
    }),
  );
}

function rpcError(code: number, message: string): { code: number; message: string } {
  return { code, message };
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

function withCancellationAndTimeout<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new Error("Paperclip tool call cancelled")));
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Paperclip tool call timed out")));
      controller.abort();
    }, timeoutMs);
    timer.unref();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value) ?? "null";
    if (Buffer.byteLength(serialized) > MAX_RESULT_TEXT_BYTES) {
      return '{"omitted":true,"reason":"payload_limit"}';
    }
    return serialized;
  } catch {
    return '{"omitted":true,"reason":"serialization_failed"}';
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function rpcIdKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`Runner tool bridge ${label} is outside its supported bound`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
