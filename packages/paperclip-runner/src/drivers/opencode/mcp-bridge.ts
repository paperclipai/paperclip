import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { toolInputError } from "../tool-input-error.js";

import {
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_BLOCK_TOOL_DESCRIPTION,
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_TOOL_DESCRIPTION,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";

export interface OpenCodeMcpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface OpenCodeMcpCall {
  tool: string;
  callId: string;
  arguments: unknown;
  signal: AbortSignal;
}

export interface OpenCodeMcpBridgeOptions {
  tools?: readonly Readonly<Record<string, unknown>>[];
  /** Runner-owned operations callable only by a trusted harness extension and never advertised to the model. */
  privateTools?: readonly Readonly<Record<string, unknown>>[];
  handler: (call: OpenCodeMcpCall) => Promise<unknown>;
  onRejectedCall?: (call: Pick<OpenCodeMcpCall, "tool" | "callId" | "arguments">, error: string) => void;
  /** Null leaves durable requests with the owning Runner lease and bridge close. */
  timeoutMs?: number | null;
  /** Human-gated private operations may remain pending much longer than model tool calls. */
  privateToolTimeoutMs?: number;
  maxBodyBytes?: number;
  secret?: string;
  onDiagnostic?: (message: string) => void;
}

export interface OpenCodeMcpBridge {
  url: string;
  secret: string;
  close(): Promise<void>;
}

type FinishInputRejection = {
  input: unknown;
  callId: string;
  validationCategory: "root" | "continuation" | "other";
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
// Native app results/pages are capped at 500 KB before reaching this bridge.
// Leave room for their delivery envelope, but never cut a completed JSON value.
const MAX_RESULT_BYTES = 1_048_576;
const TOOL_DELIVERY_DIAGNOSTIC_SCHEMA = "paperclip.opencode.tool-delivery-diagnostic/v1";
const MAX_TOOL_DELIVERY_DIAGNOSTICS = 256;

type SocketUse = { requests: number; lastResponseAt: number | null };
type ToolDelivery = {
  socketRequestIndex: number;
  socketIdleMs: number | null;
  receivedAt: number;
};
type ToolDeliveryOutcome = "result" | "error" | "unanswered";

export function canonicalOpenCodeMcpToolName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === PRP_COMPLETION_TOOL_NAME || trimmed === PRP_BLOCK_TOOL_NAME) return trimmed;
  for (const prefix of ["paperclip__", "paperclip_", "paperclip."]) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

export async function startOpenCodeMcpBridge(
  options: OpenCodeMcpBridgeOptions,
): Promise<OpenCodeMcpBridge> {
  const secret = options.secret ?? randomBytes(32).toString("base64url");
  const tools = normalizeTools(options.tools ?? []);
  const privateTools = normalizeTools(options.privateTools ?? [], false);
  const admittedTools = [...tools, ...privateTools.filter((candidate) => !tools.some((tool) => tool.name === candidate.name))];
  const validators = compileValidators(admittedTools);
  const finishSchema = admittedTools.find(tool => tool.name === PRP_COMPLETION_TOOL_NAME)?.inputSchema;
  const finishSchemaSha256 = finishSchema && options.onDiagnostic
    ? createHash("sha256").update(JSON.stringify(finishSchema)).digest("hex") : undefined;
  let rejectionDiagnostics = 0;
  const diagnoseFinishInput = (rejection?: FinishInputRejection) => {
    if (!finishSchemaSha256 || !options.onDiagnostic) return;
    if (rejection && rejectionDiagnostics++ >= 8) return;
    const diagnostic = {
      schema: "paperclip.opencode.finish-input-diagnostic/v1",
      stage: rejection ? "input_rejected" : "offered", schemaSha256: finishSchemaSha256,
      ...(rejection ? {
        callIdSha256: createHash("sha256").update(rejection.callId).digest("hex"),
        validationCategory: rejection.validationCategory,
        rootShape: inputShape(rejection.input),
        continuationShape: inputShape(isRecord(rejection.input) ? rejection.input.continuation : undefined),
      } : {}),
    };
    try { options.onDiagnostic(JSON.stringify(diagnostic)); } catch { /* Optional diagnostics never change admission. */ }
  };
  let deliveryDiagnostics = 0;
  const diagnoseToolDelivery = (
    callId: string,
    delivery: ToolDelivery,
    outcome: ToolDeliveryOutcome,
    written: boolean,
  ) => {
    if (!options.onDiagnostic || deliveryDiagnostics++ >= MAX_TOOL_DELIVERY_DIAGNOSTICS) return;
    const diagnostic = {
      schema: TOOL_DELIVERY_DIAGNOSTIC_SCHEMA,
      callIdSha256: createHash("sha256").update(callId).digest("hex"),
      socketRequestIndex: delivery.socketRequestIndex,
      socketIdleMs: delivery.socketIdleMs,
      handlerMs: Date.now() - delivery.receivedAt,
      outcome,
      written,
    };
    try { options.onDiagnostic(JSON.stringify(diagnostic)); } catch { /* Optional diagnostics never change delivery. */ }
  };
  const calls = new Map<string, { fingerprint: string; promise: Promise<unknown>; waiting: Set<ServerResponse> }>();
  const controllers = new Map<string, AbortController>();
  const socketUses = new WeakMap<Socket, SocketUse>();
  const server = createServer((request, response) => {
    const use = socketUses.get(request.socket) ?? { requests: 0, lastResponseAt: null };
    socketUses.set(request.socket, use);
    const receivedAt = Date.now();
    const delivery: ToolDelivery = {
      socketRequestIndex: ++use.requests,
      socketIdleMs: use.lastResponseAt === null ? null : receivedAt - use.lastResponseAt,
      receivedAt,
    };
    response.once("finish", () => { use.lastResponseAt = Date.now(); });
    void handleRequest(request, response, {
      delivery,
      diagnoseToolDelivery,
      secret,
      tools,
      admittedTools,
      validators,
      calls,
      controllers,
      handler: options.handler,
      onRejectedCall: options.onRejectedCall,
      diagnoseFinishInput,
      timeoutMs: options.timeoutMs === null ? null : options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      privateToolTimeoutMs: options.privateToolTimeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      privateToolNames: new Set(privateTools.map((tool) => tool.name)),
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("OpenCode MCP bridge failed to bind a loopback port");
  }
  diagnoseFinishInput();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    secret,
    close: async () => {
      for (const controller of controllers.values()) controller.abort();
      await closeServer(server);
    },
  };
}

function inputShape(input: unknown): "omitted" | "null" | "array" | "object" | "string" | "number" | "boolean" | "other" {
  if (input === undefined) return "omitted";
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (typeof input === "object") return "object";
  if (typeof input === "string") return "string";
  if (typeof input === "number") return "number";
  if (typeof input === "boolean") return "boolean";
  return "other";
}

function normalizeTools(
  input: readonly Readonly<Record<string, unknown>>[],
  includeTerminalTools = true,
): OpenCodeMcpToolDefinition[] {
  const tools: OpenCodeMcpToolDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || seen.has(name)) continue;
    const inputSchema = isRecord(raw.inputSchema) ? structuredClone(raw.inputSchema) : { type: "object" };
    tools.push({
      name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      inputSchema,
    });
    seen.add(name);
  }
  if (includeTerminalTools) for (const terminal of [
    { name: PRP_COMPLETION_TOOL_NAME, description: PRP_COMPLETION_TOOL_DESCRIPTION, inputSchema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA },
    { name: PRP_BLOCK_TOOL_NAME, description: PRP_BLOCK_TOOL_DESCRIPTION, inputSchema: PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA },
  ]) {
    if (!seen.has(terminal.name)) tools.push(terminal);
  }
  return tools;
}

function compileValidators(tools: readonly OpenCodeMcpToolDefinition[]): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    delivery: ToolDelivery;
    diagnoseToolDelivery: (callId: string, delivery: ToolDelivery, outcome: ToolDeliveryOutcome, written: boolean) => void;
    secret: string;
    tools: OpenCodeMcpToolDefinition[];
    admittedTools: OpenCodeMcpToolDefinition[];
    validators: Map<string, ValidateFunction>;
    calls: Map<string, { fingerprint: string; promise: Promise<unknown>; waiting: Set<ServerResponse> }>;
    controllers: Map<string, AbortController>;
    handler: OpenCodeMcpBridgeOptions["handler"];
    onRejectedCall: OpenCodeMcpBridgeOptions["onRejectedCall"];
    timeoutMs: number | null;
    privateToolTimeoutMs: number;
    privateToolNames: ReadonlySet<string>;
    maxBodyBytes: number;
    diagnoseFinishInput: (rejection?: FinishInputRejection) => void;
  },
): Promise<void> {
  setSecurityHeaders(response);
  // Keep the default keep-alive. Forcing `Connection: close` here left
  // OpenCode (Bun fetch) without the Paperclip MCP tools in many native runs:
  // first model requests dropped from ~35k to ~15k input tokens (no tool
  // schemas) and the agents reported that Paperclip tools were missing.
  if (!authorized(request.headers.authorization, context.secret)) {
    response.statusCode = 401;
    response.end();
    return;
  }
  if (request.method === "GET") {
    response.statusCode = 405;
    response.setHeader("Allow", "POST, DELETE");
    response.end();
    return;
  }
  if (request.method === "DELETE") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/mcp") {
    response.statusCode = 404;
    response.end();
    return;
  }
  let message: Record<string, unknown>;
  try {
    message = parseMessage(await readBody(request, context.maxBodyBytes));
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
      context.controllers.get(String(requestId))?.abort();
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
    writeRpc(response, id, { tools: context.tools });
    return;
  }
  if (method !== "tools/call") {
    writeRpc(response, id, undefined, rpcError(-32601, "Method not found"));
    return;
  }
  const params = isRecord(message.params) ? message.params : {};
  const callId = typeof id === "string" || typeof id === "number" ? String(id) : randomBytes(12).toString("hex");
  // Record how each call's answer left the bridge, rejections included, so a
  // client that never consumes a written answer can be told apart from a
  // bridge that never answered it.
  let outcome: ToolDeliveryOutcome = "unanswered";
  response.once("close", () => {
    context.diagnoseToolDelivery(callId, context.delivery, outcome, response.writableFinished);
  });
  const rawName = typeof params.name === "string" ? params.name : "";
  // A declared operation may itself start with paperclip_. Preserve that
  // authority identity before accepting an OpenCode transport prefix alias.
  const exactName = rawName.trim();
  const tool = context.admittedTools.some(entry => entry.name === exactName)
    ? exactName
    : canonicalOpenCodeMcpToolName(exactName);
  if (!context.admittedTools.some((entry) => entry.name === tool)) {
    outcome = "error";
    writeRpc(response, id, { isError: true, content: [{ type: "text", text: "Unsupported tool." }] });
    return;
  }
  const args = params.arguments ?? {};
  const validator = context.validators.get(tool);
  if (validator === undefined || !validator(args)) {
    if (tool === PRP_COMPLETION_TOOL_NAME) {
      const errors = validator?.errors ?? [];
      const validationCategory = errors.some(error => error.instancePath === "/continuation" || error.instancePath.startsWith("/continuation/"))
        ? "continuation" : errors.some(error => error.instancePath === "") ? "root" : "other";
      context.diagnoseFinishInput({ input: params.arguments, callId, validationCategory });
    }
    const error = toolInputError(validator);
    try { context.onRejectedCall?.({ tool, callId, arguments: args }, error); } catch {}
    outcome = "error";
    writeRpc(response, id, {
      isError: true,
      content: [{ type: "text", text: error }],
    });
    return;
  }
  const fingerprint = canonicalJson({ tool, args });
  const existing = context.calls.get(callId);
  if (existing && existing.fingerprint !== fingerprint) {
    try { context.onRejectedCall?.({ tool, callId, arguments: args }, "Duplicate call identity conflict."); } catch {}
    outcome = "error";
    writeRpc(response, id, { isError: true, content: [{ type: "text", text: "Duplicate call identity conflict." }] });
    return;
  }
  const controller = existing === undefined ? new AbortController() : undefined;
  const execution = existing?.promise ?? withCancellationAndTimeout(
    context.handler({ tool, callId, arguments: structuredClone(args), signal: controller!.signal }),
    controller!,
    context.privateToolNames.has(tool) ? context.privateToolTimeoutMs : context.timeoutMs,
  );
  if (!existing) {
    if (context.calls.size >= 2_048) context.calls.delete(context.calls.keys().next().value!);
    context.calls.set(callId, { fingerprint, promise: execution, waiting: new Set() });
    context.controllers.set(callId, controller!);
    void execution.finally(() => context.controllers.delete(callId)).catch(() => undefined);
  }
  // A client that drops its connection has abandoned the call just like one
  // that sends notifications/cancelled. Abort once no connection still waits
  // on this call identity, so a call still waiting to be handed to the
  // controller is never dispatched after every client gave up. A live retry
  // of the same call keeps it alive.
  const waiting = (existing ?? context.calls.get(callId))?.waiting;
  if (waiting && context.controllers.has(callId)) {
    waiting.add(response);
    response.once("close", () => {
      waiting.delete(response);
      if (!response.writableFinished && waiting.size === 0) context.controllers.get(callId)?.abort();
    });
  }
  try {
    const result = await execution;
    const text = safeJson(result);
    outcome = "result";
    writeRpc(response, id, { content: [{ type: "text", text }] });
  } catch (error) {
    outcome = "error";
    writeRpc(response, id, { isError: true, content: [{ type: "text", text: safeError(error) }] });
  }
}

