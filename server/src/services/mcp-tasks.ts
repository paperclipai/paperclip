import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { MCP_TASKS_EXTENSION_ID, mcpHttpRequestInit, readMcpHttpResponse } from "./mcp-http.js";

/**
 * MCP Tasks extension (io.modelcontextprotocol/tasks, 2026-07-28).
 *
 * A server may answer `tools/call` with a durable task handle instead of the
 * result. This module owns the protocol: parsing task states, bounding the
 * server's timing hints, and sending `tasks/get`, `tasks/update`, and
 * `tasks/cancel`. The tool gateway owns credentials, storage, and delivery.
 */
export { MCP_TASKS_EXTENSION_ID };

export const MCP_TASK_STATUSES = ["working", "input_required", "completed", "failed", "cancelled"] as const;
export type McpTaskStatus = typeof MCP_TASK_STATUSES[number];
/** `expired` is Paperclip's own: the provider no longer knows the task, or its TTL passed. */
export type McpTaskRecordStatus = McpTaskStatus | "expired";
export const MCP_TASK_ACTIVE_STATUSES: readonly McpTaskRecordStatus[] = ["working", "input_required"];

/** Paperclip stops tracking any task after this long, whatever its TTL says. */
export const MCP_TASK_MAX_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const MAX_TASK_ID_LENGTH = 512;
const INLINE_POLL_MIN_MS = 200;
const INLINE_POLL_MAX_MS = 5_000;
const BACKGROUND_POLL_MIN_MS = 5_000;
const BACKGROUND_POLL_MAX_MS = 5 * 60_000;
/**
 * A task waiting for a person is checked slowly: nothing happens until they
 * answer, and their answer wakes the agent, whose call checks right away.
 */
const BACKGROUND_INPUT_POLL_MS = 5 * 60_000;

export type McpTaskInputRequest = { method: string; params: Record<string, unknown> };

export type McpTaskState = {
  taskId: string;
  status: McpTaskStatus;
  ttlMs: number | null;
  pollIntervalMs: number | null;
  createdAt: Date | null;
  result?: Record<string, unknown>;
  error?: { code: number | null; message: string };
  inputRequests?: Record<string, McpTaskInputRequest>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 2 ** 31 - 1) : null;
}

/**
 * Read a task from a `CreateTaskResult` (`resultType: "task"`) or a
 * `tasks/get` result. Returns null for anything that is not a well-formed task.
 */
export function parseMcpTask(value: unknown): McpTaskState | null {
  const task = record(value);
  if (!task) return null;
  const taskId = task.taskId;
  if (typeof taskId !== "string" || !taskId || taskId.length > MAX_TASK_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(taskId)) return null;
  const status = task.status;
  if (typeof status !== "string" || !(MCP_TASK_STATUSES as readonly string[]).includes(status)) return null;
  const created = typeof task.createdAt === "string" ? new Date(task.createdAt) : null;
  const state: McpTaskState = {
    taskId,
    status: status as McpTaskStatus,
    ttlMs: nonNegativeInt(task.ttlMs),
    pollIntervalMs: nonNegativeInt(task.pollIntervalMs),
    createdAt: created && Number.isFinite(created.getTime()) ? created : null,
  };
  if (state.status === "completed") {
    const result = record(task.result);
    if (!result) return null;
    state.result = result;
  }
  if (state.status === "failed") {
    const error = record(task.error);
    state.error = {
      code: typeof error?.code === "number" ? error.code : null,
      message: typeof error?.message === "string" ? error.message : "",
    };
  }
  if (state.status === "input_required") {
    const inputRequests: Record<string, McpTaskInputRequest> = {};
    for (const [key, entry] of Object.entries(record(task.inputRequests) ?? {}).slice(0, 32)) {
      const request = record(entry);
      if (key.length <= 256 && typeof request?.method === "string") inputRequests[key] = { method: request.method, params: record(request.params) ?? {} };
    }
    state.inputRequests = inputRequests;
  }
  return state;
}

