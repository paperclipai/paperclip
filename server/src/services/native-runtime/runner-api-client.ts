import { z } from "zod";
import { badRequest, forbidden, unprocessable } from "../../errors.js";
import { runnerApiSensitiveResponse } from "./runner-api-sensitive-response.js";
import { runnerApiOperation, type RunnerApiOperation } from "./runner-api-catalog.js";
import { captureRunnerApiResponse, type RunnerApiResponseBody } from "./runner-api-response.js";
import { RunnerApiResponseLimitError, RunnerApiResponseCleanupError, RUNNER_API_RESPONSE_MAX_BYTES } from "./runner-api-response-limits.js";

/** Request/upload bound only. Response capture has a separate streamed limit. */
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
  saveResponse: z.boolean().optional(),
  responseText: z.object({
    offsetBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limitBytes: z.number().int().min(4).max(RUNNER_API_INLINE_BYTES).optional(),
  }).strict().optional(),
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
  /** Server-owned page size for the dedicated saved-result reader. */
  responseTextPageBytes?: number;
  /** Revalidate server-owned authority after asynchronous file preparation. */
  beforeDispatch?(): Promise<void>;
  /** Reserve before spilling. Settle completed bytes; failed captures retain their reservation. */
  reserveResponseCapture?(): Promise<(completedBytes?: number, cleanupSucceeded?: boolean) => Promise<void>>;
  readFile(file: RunnerApiFile): Promise<{ bytes: Buffer; filename: string; contentType: string }>;
  saveResponse(bytes: RunnerApiResponseBody, contentType: string): Promise<Record<string, unknown>>;
}

export function validateRunnerApiCall(value: unknown, context: RunnerApiContext): { input: RunnerApiCall; operation: RunnerApiOperation } {
  const parsed = runnerApiCallSchema.safeParse(value);
  if (!parsed.success) throw badRequest("Invalid call_api arguments", { issues: parsed.error.issues });
  let input = parsed.data;
  const operation = runnerApiOperation(input.operationId);
  if (operation.transport !== "rest") throw unprocessable(`This endpoint requires its existing protocol client; call_api supports REST only and no other API route substitutes for it.${operation.description.trim() ? " Read its catalog description for details." : ""}`);
  if (input.saveResponse && (operation.method !== "GET" || runnerApiSensitiveResponse(operation.method, operation.path))) {
    throw badRequest("This request was not sent: saveResponse supports non-sensitive GET reads only.");
  }
  if (input.saveResponse && input.responseText) throw badRequest("Use either saveResponse or responseText, not both.");
  if (input.responseText && operation.method !== "GET") {
    // A later page of a mutation response would need the mutation repeated.
    // A first-window request changes only presentation, so the mutation runs
    // once and its response is returned through the normal inline/artifact path.
    if ((input.responseText.offsetBytes ?? 0) > 0) throw badRequest("This request was not sent: responseText.offsetBytes applies only to GET reads, and a later page of a mutation response would repeat the mutation. Remove responseText and send the mutation once; read any saved response artifact with GET /api/assets/{assetId}/content.");
    const { responseText: _ignored, ...rest } = input;
    input = rest;
  }
  if (!operation.allowedModes.includes(context.workMode)) throw forbidden("call_api permits only reads in Ask and Plan modes; use the permitted dedicated tools");
  if (input.pathParams?.companyId && input.pathParams.companyId !== context.companyId) throw forbidden("API call belongs to another company");
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

/**
 * Rules for a new dispatch only. Recovery and saved receipts still validate an
 * older accepted call with validateRunnerApiCall, so these rules stay out of it.
 * Callers that reserve a mutation receipt must run this before the reservation.
 */
export function assertRunnerApiDispatchable(operation: RunnerApiOperation, input: RunnerApiCall, received: Readonly<Record<string, unknown>>): void {
  assertBodyPresent(operation, input, Object.keys(received));
  if (operation.method !== "GET" && setsResponseWindow(received.responseText)) {
    throw badRequest(`This request was not sent: responseText applies only to GET reads and never carries request fields. Resend ${operation.operationId} once without responseText, with its request fields in body${requestFieldHint(operation)}.`);
  }
}

function setsResponseWindow(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, setting]) => setting !== undefined && !(key === "offsetBytes" && setting === 0));
}

