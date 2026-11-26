import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";
import { descriptorHash, stableHash } from "./tool-catalog-hash.js";
import catalog from "./daytona/operations.generated.json" with { type: "json" };

export const DAYTONA_API_URL = "https://app.daytona.io/api";
// Preserve the saved method identity when upgrading the earlier small catalog.
export const DAYTONA_METHOD = "workspace-diagnostics";
const MAX_BYTES = 8 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const failure = (status: number, code: string, message: string) => new HttpError(status, message, { code });
export type DaytonaRequest = (url: string, init: RequestInit) => Promise<Response>;
type Operation = typeof catalog.tools[number];
const operations = new Map(catalog.tools.map(operation => [operation.name, operation]));
const validators = new Map<string, ValidateFunction>();
// Match the interop used by the existing plugin configuration validator.
const AjvCtor = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({ strict: false, allErrors: true, validateFormats: true });
((addFormats as any).default ?? addFormats)(ajv);

export const DAYTONA_TOOLS = catalog.tools.map(({ name, title, description, inputSchema, annotations }) => ({
  name, title, description, inputSchema: inputSchema as Record<string, unknown>, annotations,
}));

export function isDaytonaToolName(name: string): boolean {
  return operations.has(name);
}

const currentContracts = new Map(DAYTONA_TOOLS.map(tool => [tool.name, {
  versionHash: descriptorHash(tool, daytonaRisk(tool.name)), schemaHash: stableHash(tool.inputSchema), riskLevel: daytonaRisk(tool.name),
}]));

export function isCurrentDaytonaCatalogEntry(entry: { toolName: string; versionHash: string; schemaHash: string | null; riskLevel: string }): boolean {
  const current = currentContracts.get(entry.toolName);
  return Boolean(current && current.versionHash === entry.versionHash && current.schemaHash === entry.schemaHash && current.riskLevel === entry.riskLevel);
}

export function isDaytonaConnection(connection: { transport: string; config?: Record<string, unknown> }) {
  return connection.transport === "rest_api" && connection.config?.sourceTemplateKey === "daytona"
    && connection.config.connectionMethodKey === DAYTONA_METHOD && connection.config.url === DAYTONA_API_URL;
}

export function daytonaRisk(name: string): "read" | "write" | "destructive" {
  const operation = operations.get(name);
  if (!operation || operation.annotations.destructiveHint) return "destructive";
  return operation.annotations.readOnlyHint ? "read" : "write";
}

function pathValue(value: unknown) {
  const text = String(value);
  if (!text || text.length > 8192 || /[\u0000-\u001f\\]/.test(text)
    || text.split("/").some(segment => segment === "." || segment === "..")) {
    throw failure(422, "daytona_arguments_invalid", "Invalid Daytona path argument.");
  }
  return encodeURIComponent(text);
}

function decodeFile(value: unknown) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw failure(422, "daytona_file_invalid", "File contents must be bounded base64 bytes.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw failure(422, "daytona_file_invalid", "File contents must be canonical base64 bytes.");
  return bytes;
}

/** A provider-focused REST bridge. It never reads host files, calls host shell
 * commands, borrows provider-plugin credentials, or looks up Paperclip tasks. */
