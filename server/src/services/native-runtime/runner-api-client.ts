import { z } from "zod";
import { badRequest, forbidden, unprocessable } from "../../errors.js";
import { runnerApiOperation, type RunnerApiOperation } from "./runner-api-catalog.js";
import { runnerApiRestriction } from "./runner-api-policy.js";

export const RUNNER_API_MAX_BYTES = 10 * 1024 * 1024;
export const RUNNER_API_INLINE_BYTES = 24 * 1024;
export const RUNNER_API_TIMEOUT_MS = 30_000;
const fileSchema = z.object({
  field: z.string().min(1).max(200).optional(),
  artifactId: z.string().min(1).optional(),
  path: z.string().min(1).max(1000).optional(),
}).strict().refine((file) => Boolean(file.artifactId) !== Boolean(file.path), "Specify exactly one artifactId or workspace path");
export const runnerApiCallSchema = z.object({
  operationId: z.string().min(1).max(500),
  pathParams: z.record(z.string().max(200), z.string().max(1000)).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional(),
  contentType: z.string().max(120).optional(),
  files: z.array(fileSchema).max(10).optional(),
}).strict();
export type RunnerApiCall = z.infer<typeof runnerApiCallSchema>;
export type RunnerApiFile = z.infer<typeof fileSchema>;
export interface RunnerApiContext {
  companyId: string;
  issueId: string;
  issueIdentifier?: string | null;
  runId: string;
  workMode: string;
}
export interface RunnerApiIo {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Revalidate server-owned authority after asynchronous file preparation. */
  beforeDispatch?(): Promise<void>;
  readFile(file: RunnerApiFile): Promise<{ bytes: Buffer; filename: string; contentType: string }>;
  saveResponse(bytes: Buffer, contentType: string): Promise<Record<string, unknown>>;
}

export function validateRunnerApiCall(value: unknown, context: RunnerApiContext): { input: RunnerApiCall; operation: RunnerApiOperation } {
  const parsed = runnerApiCallSchema.safeParse(value);
  if (!parsed.success) throw badRequest("Invalid call_api arguments", { issues: parsed.error.issues });
  const input = parsed.data;
  const operation = runnerApiOperation(input.operationId);
  if (operation.transport !== "rest") throw unprocessable("This endpoint requires its existing protocol client; call_api supports REST only");
  const restriction = runnerApiRestriction(operation.method, operation.path);
  if (restriction) throw forbidden(restriction);
  if (!operation.allowedModes.includes(context.workMode)) throw forbidden("call_api permits only reads in Ask and Plan modes; use the permitted dedicated tools");
  if (input.pathParams?.companyId && input.pathParams.companyId !== context.companyId) throw forbidden("API call belongs to another company");
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(operation.method);
  if (mutation) {
    const issueRoute = /^\/api\/issues\/\{[^}]+\}/.test(operation.path);
    const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
    // Raw uploads must not hide lifecycle fields from the structured policy
    // check and subsequently become JSON inside Express's body parser.
    const guardedBody = /^\/api\/(issues|agents)\/\{[^}]+\}$/.test(operation.path)
      || (issueRoute && /\/comments$/.test(operation.path));
    if (guardedBody && (input.files?.length || (input.body !== undefined && (!input.body || typeof input.body !== "object" || Array.isArray(input.body))))) {
      throw forbidden("Lifecycle-sensitive API updates require an inline JSON object");
    }
    if (/^\/api\/agents\/\{[^}]+\}$/.test(operation.path) && ["status", "runtimeState"].some(key => Object.hasOwn(body, key))) {
      throw forbidden("API agent updates cannot bypass runner execution-control authority");
    }
    if (issueRoute && /\/comments$/.test(operation.path) && ["reopen", "resume", "interrupt"].some(key => body[key] === true)) {
      throw forbidden("API comments cannot change runner execution state");
    }
    if (issueRoute && /\/issues\/\{[^}]+\}$/.test(operation.path)) {
      const lifecycle = ["status", "workMode", "executionRunId", "checkoutRunId", "executionState", "executionPolicy", "executionAgentNameKey", "executionLockedAt", "completedAt", "cancelledAt", "startedAt", "assigneeAgentId", "assigneeUserId", "blockedByIssueIds", "reopen", "resume", "interrupt"];
      if (lifecycle.some((key) => Object.hasOwn(body, key))) throw forbidden("Use dedicated completion, review, delegation or dependency tools for task lifecycle changes");
      // The real issue router normalizes identifiers and PostgreSQL accepts
      // uppercase UUIDs. Apply the same identity comparison before dispatch.
      const target = Object.values(input.pathParams ?? {}).map(id => id.trim().toLowerCase());
      const activeIds = [context.issueId, context.issueIdentifier].filter((id): id is string => Boolean(id)).map(id => id.toLowerCase());
      if (operation.method === "DELETE" && target.some(id => activeIds.includes(id))) throw forbidden("The active runner task cannot delete itself");
    }
  }
  const contentType = (input.contentType ?? "application/json").split(";", 1)[0].trim().toLowerCase();
  if (input.body !== undefined && !input.files?.length) {
    const requestSchema = operation.requestBody?.content?.[contentType]?.schema as { type?: string } | undefined;
    if (contentType.includes("json") && requestSchema?.type === "object" && (!input.body || typeof input.body !== "object" || Array.isArray(input.body))) {
      throw badRequest("This operation requires body to be a JSON object. Pass the object directly, not a JSON-encoded string.");
    }
    if (contentType.includes("json") && requestSchema?.type === "array" && !Array.isArray(input.body)) {
      throw badRequest("This operation requires body to be a JSON array. Pass the array directly, not a JSON-encoded string.");
    }
  }
  return { input, operation };
}