/** The task a `tools/call` returned in place of its result, if it did. */
export function mcpCreatedTask(result: unknown): McpTaskState | null {
  return record(result)?.resultType === "task" ? parseMcpTask(result) : null;
}

export function isMcpTaskTerminal(status: McpTaskRecordStatus): boolean {
  return status !== "working" && status !== "input_required";
}

/** How long a live call waits before its next `tasks/get`. */
export function inlinePollDelayMs(pollIntervalMs: number | null): number {
  return Math.min(INLINE_POLL_MAX_MS, Math.max(INLINE_POLL_MIN_MS, pollIntervalMs ?? 1_000));
}

/**
 * How long background polling waits. The server's hint is honored within
 * bounds, failures back off, and a task waiting for a person is checked slowly.
 */
export function backgroundPollDelayMs(input: { pollIntervalMs: number | null; status: McpTaskRecordStatus; failures?: number }): number {
  const base = Math.min(BACKGROUND_POLL_MAX_MS, Math.max(BACKGROUND_POLL_MIN_MS, input.pollIntervalMs ?? BACKGROUND_POLL_MIN_MS));
  const waiting = input.status === "input_required" ? Math.max(base, BACKGROUND_INPUT_POLL_MS) : base;
  const failures = Math.min(input.failures ?? 0, 6);
  return Math.min(BACKGROUND_POLL_MAX_MS, waiting * 2 ** failures);
}

/** When Paperclip gives up on a task: the provider's TTL from creation, capped. */
export function mcpTaskExpiresAt(task: Pick<McpTaskState, "createdAt" | "ttlMs">, now = Date.now(), trackedSince?: Date): Date {
  const created = task.createdAt && task.createdAt.getTime() <= now ? task.createdAt.getTime() : now;
  // The cap counts from when Paperclip first saw the task, so a provider that
  // keeps extending its TTL cannot keep it tracked forever.
  const limit = (trackedSince?.getTime() ?? now) + MCP_TASK_MAX_LIFETIME_MS;
  return new Date(task.ttlMs === null ? limit : Math.min(limit, created + task.ttlMs));
}

/**
 * The identity of a call: a repeated call attaches only when all of it
 * matches. `argumentsIdentity` is the gateway's keyed request identity, so a
 * stored hash cannot be used to guess secret arguments.
 */
export function mcpTaskRequestHash(input: { connectionId: string; endpoint: string; toolName: string; argumentsIdentity: string; routingIdentity?: string }): string {
  return createHash("sha256").update(JSON.stringify(["paperclip:mcp-task-request:v1", input.connectionId, input.endpoint, input.toolName, input.argumentsIdentity, input.routingIdentity ?? ""])).digest("hex");
}

export function mcpTaskEndpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

/*
 * A task ID may work as a bearer token for the provider's stored state (spec:
 * Security Considerations), so it is sealed at rest and indexed by a keyed hash.
 */
const TASK_ID_CONTEXT = "paperclip:mcp-task-id:v1";

function taskIdKey(secret: string, purpose: "seal" | "index") {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `${TASK_ID_CONTEXT}:${purpose}`, 32));
}

function taskIdAad(scope: { companyId: string; connectionId: string }) {
  return Buffer.from(JSON.stringify([TASK_ID_CONTEXT, scope.companyId, scope.connectionId]));
}

export function mcpTaskIdIndex(secret: string, scope: { companyId: string; connectionId: string }, taskId: string): string {
  return createHmac("sha256", taskIdKey(secret, "index")).update(taskIdAad(scope)).update("\0").update(taskId).digest("hex");
}