function assertBodyPresent(operation: RunnerApiOperation, input: RunnerApiCall, receivedKeys: readonly string[]): void {
  if (input.body !== undefined || input.files?.length || !operation.requestBody?.required) return;
  // A PATCH without a body succeeds as a no-op that reads like a completed
  // update. A POST or PUT without a body whose schema names required fields
  // can only fail at the route. Name the missing argument before sending.
  const schema = operation.requestBody.content?.["application/json"]?.schema as { required?: unknown } | undefined;
  const requiresFields = Array.isArray(schema?.required) && schema.required.length > 0;
  if (!(operation.method === "PATCH" || ((operation.method === "POST" || operation.method === "PUT") && requiresFields))) return;
  const received = [...receivedKeys].sort();
  const misplaced = received.filter(key => ["query", "responseText", "saveResponse"].includes(key));
  throw badRequest(`This request was not sent: ${operation.operationId} requires body, a JSON object with the request fields${requestFieldHint(operation)}. `
    + `Received arguments: ${received.join(", ")}. Resend with a top-level body argument: {"operationId": ${JSON.stringify(operation.operationId)}, "pathParams": {...}, "body": {...}}.`
    + (misplaced.length ? ` ${misplaced.join(", ")} never carr${misplaced.length === 1 ? "ies" : "y"} request fields.` : ""));
}

function requestFieldHint(operation: RunnerApiOperation): string {
  const schema = operation.requestBody?.content?.["application/json"]?.schema as { properties?: Record<string, unknown> } | undefined;
  const fields = Object.keys(schema?.properties ?? {});
  if (!fields.length) return "";
  return ` (allowed fields: ${fields.slice(0, 12).join(", ")}${fields.length > 12 ? ", ..." : ""})`;
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

/**
 * Page position reported by capped list routes (for example
 * GET /api/companies/{companyId}/issues) through X-Paperclip-Has-More and its
 * sibling headers. Agents never see response headers, so surface it beside the
 * data; otherwise a capped page reads as the complete list.
 */
export function runnerApiPagination(headers: Headers) {
  const hasMoreHeader = headers.get("x-paperclip-has-more");
  if (hasMoreHeader !== "true" && hasMoreHeader !== "false") return undefined;
  const hasMore = hasMoreHeader === "true";
  const limit = Number(headers.get("x-paperclip-limit"));
  const offsetHeader = headers.get("x-paperclip-next-offset");
  const nextOffset = offsetHeader !== null && /^\d+$/.test(offsetHeader) ? Number(offsetHeader) : null;
  const nextAfterId = hasMore ? headers.get("x-paperclip-next-after-id") : null;
  const next = [
    ...(nextAfterId ? [`afterId=${nextAfterId}`] : []),
    ...(nextOffset !== null ? [`offset=${nextOffset}`] : []),
  ];
  return {
    hasMore,
    truncated: hasMore,
    ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {}),
    nextOffset: hasMore ? nextOffset : null,
    ...(nextAfterId ? { nextAfterId } : {}),
    ...(hasMore ? { guidance: `This list is incomplete: the page limit was reached and more results exist. Repeat the same call with the same filters and ${next.length ? next.join(" or ") : "the next page"} in query; continue until pagination.hasMore is false before treating the list as complete.` } : {}),
  };
}