export function runnerApiUrl(operation: RunnerApiOperation, input: RunnerApiCall, context: RunnerApiContext, apiUrl: string): URL {
  const origin = new URL(apiUrl);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error("Invalid configured Paperclip API origin");
  const params = { ...input.pathParams };
  if (operation.path.includes("{companyId}")) params.companyId ??= context.companyId;
  const names = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  for (const name of Object.keys(params)) if (!names.includes(name)) throw badRequest(`Unknown path parameter: ${name}`);
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (!value || value === "." || value === ".." || /[\\/\x00-\x1f]/.test(value) || /%[0-9a-f]{2}/i.test(value)) throw badRequest(`Invalid or missing path parameter: ${name}`);
    return encodeURIComponent(value);
  });
  const url = new URL(path, origin.origin);
  if (url.origin !== origin.origin || !url.pathname.startsWith("/api/")) throw badRequest("Invalid API path");
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null) continue;
    const parameter = operation.parameters.find((entry) => entry.in === "query" && entry.name === key);
    const values = Array.isArray(value) ? value : [value];
    if (values.some((entry) => !["string", "number", "boolean"].includes(typeof entry))) throw badRequest(`Query parameter ${key} must contain scalar values`);
    if (Array.isArray(value) && parameter?.explode === false) url.searchParams.set(key, values.join(","));
    else for (const entry of values) url.searchParams.append(key, String(entry));
  }
  if (url.href.length > 16_384) throw badRequest("API URL exceeds the request limit");
  return url;
}

