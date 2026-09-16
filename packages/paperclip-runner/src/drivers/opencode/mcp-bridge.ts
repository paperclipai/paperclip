import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import {
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
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
  timeoutMs?: number;
  /** Human-gated private operations may remain pending much longer than model tool calls. */
  privateToolTimeoutMs?: number;
  maxBodyBytes?: number;
  secret?: string;
}

export interface OpenCodeMcpBridge {
  url: string;
  secret: string;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

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
  const calls = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  const controllers = new Map<string, AbortController>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      secret,
      tools,
      admittedTools,
      validators,
      calls,
      controllers,
      handler: options.handler,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    secret,
    close: async () => {
      for (const controller of controllers.values()) controller.abort();
      await closeServer(server);
    },
  };
}

function normalizeTools(
  input: readonly Readonly<Record<string, unknown>>[],
  includeTerminalTools = true,
): OpenCodeMcpToolDefinition[] {
  const tools: OpenCodeMcpToolDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const name = typeof raw.name === "string" ? canonicalOpenCodeMcpToolName(raw.name) : "";
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
    { name: PRP_COMPLETION_TOOL_NAME, description: "Return the semantic completion result.", inputSchema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA },
    { name: PRP_BLOCK_TOOL_NAME, description: "Return the semantic blocked result.", inputSchema: PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA },
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
    secret: string;
    tools: OpenCodeMcpToolDefinition[];
    admittedTools: OpenCodeMcpToolDefinition[];
    validators: Map<string, ValidateFunction>;
    calls: Map<string, { fingerprint: string; promise: Promise<unknown> }>;
    controllers: Map<string, AbortController>;
    handler: OpenCodeMcpBridgeOptions["handler"];
    timeoutMs: number;
    privateToolTimeoutMs: number;
    privateToolNames: ReadonlySet<string>;
    maxBodyBytes: number;
  },
): Promise<void> {
  setSecurityHeaders(response);
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
  const rawName = typeof params.name === "string" ? params.name : "";
  const tool = canonicalOpenCodeMcpToolName(rawName);
  if (!context.admittedTools.some((entry) => entry.name === tool)) {
    writeRpc(response, id, { isError: true, content: [{ type: "text", text: "Unsupported tool." }] });
    return;
  }
  const callId = typeof id === "string" || typeof id === "number" ? String(id) : randomBytes(12).toString("hex");
  const args = params.arguments ?? {};
  const validator = context.validators.get(tool);
  if (validator === undefined || !validator(args)) {
    const detail = validator?.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
    writeRpc(response, id, {
      isError: true,
      content: [{ type: "text", text: `Invalid tool input${detail ? `: ${detail}` : "."}` }],
    });
    return;
  }
  const fingerprint = canonicalJson({ tool, args });
  const existing = context.calls.get(callId);
  if (existing && existing.fingerprint !== fingerprint) {
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
    context.calls.set(callId, { fingerprint, promise: execution });
    context.controllers.set(callId, controller!);
    void execution.finally(() => context.controllers.delete(callId)).catch(() => undefined);
  }
  try {
    const result = await execution;
    writeRpc(response, id, { content: [{ type: "text", text: safeJson(result) }] });
  } catch (error) {
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
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
    const onAbort = () => finish(() => reject(new Error("Paperclip tool call cancelled")));
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Paperclip tool call timed out")));
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
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
  const serialized = JSON.stringify(value);
  return (serialized ?? "null").slice(0, 64 * 1024);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
