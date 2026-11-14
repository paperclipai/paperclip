import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { HttpError } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";
import { descriptorHash, stableHash } from "./tool-catalog-hash.js";

/** Shared transport for native provider catalogs (Daytona, Unikraft). Each
 * provider owns its endpoints and target checks; this owns the bounded,
 * credential-redacting request/response handling they must all apply. */
export const NATIVE_REST_MAX_BYTES = 8 * 1024 * 1024;
export type NativeRestRequest = (url: string, init: RequestInit) => Promise<Response>;

export const nativeRestFailure = (status: number, code: string, message: string) => new HttpError(status, message, { code });

export function nativeRestRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function nativeRestPathValue(value: unknown, invalid: () => Error) {
  const text = String(value);
  if (!text || text.length > 8192 || /[\u0000-\u001f\\]/.test(text)
    || text.split("/").some(segment => segment === "." || segment === "..")) {
    throw invalid();
  }
  return encodeURIComponent(text);
}

export function nativeRestSender(options: {
  /** Provider display name used in caller-facing messages. */
  provider: string;
  /** Error code prefix, such as `daytona`. */
  code: string;
  authorization: string;
  request: NativeRestRequest;
  signal: AbortSignal;
  deadlineAt: number;
  deniedMessage: string;
  /** Provider-owned headers set after caller headers so they cannot be replaced. */
  fixedHeaders?: Record<string, string>;
}) {
  const { provider, code, authorization, request, signal, deadlineAt } = options;
  const secret = authorization.replace(/^Bearer /, "");
  const expired = () => nativeRestFailure(504, `${code}_deadline_exceeded`, `The ${provider} action deadline expired. An operation already sent may still be running; inspect it before retrying.`);
  // Bound the caller even if a transport or body reader is slow to acknowledge
  // cancellation. A late prerequisite result never advances to the next call.
  async function withinDeadline<T>(work: () => Promise<T>): Promise<T> {
    if (signal.aborted || Date.now() >= deadlineAt) throw expired();
    let abort!: () => void;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (signal.aborted || Date.now() >= deadlineAt) throw expired(); return work(); }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(expired());
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally { signal.removeEventListener("abort", abort); }
  }
  function sanitize(value: unknown): unknown {
    if (typeof value === "string") return redactSensitiveText(value.split(secret).join("[REDACTED]"));
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    return value;
  }

  /** `expectedStatuses` maps a provider-documented non-2xx outcome (for
   * example, a wait that timed out) to the result returned in its place. */
  async function send(url: string, init: RequestInit, extraHeaders: Record<string, string> = {},
    expectedStatuses: Record<number, unknown> = {}): Promise<unknown> {
    const projected = new Headers(init.headers);
    projected.set("Authorization", authorization);
    for (const [name, value] of Object.entries({ ...options.fixedHeaders, ...extraHeaders })) projected.set(name, value);
    let response: Response;
    try {
      response = await withinDeadline(() => request(url, { ...init, redirect: "error", headers: Object.fromEntries(projected), signal }));
    } catch {
      if (signal.aborted || Date.now() >= deadlineAt) throw expired();
      throw nativeRestFailure(502, `${code}_outcome_unknown`, init.method === "GET"
        ? `${provider} could not complete the request.`
        : `${provider} did not return a result. The operation may have started; inspect its state before retrying.`);
    }
    if (Object.hasOwn(expectedStatuses, response.status)) {
      void response.body?.cancel().catch(() => {});
      return expectedStatuses[response.status];
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = [400, 401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
      throw nativeRestFailure(status, `${code}_request_failed`, status === 401 || status === 403
        ? options.deniedMessage
        : status === 404 ? `${provider} could not find this resource.` : `${provider} could not complete this operation.`);
    }
    if (response.status === 204 || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await withinDeadline(() => reader.read());
        if (part.done) break;
        length += part.value.byteLength;
        if (length > NATIVE_REST_MAX_BYTES) throw nativeRestFailure(502, `${code}_output_limit`, `${provider}'s response exceeded the limit. Request a smaller page or file range.`);
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw nativeRestFailure(502, `${code}_outcome_unknown`, `${provider}'s response was interrupted. Inspect the operation before retrying.`);
    } finally { void reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) return null;
    const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
    if (contentType.includes("json")) {
      try { return sanitize(JSON.parse(bytes.toString("utf8"))); }
      catch { throw nativeRestFailure(502, `${code}_invalid_response`, `${provider} returned an invalid response.`); }
    }
    if (contentType.startsWith("text/")) return sanitize(bytes.toString("utf8"));
    if (bytes.includes(Buffer.from(secret))) throw nativeRestFailure(403, `${code}_credential_export_denied`, "The response contains connection credential material.");
    return { contentType, contentBase64: bytes.toString("base64"), byteLength: bytes.length };
  }

  return { send, withinDeadline };
}

type NativeOperation = {
  name: string; title: string; description: string; inputSchema: unknown;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};
export type NativeCatalogEntry = { toolName: string; versionHash: string; schemaHash: string | null; riskLevel: string };

// Match the interop used by the existing plugin configuration validator.
const AjvCtor = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({ strict: false, allErrors: true, validateFormats: true });
((addFormats as any).default ?? addFormats)(ajv);

/** The deployed contract of a generated provider catalog: agent-visible tools,
 * reviewed risk, saved-entry staleness and argument validation. */
export function nativeCatalog<T extends NativeOperation>(operationsList: T[]) {
  const operations = new Map(operationsList.map(operation => [operation.name, operation]));
  const validators = new Map<string, ValidateFunction>();
  const risk = (name: string): "read" | "write" | "destructive" => {
    const operation = operations.get(name);
    if (!operation || operation.annotations.destructiveHint) return "destructive";
    return operation.annotations.readOnlyHint ? "read" : "write";
  };
  const tools = operationsList.map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema: inputSchema as Record<string, unknown>, annotations,
  }));
  const contracts = new Map(tools.map(tool => [tool.name, {
    versionHash: descriptorHash(tool, risk(tool.name)), schemaHash: stableHash(tool.inputSchema), riskLevel: risk(tool.name),
  }]));
  return {
    tools,
    operation: (name: string) => operations.get(name),
    isToolName: (name: string) => operations.has(name),
    risk,
    isCurrentEntry(entry: NativeCatalogEntry): boolean {
      const current = contracts.get(entry.toolName);
      return Boolean(current && current.versionHash === entry.versionHash && current.schemaHash === entry.schemaHash && current.riskLevel === entry.riskLevel);
    },
    validate(name: string, parameters: unknown): boolean {
      const operation = operations.get(name);
      if (!operation) return false;
      let validate = validators.get(name);
      if (!validate) { validate = ajv.compile(operation.inputSchema as object) as ValidateFunction; validators.set(name, validate); }
      return validate(parameters) as boolean;
    },
  };
}