export async function readBoundedResponse(response: Response, maxBytes = RUNNER_API_MAX_BYTES): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw unprocessable("API response exceeds the transfer limit; narrow the request");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw unprocessable("API response exceeds the transfer limit; narrow the request");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function executeRunnerApi(input: RunnerApiCall, context: RunnerApiContext, io: RunnerApiIo) {
  const { operation } = validateRunnerApiCall(input, context);
  const url = runnerApiUrl(operation, input, context, io.apiUrl);
  if (!io.token) throw new Error("Paperclip run authentication is unavailable");
  const headers = new Headers({ Authorization: `Bearer ${io.token}`, "X-Paperclip-Run-Id": context.runId });
  let body: BodyInit | undefined;
  const contentType = input.contentType ?? (input.files?.length ? "multipart/form-data" : "application/json");
  if (/\r|\n/.test(contentType)) throw badRequest("Invalid content type");
  let totalBytes = 0;
  if (input.files?.length) {
    if (["GET", "HEAD"].includes(operation.method)) throw badRequest("Read requests cannot upload files");
    const form = new FormData();
    if (input.body !== undefined && (!input.body || typeof input.body !== "object" || Array.isArray(input.body))) throw badRequest("Multipart body must be an object of form fields");
    for (const [key, value] of Object.entries((input.body ?? {}) as Record<string, unknown>)) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      totalBytes += Buffer.byteLength(text);
      form.append(key, text);
    }
    for (const file of input.files) {
      const resolved = await io.readFile(file);
      totalBytes += resolved.bytes.length;
      if (totalBytes > RUNNER_API_MAX_BYTES) throw badRequest("API upload exceeds the transfer limit");
      if (contentType === "multipart/form-data") form.append(file.field ?? "file", new Blob([new Uint8Array(resolved.bytes)], { type: resolved.contentType }), resolved.filename);
      else {
        if (input.files.length !== 1 || input.body !== undefined) throw badRequest("Raw uploads require exactly one file and no body");
        body = new Uint8Array(resolved.bytes);
      }
    }
    if (contentType === "multipart/form-data") body = form;
    else headers.set("Content-Type", contentType);
  } else if (input.body !== undefined) {
    if (["GET", "HEAD"].includes(operation.method)) throw badRequest("Read requests cannot have a body");
    body = contentType.includes("json") ? JSON.stringify(input.body) : typeof input.body === "string" ? input.body : undefined;
    if (body === undefined) throw badRequest("Non-JSON request bodies must be strings");
    if (Buffer.byteLength(body) > RUNNER_API_MAX_BYTES) throw badRequest("API request exceeds the transfer limit");
    headers.set("Content-Type", contentType);
  }
  let response: Response;
  let bytes: Buffer;
  await io.beforeDispatch?.();
  try {
    response = await (io.fetch ?? fetch)(url, { method: operation.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(RUNNER_API_TIMEOUT_MS) });
    bytes = await readBoundedResponse(response);
  } catch {
    return { ok: false, status: null, operationId: operation.operationId, error: "api_transport_failure", outcome: ["GET", "HEAD", "OPTIONS"].includes(operation.method) ? "read_failed" : "unknown", guidance: "Inspect current state before retrying a mutation; it may already have succeeded." };
  }
  const type = response.headers.get("content-type") ?? "application/octet-stream";
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(operation.method);
  // A server can commit a write before an error response or redirect. Preserve
  // the HTTP evidence, but never describe that write as definitely not applied.
  const uncertain = mutation && (response.status >= 500 || response.status === 408 || (response.status >= 300 && response.status < 400));
  const uncertainty = { outcome: "unknown", guidance: "Inspect current state before retrying this mutation; it may already have succeeded." };
  const base = { ok: response.ok, status: response.status, operationId: operation.operationId, contentType: type, retryAfter: response.headers.get("retry-after"), ...(uncertain ? uncertainty : {}) };
  if (response.status >= 300 && response.status < 400) return { ...base, ok: false, error: "api_redirect_not_followed" };
  if (!bytes.length) return { ...base, data: null };
  if (bytes.length > RUNNER_API_INLINE_BYTES || !/json|^text\//i.test(type)) {
    return { ...base, artifact: await io.saveResponse(bytes, type), byteSize: bytes.length, preview: /json|^text\//i.test(type) ? bytes.subarray(0, 2000).toString("utf8") : null };
  }
  const text = bytes.toString("utf8");
  if (/json/i.test(type)) {
    try { return { ...base, data: JSON.parse(text) as unknown }; }
    catch { return { ...base, ok: false, error: "invalid_json_response", data: text, ...(mutation ? uncertainty : {}) }; }
  }
  return { ...base, data: text };
}
