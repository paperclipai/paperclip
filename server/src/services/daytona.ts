import { z } from "zod";
import { NATIVE_REST_MAX_BYTES as MAX_BYTES, nativeCatalog, nativeRestFailure as failure, nativeRestPathValue, nativeRestRecord as record,
  nativeRestSender, type NativeCatalogEntry, type NativeRestRequest } from "./native-rest-client.js";
import catalog from "./daytona/operations.generated.json" with { type: "json" };

export const DAYTONA_API_URL = "https://app.daytona.io/api";
// Preserve the saved method identity when upgrading the earlier small catalog.
export const DAYTONA_METHOD = "workspace-diagnostics";
export type DaytonaRequest = NativeRestRequest;
type Operation = typeof catalog.tools[number];
const contract = nativeCatalog(catalog.tools);

export const DAYTONA_TOOLS = contract.tools;
export const isDaytonaToolName = contract.isToolName;
export const daytonaRisk = contract.risk;
export const isCurrentDaytonaCatalogEntry = (entry: NativeCatalogEntry) => contract.isCurrentEntry(entry);

export function isDaytonaConnection(connection: { transport: string; config?: Record<string, unknown> }) {
  return connection.transport === "rest_api" && connection.config?.sourceTemplateKey === "daytona"
    && connection.config.connectionMethodKey === DAYTONA_METHOD && connection.config.url === DAYTONA_API_URL;
}

function pathValue(value: unknown) {
  return nativeRestPathValue(value, () => failure(422, "daytona_arguments_invalid", "Invalid Daytona path argument."));
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
  const { send: sendRequest, withinDeadline } = nativeRestSender({ provider: "Daytona", code: "daytona", authorization, request, signal, deadlineAt,
    deniedMessage: "Daytona denied access. Check this key's organization and permissions. Some account operations require provider user authentication.",
    fixedHeaders: { "X-Daytona-Source": "paperclip-connector" } });
  const send = (url: string, init: RequestInit, organizationId?: string) =>
    sendRequest(url, init, organizationId ? { "X-Daytona-Organization-ID": organizationId } : {});

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
  const operation = contract.operation(input.toolName);
  if (!operation) throw failure(404, "daytona_tool_not_found", "Daytona action not found.");
  if (!contract.validate(operation.name, input.parameters)) throw failure(422, "daytona_arguments_invalid", "Invalid Daytona action arguments.");
  const config = record(input.connection.config.methodConfig);
  return daytonaClient(input.headers, input.request, config.organizationId, input.signal, input.deadlineAt).execute(operation, record(input.parameters));
}