export function sealMcpTaskId(secret: string, scope: { companyId: string; connectionId: string }, taskId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", taskIdKey(secret, "seal"), iv);
  cipher.setAAD(taskIdAad(scope));
  const ciphertext = Buffer.concat([cipher.update(taskId, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

/** The task ID, or null when the sealed value is not one this instance wrote for this scope. */
export function openMcpTaskId(secret: string, scope: { companyId: string; connectionId: string }, sealed: string): string | null {
  const [version, iv, ciphertext, tag] = sealed.split(".");
  if (version !== "v1" || !iv || !ciphertext || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", taskIdKey(secret, "seal"), Buffer.from(iv, "base64url"));
    decipher.setAAD(taskIdAad(scope));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** JSON-RPC `-32602` from `tasks/*`: the task is unknown, expired, or purged. */
export const MCP_TASK_NOT_FOUND_CODE = -32602;

export class McpTaskRequestError extends Error {
  constructor(
    readonly kind: "http" | "rpc" | "malformed",
    message: string,
    readonly httpStatus: number | null = null,
    readonly rpcCode: number | null = null,
  ) {
    super(message);
    this.name = "McpTaskRequestError";
  }
  get taskNotFound() { return this.kind === "rpc" && this.rpcCode === MCP_TASK_NOT_FOUND_CODE; }
}

export type McpTaskTransport = {
  /** Headers with credentials and the stateless protocol version. */
  headers: () => Promise<Record<string, string>>;
  /** Fresh credentials after a 401; tasks/* never change provider state twice. */
  refreshHeaders?: () => Promise<Record<string, string>>;
  send: (init: RequestInit) => Promise<Response>;
  maxBytes: number;
};

/**
 * Send one `tasks/*` request. `Mcp-Name` carries the task ID so intermediaries
 * route it to the instance that holds the task (spec: Streamable HTTP).
 */
export async function sendMcpTaskRequest(
  transport: McpTaskTransport,
  method: "tasks/get" | "tasks/update" | "tasks/cancel",
  params: { taskId: string } & Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const id = `paperclip-task-${randomUUID()}`;
  const attempt = (headers: Record<string, string>) => transport.send({
    ...mcpHttpRequestInit(headers, { id, method, params }, { declareTasks: true }),
    redirect: "manual",
    signal,
  });
  let response = await attempt(await transport.headers());
  if (response.status === 401 && transport.refreshHeaders) {
    await response.body?.cancel().catch(() => undefined);
    response = await attempt(await transport.refreshHeaders());
  }
  if (!response.ok) {
    // A modern server answers an unknown task with a JSON-RPC error, which
    // can arrive with an HTTP error status.
    // Read at most 64 KiB of a provider-controlled error body, then stop.
    const text = await readBoundedText(response, 64 * 1024).catch(() => "");
    let payload: Record<string, unknown> | null = null;
    try { payload = record(JSON.parse(text)); } catch { /* Not JSON, or cut short. */ }
    const error = record(payload?.error);
    if (error && typeof error.code === "number") throw new McpTaskRequestError("rpc", "The app rejected the task request.", response.status, error.code);
    throw new McpTaskRequestError("http", "The app returned an HTTP error for the task request.", response.status);
  }
  const payload = record(await readMcpHttpResponse(response, id, { maxBytes: transport.maxBytes }));
  if (!payload) throw new McpTaskRequestError("malformed", "The app returned a malformed task response.");
  const error = record(payload.error);
  if (error) throw new McpTaskRequestError("rpc", "The app rejected the task request.", response.status, typeof error.code === "number" ? error.code : null);
  const result = record(payload.result);
  if (!result) throw new McpTaskRequestError("malformed", "The app returned a malformed task response.");
  return result;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.byteLength + bytes > maxBytes ? value.subarray(0, maxBytes - bytes) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return text;
}

export async function getMcpTask(transport: McpTaskTransport, taskId: string, signal?: AbortSignal): Promise<McpTaskState> {
  const task = parseMcpTask(await sendMcpTaskRequest(transport, "tasks/get", { taskId }, signal));
  if (!task || task.taskId !== taskId) throw new McpTaskRequestError("malformed", "The app returned a malformed task response.");
  return task;
}

/** Best effort: cancellation is cooperative and its failure changes nothing here. */
export async function cancelMcpTask(transport: McpTaskTransport, taskId: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    await sendMcpTaskRequest(transport, "tasks/cancel", { taskId }, AbortSignal.timeout(timeoutMs));
    return true;
  } catch {
    return false;
  }
}

/** Sleep until `ms` passes or `signal` aborts; resolves false when aborted. */
export function waitForPoll(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
