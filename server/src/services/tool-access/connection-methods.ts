import { isGitHubAppConnection } from "../github-app-client.js";
import { parseRemoteHttpEndpoint } from "../remote-http-endpoint-guard.js";
import type { AppDefinition, ConnectionMethodDef, ToolConnectionTransport } from "@paperclipai/shared";
import {
  credentialConfigPath,
  getAvailableConnectionMethod,
  getAvailableConnectionMethods,
  getConnectableAppDefinition,
  resolveConnectionMethodServerUrl,
  checkMcpRemoteHeaderName,
  checkMcpRemoteHeaderValue,
  mcpRemoteHeaderRejectionMessage,
} from "@paperclipai/shared";
import { badRequest, unprocessable } from "../../errors.js";
import { isPaperclipCloudConnectorStrategy } from "../paperclip-cloud-connector.js";
import { honchoManagedArguments } from "../honcho-connection.js";
import { assertGoogleChatToolArgumentsSupported, googleChatToolInputSchema } from "../google-chat-tool-policy.js";
import { gmailArchiveToolInputSchema } from "../gmail-archive-tool-policy.js";

type ConnectionSettings = {
  config: Record<string, unknown>;
  transport: ToolConnectionTransport;
  transportConfig?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function connectionMethodFor(app: AppDefinition, methodKey?: string | null) {
  const normalizedMethodKey =
    app.slug === "gmail" && methodKey === "paperclip-id-oauth"
      ? "paperclip-draft"
      : methodKey;
  // Stored managed connections must remain recognizable for callback, refresh,
  // and revoke even though static definitions omit instance availability. New
  // setup passes a definition filtered by signed profiles before reaching here;
  // the broker independently enforces availability on authorization and refresh.
  const availableMethods = new Set(getAvailableConnectionMethods(app));
  const toolMethods = app.methods.filter(
    (candidate) =>
      candidate.purpose !== "channel" && candidate.purpose !== "ai"
      && candidate.transport !== "chat_sdk" && candidate.transport !== "runtime_auth"
      && (availableMethods.has(candidate) || isPaperclipCloudConnectorStrategy(candidate.oauthStrategy)),
  );
  const method = normalizedMethodKey
    ? (toolMethods.find((candidate) => candidate.key === normalizedMethodKey) ??
      null)
    : getAvailableConnectionMethod({ ...app, methods: toolMethods }, null);
  if (!method)
    throw unprocessable(
      "This app does not have an available connection method",
    );
  return method;
}

export function connectionMethodForConnection(
  app: AppDefinition,
  connection: ConnectionSettings,
) {
  const methodKey =
    typeof connection.config.connectionMethodKey === "string"
      ? connection.config.connectionMethodKey
      : null;
  return connectionMethodFor(app, methodKey);
}

export function credentialFieldsFor(app: AppDefinition, methodKey?: string | null) {
  const method = connectionMethodFor(app, methodKey);
  return (method.credentialFields ?? []).map((field) => ({
    label: field.label,
    configPath: credentialConfigPath(field, method),
    helpUrl: method.consoleLinks?.keys ?? method.consoleLinks?.docs ?? "",
    required: field.required,
    placement:
      method.keyPlacement?.location === "header"
        ? ("header" as const)
        : undefined,
    key: method.keyPlacement?.name,
    prefix: method.keyPlacement?.prefix,
  }));
}


export function normalizeConnectionMethodConfig(
  method: ConnectionMethodDef,
  configValues: Record<string, unknown> | undefined,
): {
  values: Record<string, string | boolean>;
  url?: string;
  headers?: Record<string, string>;
} {
  const fields = [
    ...(method.tenantFields ?? []),
    ...(method.extensionFields ?? []),
  ];
  const allowedKeys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(configValues ?? {})) {
    if (!allowedKeys.has(key))
      throw badRequest(`Unknown connection setting: ${key}`);
  }

  const values: Record<string, string | boolean> = {};
  for (const field of fields) {
    let raw = configValues?.[field.key] ?? field.defaultValue;
    if (method.credentialExchange === "github_app_installation" && field.key === "version" && raw === 1) raw = "1";
    if (field.type === "checkbox") {
      if (raw !== undefined && typeof raw !== "boolean")
        throw badRequest(`${field.label} must be true or false`);
      if (raw !== undefined) values[field.key] = raw;
      continue;
    }
    if (raw !== undefined && typeof raw !== "string")
      throw badRequest(`${field.label} must be text`);
    let value = raw?.trim() ?? "";
    if (field.transport?.format === "csv") {
      value = Array.from(
        new Set(
          value
            .split(/[\n,]/g)
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ).join(",");
    }
    if (field.required && !value)
      throw badRequest(`Missing connection setting: ${field.label}`);
    if (!value) continue;
    if (
      field.validation?.maxLength &&
      value.length > field.validation.maxLength
    ) {
      throw badRequest(
        `${field.label} must be at most ${field.validation.maxLength} characters`,
      );
    }
    if (
      field.validation?.pattern &&
      !new RegExp(field.validation.pattern).test(value)
    ) {
      throw badRequest(`${field.label} has an invalid value`);
    }
    if (
      field.type === "select" &&
      !field.options?.some((option) => option.value === value)
    ) {
      throw badRequest(`${field.label} has an invalid option`);
    }
    values[field.key] = value;
  }
  for (const keys of method.configRequirements?.atLeastOneOf
    ? [method.configRequirements.atLeastOneOf]
    : []) {
    if (
      !keys.some(
        (key) => typeof values[key] === "string" && values[key].length > 0,
      )
    ) {
      throw badRequest(`Provide at least one of: ${keys.join(", ")}`);
    }
  }

  const resolvedServerUrl = resolveConnectionMethodServerUrl(method, values);
  if (method.defaults?.serverUrlTemplate && !resolvedServerUrl) {
    throw badRequest(
      "Missing or invalid connection settings for the server URL",
    );
  }
  const endpoint = resolvedServerUrl ? new URL(resolvedServerUrl) : null;
  if (endpoint && endpoint.protocol !== "https:") {
    throw badRequest("Connection server URL must use HTTPS");
  }
  const headers: Record<string, string> = {};
  for (const field of fields) {
    const transport = field.transport;
    const value = values[field.key];
    if (
      !transport ||
      value === undefined ||
      (value === false && transport.omitFalse)
    )
      continue;
    const serialized = typeof value === "boolean" ? String(value) : value;
    if (transport.location === "query")
      endpoint?.searchParams.set(transport.name, serialized);
    else {
      const nameCheck = checkMcpRemoteHeaderName(transport.name);
      const valueCheck = checkMcpRemoteHeaderValue(serialized);
      if (!nameCheck.ok || !valueCheck.ok) {
        throw badRequest(
          mcpRemoteHeaderRejectionMessage(
            transport.name,
            nameCheck.reason ?? valueCheck.reason!,
          ),
        );
      }
      headers[transport.name] = serialized;
    }
  }
  return {
    values,
    ...(endpoint ? { url: endpoint.toString() } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function projectedConnectionHeaders(
  connection: ConnectionSettings,
): Record<string, string> {
  const sourceTemplateKey =
    typeof connection.config.sourceTemplateKey === "string"
      ? connection.config.sourceTemplateKey
      : null;
  const app = sourceTemplateKey
    ? getConnectableAppDefinition(sourceTemplateKey)
    : null;
  const headers: Record<string, string> = {};
  if (app) {
    const method = connectionMethodForConnection(app, connection);
    // Non-transport settings do not participate in header projection. In
    // particular, legacy connections can lack a newly introduced setting.
    if ([...(method.tenantFields ?? []), ...(method.extensionFields ?? [])].some((field) => field.transport?.location === "header")) {
      Object.assign(headers, normalizeConnectionMethodConfig(
        method,
        asRecord(connection.config.methodConfig),
      ).headers);
    }
  }
  if (
    (connection.transport === "mcp_remote" || isGitHubAppConnection(connection)) &&
    (sourceTemplateKey === "github" || connection.transportConfig?.sourceTemplateKey === "github")
  ) {
    // GitHub excludes Actions from its default catalog. Project this on every
    // discovery and invocation so existing connections gain the toolset too.
    headers["X-MCP-Toolsets"] = "default,actions";
    if (isGitHubAppConnection(connection)) headers["X-MCP-Exclude-Tools"] = "get_me";
  }
  return headers;
}

function mergeManagedToolArguments(
  supplied: Record<string, unknown>,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...supplied };
  for (const [key, value] of Object.entries(managed)) {
    const suppliedValue = merged[key];
    merged[key] =
      asRecord(value) === value && asRecord(suppliedValue) === suppliedValue
        ? mergeManagedToolArguments(
            suppliedValue as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  }
  return merged;
}

export function projectConnectionMethodToolArguments(
  method: ConnectionMethodDef,
  parameters: unknown,
): Record<string, unknown> {
  const supplied = asRecord(parameters);
  const managed = method.defaults?.toolArgumentDefaults;
  return managed ? mergeManagedToolArguments(supplied, managed) : supplied;
}

function stripManagedToolArgumentSchema(
  schema: Record<string, unknown>,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  const properties = asRecord(schema.properties);
  if (Object.keys(properties).length === 0) return schema;
  const nextProperties = { ...properties };
  for (const [key, managedValue] of Object.entries(managed)) {
    const propertySchema = asRecord(nextProperties[key]);
    const managedRecord = asRecord(managedValue);
    if (
      Object.keys(propertySchema).length === 0 ||
      Object.keys(managedRecord).length === 0
    ) {
      delete nextProperties[key];
      continue;
    }
    const projectedProperty = stripManagedToolArgumentSchema(
      propertySchema,
      managedRecord,
    );
    if (Object.keys(asRecord(projectedProperty.properties)).length === 0)
      delete nextProperties[key];
    else nextProperties[key] = projectedProperty;
  }
  const nextSchema: Record<string, unknown> = {
    ...schema,
    properties: nextProperties,
  };
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter(
      (key): key is string => typeof key === "string" && key in nextProperties,
    );
    if (required.length > 0) nextSchema.required = required;
    else delete nextSchema.required;
  }
  return nextSchema;
}

export function projectConnectionMethodToolInputSchema(
  method: ConnectionMethodDef,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const managed = method.defaults?.toolArgumentDefaults;
  return managed
    ? stripManagedToolArgumentSchema(inputSchema, managed)
    : inputSchema;
}

export function projectedConnectionToolArguments(
  connection: ConnectionSettings,
  parameters: unknown,
  toolName: string,
  inputSchema: Record<string, unknown> = {},
): Record<string, unknown> {
  const managed = honchoManagedArguments(connection, inputSchema);
  if (managed) parameters = mergeManagedToolArguments(asRecord(parameters), managed);
  assertGoogleChatToolArgumentsSupported(connection, toolName, parameters);
  const sourceTemplateKey =
    typeof connection.config.sourceTemplateKey === "string"
      ? connection.config.sourceTemplateKey
      : null;
  const app = sourceTemplateKey
    ? getConnectableAppDefinition(sourceTemplateKey)
    : null;
  if (!app) return asRecord(parameters);
  return projectConnectionMethodToolArguments(
    connectionMethodForConnection(app, connection),
    parameters,
  );
}

export function projectedConnectionToolInputSchema(
  connection: ConnectionSettings,
  inputSchema: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  const managed = honchoManagedArguments(connection, inputSchema);
  if (managed) inputSchema = stripManagedToolArgumentSchema(inputSchema, managed);
  inputSchema = googleChatToolInputSchema(connection, toolName, inputSchema);
  inputSchema = gmailArchiveToolInputSchema(connection, toolName, inputSchema);
  const sourceTemplateKey =
    typeof connection.config.sourceTemplateKey === "string"
      ? connection.config.sourceTemplateKey
      : null;
  const app = sourceTemplateKey
    ? getConnectableAppDefinition(sourceTemplateKey)
    : null;
  if (!app) return inputSchema;
  return projectConnectionMethodToolInputSchema(
    connectionMethodForConnection(app, connection),
    inputSchema,
  );
}

export function remoteEndpoint(config: Record<string, unknown>): string {
  const value = config.url ?? config.endpoint ?? config.remoteUrl;
  const parsed = parseRemoteHttpEndpoint(value, (message, code) =>
    badRequest(message, { code }),
  );
  return parsed.toString();
}
