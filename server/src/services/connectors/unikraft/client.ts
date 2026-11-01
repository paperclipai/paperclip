import { NATIVE_REST_MAX_BYTES, nativeCatalog, nativeRestFailure as failure, nativeRestPathValue, nativeRestRecord as record,
  nativeRestSender, type NativeCatalogEntry, type NativeRestRequest } from "../../native-rest-client.js";
import catalog from "./operations.generated.json" with { type: "json" };

export const UNIKRAFT_METHOD = "api-token";
// Unikraft Cloud has no global platform endpoint; each metro serves its own API.
// The global control-plane URL identifies the connection; actions use the
// reviewed metro hosts below.
export const UNIKRAFT_CONNECTION_URL = "https://controlplane.unikraft.cloud/v1";
export const UNIKRAFT_METROS: readonly string[] = catalog.metros;
export const UNIKRAFT_DEFAULT_METRO = "fra";
type Operation = typeof catalog.tools[number];
const contract = nativeCatalog(catalog.tools);

export const UNIKRAFT_TOOLS = contract.tools;
export const isUnikraftToolName = contract.isToolName;
export const unikraftRisk = contract.risk;
export const isCurrentUnikraftCatalogEntry = (entry: NativeCatalogEntry) => contract.isCurrentEntry(entry);

export function isUnikraftConnection(connection: { transport: string; config?: Record<string, unknown> }) {
  return connection.transport === "rest_api" && connection.config?.sourceTemplateKey === "unikraft"
    && connection.config.connectionMethodKey === UNIKRAFT_METHOD && connection.config.url === UNIKRAFT_CONNECTION_URL;
}

/** Only metros published in the reviewed specification receive the token. */
export function unikraftApiUrl(metro: unknown) {
  if (typeof metro !== "string" || !UNIKRAFT_METROS.includes(metro)) {
    throw failure(422, "unikraft_metro_invalid", `Choose a Unikraft Cloud metro: ${UNIKRAFT_METROS.join(", ")}.`);
  }
  return `https://api.${metro}.unikraft.cloud`;
}

function pathValue(value: unknown) {
  return nativeRestPathValue(value, () => failure(422, "unikraft_arguments_invalid", "Invalid Unikraft path argument."));
}

/** A provider-focused REST bridge. It never reads host files, calls host shell
 * commands, borrows CLI login state, or looks up Paperclip tasks. */
export function unikraftClient(headers: Record<string, string>, request: NativeRestRequest, defaultMetro: unknown = UNIKRAFT_DEFAULT_METRO,
  signal: AbortSignal = AbortSignal.timeout(30_000), deadlineAt: number = Date.now() + 30_000) {
  const authorization = headers.Authorization;
  if (!authorization || !/^Bearer [^\r\n]+$/.test(authorization)) {
    throw failure(422, "unikraft_credential_missing", "Reconnect Unikraft to restore its API token.");
  }
  const { send } = nativeRestSender({ provider: "Unikraft", code: "unikraft", authorization, request, signal, deadlineAt,
    deniedMessage: "Unikraft denied access. Check that this token belongs to the intended organization and has not been revoked." });

  async function probe() {
    const value = record(await send(`${unikraftApiUrl(defaultMetro)}/v1/users/quotas`, { method: "GET" }));
    if (value.status !== "success") throw failure(502, "unikraft_invalid_response", "Unikraft did not confirm this API token.");
    return { metro: defaultMetro as string };
  }

  async function execute(operation: Operation, parameters: Record<string, unknown>) {
    let base = unikraftApiUrl(parameters.metro ?? defaultMetro);
    if (operation.kind === "sandbox") base += `/v1/instances/${pathValue(parameters.instance)}/plugins/sandbox`;
    const route = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => pathValue(record(parameters.path)[key]));
    const url = new URL(base + route);
    const projectedHeaders: Record<string, string> = {};
    for (const parameter of operation.parameters) {
      if (parameter.group === "path") continue;
      const value = record(parameters[parameter.group])[parameter.name];
      if (value === undefined || value === null) continue;
      if (parameter.group === "headers") {
        const text = String(value);
        if (/[\r\n]/.test(text)) throw failure(422, "unikraft_arguments_invalid", "Invalid Unikraft header argument.");
        projectedHeaders[parameter.name] = text;
      } else if (Array.isArray(value)) {
        if (parameter.explode) value.forEach(item => url.searchParams.append(parameter.name, String(item)));
        else url.searchParams.append(parameter.name, value.join(","));
      } else url.searchParams.append(parameter.name, String(value));
    }
    let body: string | undefined;
    // Unikraft selects batch targets with JSON bodies, including on GET and
    // DELETE. The pinned transport sends them as ordinary request bodies.
    if (parameters.body !== undefined) {
      body = JSON.stringify(parameters.body);
      if (Buffer.byteLength(body) > NATIVE_REST_MAX_BYTES) throw failure(422, "unikraft_input_limit", "The request body exceeds the limit.");
      projectedHeaders["Content-Type"] = "application/json";
    }
    // The sandbox plugin documents 408 as "the command is still running when
    // the wait timed out", an ordinary outcome rather than a failure.
    const expected = operation.kind === "sandbox" && operation.path === "/commands/{uuid}/wait_timeout"
      ? { 408: { status: "running", timedOut: true, message: "The command is still running. Wait again or check its logs." } } : {};
    // No automatic retry. A transport failure cannot prove a write did not run.
    return send(url.toString(), { method: operation.method, headers: projectedHeaders, body }, {}, expected);
  }
  return { probe, execute };
}

type Binding = { companyId: string; agentId: string | null };
type Connection = { companyId: string; config: Record<string, unknown> };
export async function executeUnikraftTool(input: {
  binding: Binding; connection: Connection; headers: Record<string, string>;
  request: NativeRestRequest; toolName: string; parameters: unknown;
  signal?: AbortSignal;
  deadlineAt?: number;
}) {
  if (!input.binding.agentId || input.connection.companyId !== input.binding.companyId) {
    throw failure(404, "unikraft_connection_not_found", "Connection not found.");
  }
  const operation = contract.operation(input.toolName);
  if (!operation) throw failure(404, "unikraft_tool_not_found", "Unikraft action not found.");
  if (!contract.validate(operation.name, input.parameters)) throw failure(422, "unikraft_arguments_invalid", "Invalid Unikraft action arguments.");
  const config = record(input.connection.config.methodConfig);
  return unikraftClient(input.headers, input.request, config.metro ?? UNIKRAFT_DEFAULT_METRO, input.signal, input.deadlineAt)
    .execute(operation, record(input.parameters));
}