export function daytonaClient(headers: Record<string, string>, request: DaytonaRequest, pinnedOrganizationId?: unknown,
  signal: AbortSignal = AbortSignal.timeout(30_000), deadlineAt: number = Date.now() + 30_000) {
  const authorization = headers.Authorization;
  if (!authorization || !/^Bearer [^\r\n]+$/.test(authorization)) {
    throw failure(422, "daytona_credential_missing", "Reconnect Daytona to restore its API key.");
  }
  const secret = authorization.slice(7);
  const expired = () => failure(504, "daytona_deadline_exceeded", "The Daytona action deadline expired. An operation already sent may still be running; inspect it before retrying.");
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

  async function send(url: string, init: RequestInit, organizationId?: string): Promise<unknown> {
    const projected = new Headers(init.headers);
    projected.set("Authorization", authorization!);
    projected.set("X-Daytona-Source", "paperclip-connector");
    if (organizationId) projected.set("X-Daytona-Organization-ID", organizationId);
    let response: Response;
    try {
      response = await withinDeadline(() => request(url, { ...init, redirect: "error", headers: Object.fromEntries(projected), signal }));
    } catch {
      if (signal.aborted || Date.now() >= deadlineAt) throw expired();
      throw failure(502, "daytona_outcome_unknown", init.method === "GET"
        ? "Daytona could not complete the request."
        : "Daytona did not return a result. The operation may have started; inspect its state before retrying.");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = [400, 401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502;
      throw failure(status, "daytona_request_failed", status === 401 || status === 403
        ? "Daytona denied access. Check this key's organization and permissions. Some account operations require provider user authentication."
        : status === 404 ? "Daytona could not find this resource." : "Daytona could not complete this operation.");
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
        if (length > MAX_BYTES) throw failure(502, "daytona_output_limit", "Daytona's response exceeded the limit. Request a smaller page or file range.");
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw failure(502, "daytona_outcome_unknown", "Daytona's response was interrupted. Inspect the operation before retrying.");
    } finally { void reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) return null;
    const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
    if (contentType.includes("json")) {
      try { return sanitize(JSON.parse(bytes.toString("utf8"))); }
      catch { throw failure(502, "daytona_invalid_response", "Daytona returned an invalid response."); }
    }
    if (contentType.startsWith("text/")) return sanitize(bytes.toString("utf8"));
    if (bytes.includes(Buffer.from(secret))) throw failure(403, "daytona_credential_export_denied", "The response contains connection credential material.");
    return { contentType, contentBase64: bytes.toString("base64"), byteLength: bytes.length };
  }

  async function identity() {
    const value = record(await send(`${DAYTONA_API_URL}/api-keys/current`, { method: "GET" }));
    const organizationId = value.organizationId;
    if (!z.string().uuid().safeParse(organizationId).success || (pinnedOrganizationId && organizationId !== pinnedOrganizationId)) {
      throw failure(403, "daytona_organization_mismatch", "The Daytona key does not identify the configured organization.");
    }
    return { organizationId: organizationId as string };
  }

  async function execute(operation: Operation, parameters: Record<string, unknown>) {
    const account = await identity();
    let base = DAYTONA_API_URL;
    if (operation.kind === "toolbox") {
      const sandbox = record(await send(`${DAYTONA_API_URL}/sandbox/${pathValue(parameters.sandboxId)}`, { method: "GET" }, account.organizationId));
      if (!z.string().uuid().safeParse(sandbox.id).success || sandbox.organizationId !== account.organizationId
        || (sandbox.id !== parameters.sandboxId && sandbox.name !== parameters.sandboxId)) {
        throw failure(403, "daytona_workspace_mismatch", "Daytona returned a sandbox outside the selected account or target.");
      }
      let proxyValue = sandbox.toolboxProxyUrl;
      if (!proxyValue) proxyValue = record(await send(`${DAYTONA_API_URL}/sandbox/${pathValue(sandbox.id)}/toolbox-proxy-url`, { method: "GET" }, account.organizationId)).url;
      let proxy: URL;
      try { proxy = new URL(String(proxyValue)); }
      catch { throw failure(502, "daytona_proxy_invalid", "Daytona returned an invalid toolbox address."); }
      if (proxy.protocol !== "https:" || !/^proxy(?:-[a-z0-9-]+)?\.app\.daytona\.io$/.test(proxy.hostname)
        || proxy.username || proxy.password || (proxy.port && proxy.port !== "443")
        || !/^\/toolbox\/?$/.test(proxy.pathname) || proxy.search || proxy.hash) {
        throw failure(502, "daytona_proxy_invalid", "Daytona returned an unrecognized toolbox address. No credentials were forwarded.");
      }
      base = `${proxy.origin}/toolbox/${pathValue(sandbox.id)}`;
    }
    const route = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => pathValue(record(parameters.path)[key]));
    const url = new URL(base + route);
    const projectedHeaders: Record<string, string> = {};
    for (const parameter of operation.parameters) {
      if (parameter.group === "path") continue;
      const value = record(parameters[parameter.group])[parameter.name];
      if (value === undefined || value === null) continue;
      if (parameter.group === "headers") {
        const text = String(value);
        if (/[\r\n]/.test(text)) throw failure(422, "daytona_arguments_invalid", "Invalid Daytona header argument.");
        projectedHeaders[parameter.name] = text;
      } else if (parameter.json || (value && typeof value === "object" && !Array.isArray(value))) {
        if (parameter.style === "deepObject") {
          for (const [key, child] of Object.entries(record(value))) {
            if (Array.isArray(child)) child.forEach(item => url.searchParams.append(`${parameter.name}[${key}]`, String(item)));
            else url.searchParams.append(`${parameter.name}[${key}]`, String(child));
          }
        } else url.searchParams.append(parameter.name, JSON.stringify(value));
      } else if (Array.isArray(value)) {
        if (parameter.explode) value.forEach(item => url.searchParams.append(parameter.name, String(item)));
        else url.searchParams.append(parameter.name, value.join(parameter.style === "spaceDelimited" ? " " : parameter.style === "pipeDelimited" ? "|" : ","));
      } else url.searchParams.append(parameter.name, String(value));
    }
    let body: BodyInit | undefined;
    if (operation.bodyContentType === "multipart/form-data") {
      const form = new FormData();
      if (Array.isArray(parameters.files)) {
        let total = 0;
        for (const item of parameters.files) {
          const file = record(item), bytes = decodeFile(file.contentBase64);
          total += bytes.length;
          if (total > MAX_BYTES) throw failure(422, "daytona_input_limit", "The total upload exceeds the limit.");
          form.append("files", new Blob([bytes]), String(file.path));
        }
      } else {
        for (const [key, value] of Object.entries(record(parameters.body))) {
          if (key === "file") form.append(key, new Blob([decodeFile(value)]), "upload");
          else form.append(key, String(value));
        }
      }
      // The guarded, DNS-pinned transport accepts bytes, not FormData. Use the
      // platform encoder to serialize parts and its matching boundary header.
      const encoded = new Request(DAYTONA_API_URL, { method: "POST", body: form });
      body = Buffer.from(await withinDeadline(() => encoded.arrayBuffer()));
      if (body.byteLength > MAX_BYTES) throw failure(422, "daytona_input_limit", "The multipart upload exceeds the limit.");
      projectedHeaders["Content-Type"] = encoded.headers.get("Content-Type")!;
    } else if (parameters.body !== undefined) {
      body = JSON.stringify(parameters.body);
      if (Buffer.byteLength(body) > MAX_BYTES) throw failure(422, "daytona_input_limit", "The request body exceeds the limit.");
      projectedHeaders["Content-Type"] = operation.bodyContentType === "*/*" ? "application/json" : operation.bodyContentType ?? "application/json";
    }
    // No automatic retry. A transport failure cannot prove a write did not run.
    return send(url.toString(), { method: operation.method, headers: projectedHeaders, body }, account.organizationId);
  }
  return { probe: identity, execute };
}

type Binding = { companyId: string; agentId: string | null; runId?: string | null; responsibleUserId?: string | null };
type Connection = { companyId: string; config: Record<string, unknown> };
export async function executeDaytonaTool(input: {
  binding: Binding; connection: Connection; headers: Record<string, string>;
  request: DaytonaRequest; toolName: string; parameters: unknown;
  signal?: AbortSignal;
  deadlineAt?: number;
}) {
  if (!input.binding.agentId || input.connection.companyId !== input.binding.companyId) {
    throw failure(404, "daytona_connection_not_found", "Connection not found.");
  }
  const operation = operations.get(input.toolName);
  if (!operation) throw failure(404, "daytona_tool_not_found", "Daytona action not found.");
  let validate = validators.get(operation.name);
  if (!validate) { validate = ajv.compile(operation.inputSchema); validators.set(operation.name, validate!); }
  if (!validate!(input.parameters)) throw failure(422, "daytona_arguments_invalid", "Invalid Daytona action arguments.");
  const config = record(input.connection.config.methodConfig);
  return daytonaClient(input.headers, input.request, config.organizationId, input.signal, input.deadlineAt).execute(operation, record(input.parameters));
}
