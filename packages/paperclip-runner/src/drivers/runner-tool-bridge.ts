import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  promise: Promise<RunnerToolCallResult>;
}

interface RunnerToolTextContent {
  type: "text";
  text: string;
}

interface RunnerToolCallResult {
  content: RunnerToolTextContent[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PRIVATE_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 30_000;
const MAX_CALLS = 2_048;
const MAX_RESULT_CHUNK_BYTES = 64 * 1024;
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
  if (secret.length === 0)
    throw new Error("Runner tool bridge secret is empty");
  const tools = normalizeTools(options.tools ?? [], "public");
  const privateTools = normalizeTools(options.privateTools ?? [], "private");
  const publicNames = new Set(tools.map((tool) => tool.name));
  for (const tool of privateTools) {
    if (publicNames.has(tool.name)) {
      throw new Error(
        `Runner tool ${tool.name} cannot be both public and private`,
      );
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
    message = parseMessage(
      await readBody(
        request,
        context.maxBodyBytes,
        context.requestBodyTimeoutMs,
      ),
    );
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
    writeRpc(
      response,
      null,
      undefined,
      rpcError(-32600, "Tool calls require a request id"),
    );
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
  const execution: Promise<RunnerToolCallResult> =
    existing?.promise ??
    withCancellationAndTimeout(
      Promise.resolve()
        .then(() =>
          context.handler({
            tool,
            callId,
            arguments: structuredClone(args),
            signal: controller!.signal,
          }),
        )
        .then((result) => successfulToolResult(tool, callId, result)),
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
    writeRpc(response, id, result);
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
  return new Map(
    tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
  );
}

function authorized(value: string | undefined, secret: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(secret);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
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

function rpcError(
  code: number,
  message: string,
): { code: number; message: string } {
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
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2_000,
  );
}

function successfulToolResult(
  tool: string,
  callId: string,
  value: unknown,
): RunnerToolCallResult {
  const json = strictJson(value);
  if (json !== null) return chunkedToolResult(tool, callId, "json", json);
  const representation = JSON.stringify({
    schema: "paperclip.semantic_tool_result.v1",
    status: "completed",
    tool,
    callIdentitySha256: createHash("sha256").update(callId).digest("hex"),
    encoding: "paperclip.tagged_graph.v1",
    result: taggedGraph(value),
  });
  return chunkedToolResult(
    tool,
    callId,
    "paperclip.tagged_graph.v1",
    representation,
  );
}

function strictJson(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(
      value,
      function strictJsonValue(
        this: { readonly [key: string]: unknown },
        key: string,
        candidate: unknown,
      ) {
        const source = this[key];
        if (
          typeof candidate === "undefined" ||
          typeof candidate === "bigint" ||
          typeof candidate === "function" ||
          typeof candidate === "symbol" ||
          (typeof candidate === "number" && !Number.isFinite(candidate)) ||
          (source !== null &&
            typeof source === "object" &&
            Reflect.ownKeys(source).some(
              (property) => typeof property === "symbol",
            )) ||
          (candidate !== null &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            Object.getPrototypeOf(candidate) !== Object.prototype &&
            Object.getPrototypeOf(candidate) !== null)
        ) {
          throw new Error("Result requires tagged graph encoding");
        }
        return candidate;
      },
    );
    return serialized ?? null;
  } catch {
    return null;
  }
}

function chunkedToolResult(
  tool: string,
  callId: string,
  encoding: "json" | "paperclip.tagged_graph.v1",
  serialized: string,
): RunnerToolCallResult {
  if (Buffer.byteLength(serialized) <= MAX_RESULT_CHUNK_BYTES) {
    return { content: [{ type: "text", text: serialized }] };
  }
  const chunks = utf8Chunks(serialized, MAX_RESULT_CHUNK_BYTES);
  const manifest = JSON.stringify({
    schema: "paperclip.semantic_tool_result_chunks.v1",
    status: "completed",
    tool,
    callIdentitySha256: createHash("sha256").update(callId).digest("hex"),
    encoding,
    contentOffset: 1,
    chunkCount: chunks.length,
    byteLength: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  });
  return {
    content: [
      { type: "text", text: manifest },
      ...chunks.map((text) => ({ type: "text" as const, text })),
    ],
  };
}

function utf8Chunks(value: string, maxBytes: number): string[] {
  const bytes = Buffer.from(value);
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    if (end === start) {
      throw new Error("Runner tool result chunk boundary is invalid");
    }
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
}

interface TaggedGraphState {
  nodes: Array<Record<string, unknown>>;
  objects: Map<object, number>;
  symbols: Map<symbol, number>;
}

function taggedGraph(value: unknown): Record<string, unknown> {
  const state: TaggedGraphState = {
    nodes: [],
    objects: new Map(),
    symbols: new Map(),
  };
  return {
    root: taggedValue(value, state),
    nodes: state.nodes,
  };
}

function taggedValue(value: unknown, state: TaggedGraphState): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    return {
      $type: "number",
      value: Number.isNaN(value)
        ? "NaN"
        : value === Number.POSITIVE_INFINITY
          ? "Infinity"
          : "-Infinity",
    };
  }
  if (typeof value === "undefined") return { $type: "undefined" };
  if (typeof value === "bigint") {
    return { $type: "bigint", value: value.toString() };
  }
  if (typeof value === "symbol") return taggedSymbol(value, state);

  const object = value as object;
  const existing = state.objects.get(object);
  if (existing !== undefined) return { $ref: existing };
  const id = state.nodes.length + 1;
  state.objects.set(object, id);
  const node: Record<string, unknown> = {
    id,
    type: taggedObjectType(value),
  };
  state.nodes.push(node);
  if (typeof value === "function") {
    node.source = Function.prototype.toString.call(value);
  } else if (value instanceof Date) {
    node.value = Number.isNaN(value.getTime())
      ? "Invalid Date"
      : value.toISOString();
  } else if (value instanceof RegExp) {
    node.source = value.source;
    node.flags = value.flags;
    node.lastIndex = value.lastIndex;
  } else if (value instanceof Map) {
    node.entries = [...value.entries()].map(([key, entry]) => [
      taggedValue(key, state),
      taggedValue(entry, state),
    ]);
  } else if (value instanceof Set) {
    node.entries = [...value.values()].map((entry) =>
      taggedValue(entry, state),
    );
  } else if (value instanceof ArrayBuffer) {
    node.base64 = Buffer.from(value).toString("base64");
  } else if (ArrayBuffer.isView(value)) {
    node.base64 = Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).toString("base64");
  }
  node.properties = Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return {
      key: typeof key === "string" ? key : taggedSymbol(key, state),
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
      ...(Object.hasOwn(descriptor, "value")
        ? {
            writable: descriptor.writable,
            value: taggedValue(descriptor.value, state),
          }
        : {
            get:
              descriptor.get === undefined
                ? null
                : Function.prototype.toString.call(descriptor.get),
            set:
              descriptor.set === undefined
                ? null
                : Function.prototype.toString.call(descriptor.set),
          }),
    };
  });
  return { $ref: id };
}

function taggedSymbol(
  value: symbol,
  state: TaggedGraphState,
): Record<string, unknown> {
  const existing = state.symbols.get(value);
  if (existing !== undefined) return { $symbolRef: existing };
  const id = state.symbols.size + 1;
  state.symbols.set(value, id);
  return {
    $type: "symbol",
    id,
    key: Symbol.keyFor(value) ?? null,
    description: value.description ?? null,
  };
}

function taggedObjectType(value: object): string {
  if (Array.isArray(value)) return "Array";
  if (typeof value === "function") return "Function";
  if (ArrayBuffer.isView(value)) return value.constructor.name;
  const prototype = Object.getPrototypeOf(value) as {
    constructor?: { name?: unknown };
  } | null;
  return typeof prototype?.constructor?.name === "string"
    ? prototype.constructor.name
    : "Object";
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
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(
      `Runner tool bridge ${label} is outside its supported bound`,
    );
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