function authorized(value: string | undefined, secret: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("MCP request exceeded the retained payload limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseMessage(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC request");
  return parsed;
}

function writeRpc(response: ServerResponse, id: unknown, result?: unknown, error?: unknown): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) }));
}

function rpcError(code: number, message: string) {
  return { code, message };
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

function withCancellationAndTimeout<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMs: number | null,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("Paperclip tool call cancelled")));
    const timer = timeoutMs === null ? undefined : setTimeout(() => {
      finish(() => reject(new Error("Paperclip tool call timed out")));
      controller.abort();
    }, timeoutMs);
    timer?.unref?.();
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
  const tooLarge = () => new Error(
    "Tool result delivery exceeded the 1 MiB MCP limit. The action may already have completed; do not repeat it. Reconcile its saved result or receipt instead.",
  );
  // Separator accounting is conservative (it includes the first entry too).
  // Twice the output limit admits every result within the exact byte cap.
  let budget = 2 * MAX_RESULT_BYTES;
  let root = true;
  const charge = (text: string) => {
    // Check length before measuring UTF-8 so even a huge scalar is rejected
    // without copying it. JSON escaping can expand the final value further.
    if (text.length > budget) throw tooLarge();
    budget -= Buffer.byteLength(text);
    if (budget < 0) throw tooLarge();
  };
  const serialized = JSON.stringify(value, function (key, entry: unknown) {
    const first = root;
    root = false;
    const scalar = entry === null || typeof entry !== "object";
    const omitted = entry === undefined || typeof entry === "function" || typeof entry === "symbol";
    if (omitted && !Array.isArray(this)) return entry;
    if (!first) {
      charge(",");
      if (!Array.isArray(this)) { charge(key); charge('"":'); }
    }
    if (typeof entry === "string" || entry instanceof String) { charge(String(entry)); charge('""'); }
    else if (!scalar) charge("{}");
    else charge(omitted ? "null" : JSON.stringify(entry) ?? "null");
    return entry;
  }) ?? "null";
  // The traversal budget bounds allocation even for many small fields. This
  // exact check also accounts for quotes, control characters and UTF-8 bytes.
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) throw tooLarge();
  return serialized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