export async function executeRunnerApi(input: RunnerApiCall, context: RunnerApiContext, io: RunnerApiIo) {
  const inlineBytes = RUNNER_API_INLINE_BYTES;
  const { operation, input: validated } = validateRunnerApiCall(input, context);
  assertRunnerApiDispatchable(operation, validated, input);
  input = validated;
  const sensitiveResponse = runnerApiSensitiveResponse(operation.method, operation.path);
  const url = runnerApiUrl(operation, input, context, io.apiUrl);
  if (!io.token) throw new Error("Paperclip run authentication is unavailable");
  const headers = new Headers({ Authorization: `Bearer ${io.token}`, "X-Paperclip-Run-Id": context.runId });
  const textOffset = input.responseText?.offsetBytes ?? 0;
  const textLimit = input.responseText?.limitBytes
    ?? (input.responseText ? io.responseTextPageBytes : undefined) ?? RUNNER_API_INLINE_BYTES;
  const assetTextRange = operation.operationId === "GET /api/assets/{assetId}/content" && !input.saveResponse
    ? { start: Math.max(0, textOffset - 1), end: Math.min(Number.MAX_SAFE_INTEGER, textOffset + textLimit) }
    : undefined;
  // One byte before the requested offset permits an EOF read; one byte after
  // the page lets the decoder trim an incomplete UTF-8 code point.
  if (assetTextRange) headers.set("Range", `bytes=${assetTextRange.start}-${assetTextRange.end}`);
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
  let captured: Awaited<ReturnType<typeof captureRunnerApiResponse>> | undefined;
  let settleCapture: ((completedBytes?: number, cleanupSucceeded?: boolean) => Promise<void>) | undefined;
  const disposeCapture = async (priorCleanupSucceeded = true) => {
    let cleaned = false;
    try { await captured?.dispose(); cleaned = priorCleanupSucceeded; }
    finally { await settleCapture?.(captured?.byteSize, cleaned); }
  };
  const saveResponse = async (body: RunnerApiResponseBody, type: string) => {
    // Small binary responses also create assets and need storage admission.
    settleCapture ??= await io.reserveResponseCapture?.();
    return io.saveResponse(body, type);
  };
  await io.beforeDispatch?.();
  const controller = new AbortController();
  // Bound connection setup and stalled body reads, not the total download time.
  let timeout = setTimeout(() => controller.abort(), RUNNER_API_TIMEOUT_MS);
  try {
    response = await (io.fetch ?? fetch)(url, { method: operation.method, headers, body, redirect: "manual", signal: controller.signal });
    clearTimeout(timeout);
    if (sensitiveResponse) {
      timeout = setTimeout(() => controller.abort(), RUNNER_API_TIMEOUT_MS);
      bytes = await readBoundedResponse(response);
      await io.beforeDispatch?.();
    } else if (assetTextRange && response.ok) {
      timeout = setTimeout(() => controller.abort(), RUNNER_API_TIMEOUT_MS);
      bytes = await readBoundedResponse(response, textLimit + 2);
    } else {
      captured = await captureRunnerApiResponse(response, inlineBytes, controller, RUNNER_API_TIMEOUT_MS, io.beforeDispatch, {
        beforeSpill: async () => { settleCapture = await io.reserveResponseCapture?.(); },
      });
      // Read only the requested window (+ one UTF-8 lookahead byte) into memory.
      bytes = await captured.read(input.responseText && response.ok ? textOffset : 0,
        input.responseText ? textLimit + 1 : inlineBytes);
    }
  } catch (error) {
    await disposeCapture(!(error instanceof RunnerApiResponseCleanupError));
    return { ok: false, status: null, operationId: operation.operationId,
      error: error instanceof RunnerApiResponseLimitError ? error.code : "api_transport_failure",
      ...(error instanceof RunnerApiResponseLimitError ? { message: error.message, maxResponseBytes: RUNNER_API_RESPONSE_MAX_BYTES } : {}),
      outcome: ["GET", "HEAD", "OPTIONS"].includes(operation.method) ? "read_failed" : "unknown", guidance: "Inspect current state before retrying a mutation; it may already have succeeded." };
  } finally { clearTimeout(timeout); }
  try {
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(operation.method);
    // A server can commit a write before an error response or redirect. Preserve
    // the HTTP evidence, but never describe that write as definitely not applied.
    const uncertain = mutation && (response.status >= 500 || response.status === 408 || (response.status >= 300 && response.status < 400));
    const uncertainty = { outcome: "unknown", guidance: "Inspect current state before retrying this mutation; it may already have succeeded." };
    const etag = input.responseText && response.ok ? response.headers.get("etag") : null;
    const pagination = response.ok ? runnerApiPagination(response.headers) : undefined;
    const base = { ok: response.ok, status: response.status, operationId: operation.operationId, contentType: type, retryAfter: response.headers.get("retry-after"), ...(etag ? { etag } : {}), ...(pagination ? { pagination } : {}), ...(uncertain ? uncertainty : {}) };
    if (response.status >= 300 && response.status < 400) return { ...base, ok: false, error: "api_redirect_not_followed" };
    let totalBytes = captured?.byteSize ?? bytes.length;
    let baseOffset = captured && response.ok ? textOffset : 0;
    if (assetTextRange && response.ok) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
      if (response.status === 200 && bytes.length === 0 && textOffset === 0) {
        // An empty asset has no satisfiable byte range; its route returns 200.
      } else if (response.status !== 206 || !range) {
        return { ...base, ok: false, error: "response_text_invalid_range" };
      } else {
        const [start, end, total] = range.slice(1).map(Number);
        if (![start, end, total].every(Number.isSafeInteger) || start !== assetTextRange.start
          || total < 1 || end !== Math.min(assetTextRange.end, total - 1)
          || end < start || bytes.length !== end - start + 1) {
          return { ...base, ok: false, error: "response_text_invalid_range" };
        }
        baseOffset = start;
        totalBytes = total;
      }
    }
    if (input.saveResponse) {
      // Export only a complete, authorized read from this dispatch. Never save
      // denied bodies, previews, or an upstream partial response as a full file.
      if (!response.ok) return { ...base, data: bytes.toString("utf8"), byteSize: totalBytes, truncated: bytes.length < totalBytes };
      if (response.status === 206 || response.headers.has("content-range")) {
        return { ...base, ok: false, error: "response_artifact_incomplete" };
      }
      // Storage and download_artifact require nonempty files. Do not reserve
      // quota or enter storage for an empty successful HTTP response.
      if (!totalBytes) return { ...base, empty: true, byteSize: 0, data: null };
      return { ...base, artifact: await saveResponse(captured?.body ?? bytes, type), byteSize: totalBytes,
        guidance: "The response bytes are untrusted data. Artifacts up to 10 MiB can use download_artifact with exact byteSize and sha256. Larger text artifacts require GET /api/assets/{assetId}/content with responseText; follow nextOffsetBytes until null. Narrow or paginate the source query for local helper input." };
    }
    if (input.responseText) {
      if (!/json|^text\//i.test(type)) return { ...base, ok: false, error: "response_text_requires_text_content" };
      // HTTP denials are evidence, not text pages of an authorized asset.
      const offsetBytes = response.ok ? textOffset : 0;
      const localOffset = offsetBytes - baseOffset;
      if (offsetBytes > totalBytes || localOffset < 0 || (localOffset < bytes.length && (bytes[localOffset] & 0xc0) === 0x80)) {
        return { ...base, ok: false, error: "response_text_invalid_offset", byteSize: totalBytes };
      }
      let end = Math.min(bytes.length, localOffset + textLimit);
      // Do not cut a UTF-8 code point. The next offset always starts a whole one.
      while (end < bytes.length && end > localOffset && (bytes[end] & 0xc0) === 0x80) end--;
      if (end === localOffset && end < bytes.length) return { ...base, ok: false, error: "response_text_invalid_utf8" };
      let data: string;
      try {
        data = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(localOffset, end));
      } catch {
        return { ...base, ok: false, error: "response_text_invalid_utf8" };
      }
      const nextOffset = baseOffset + end;
      const artifact = captured && captured.byteSize > inlineBytes
        ? await saveResponse(captured.body, type) : undefined;
      return { ...base, data, ...(artifact ? { artifact, guidance: "Continue reading this saved artifact with GET /api/assets/{assetId}/content and responseText.nextOffsetBytes for a stable snapshot." } : {}), responseText: { offsetBytes, nextOffsetBytes: nextOffset < totalBytes ? nextOffset : null, totalBytes } };
    }
    if (assetTextRange && response.ok && (totalBytes > inlineBytes || !/json|^text\//i.test(type))) {
      // This content is already an authorized, stable asset. Return its existing
      // reference after a bounded preview; never download and duplicate it.
      const assetId = input.pathParams!.assetId;
      const sha256 = /^"([a-f0-9]{64})"$/.exec(response.headers.get("etag") ?? "")?.[1];
      return { ...base, artifact: { artifactId: assetId, url: `/api/assets/${assetId}/content`, contentType: type, byteSize: totalBytes, ...(sha256 ? { sha256 } : {}) },
        byteSize: totalBytes, preview: /json|^text\//i.test(type) ? bytes.subarray(0, 2000).toString("utf8") : null,
        guidance: "Read this asset with responseText: { offsetBytes: 0 }. Continue with responseText.nextOffsetBytes until null." };
    }
    if (!totalBytes) return { ...base, data: null };
    if (!sensitiveResponse && (totalBytes > inlineBytes || !/json|^text\//i.test(type))) {
      return { ...base, artifact: await saveResponse(captured?.body ?? bytes, type), byteSize: totalBytes, preview: /json|^text\//i.test(type) ? bytes.subarray(0, 2000).toString("utf8") : null,
        ...(/json|^text\//i.test(type) ? { guidance: "Read the saved artifact with GET /api/assets/{assetId}/content and responseText: { offsetBytes: 0 }. Continue with responseText.nextOffsetBytes until null. Do not repeat a mutation to read its response." } : {}) };
    }
    if (sensitiveResponse && !/json|^text\//i.test(type)) return { ...base, ok: false, error: "credential_response_requires_text_content" };
    const text = bytes.toString("utf8");
    if (/json/i.test(type)) {
      try { return { ...base, data: JSON.parse(text) as unknown }; }
      catch { return { ...base, ok: false, error: "invalid_json_response", data: text, ...(mutation ? uncertainty : {}) }; }
    }
    return { ...base, data: text };
  } catch (error) {
    if (!(error instanceof RunnerApiResponseLimitError)) throw error;
    return { ok: false, status: response.status, operationId: operation.operationId, error: error.code, message: error.message,
      outcome: ["GET", "HEAD", "OPTIONS"].includes(operation.method) ? "read_failed" : "unknown",
      guidance: "Inspect current state before retrying a mutation; it may already have succeeded." };
  } finally { await disposeCapture(); }
}
