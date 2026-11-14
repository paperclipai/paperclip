import { createHash } from "node:crypto";

import { toolApplications, toolConnections } from "@paperclipai/db";
import type { ConnectionTokenIssuancePath, ConnectionTokenRequest } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../../../errors.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

export function readConfigString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readConfigStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string")
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}

export function normalizeConnectionTokenScopes(
  scope: ConnectionTokenRequest["scope"],
): string[] {
  if (Array.isArray(scope))
    return [...new Set(scope.map((item) => item.trim()).filter(Boolean))];
  if (typeof scope === "string")
    return [
      ...new Set(
        scope
          .split(/\s+/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  return [];
}

export function tokenBrokerConfigFromConnectionConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const broker = asRecord(config.tokenBroker);
  if (Object.keys(broker).length > 0) return broker;
  return asRecord(config.broker);
}

export function tokenBrokerConfig(
  connection: typeof toolConnections.$inferSelect,
): Record<string, unknown> {
  return tokenBrokerConfigFromConnectionConfig(asRecord(connection.config));
}

export function configuredTokenBrokerExchangeUrls(
  config: Record<string, unknown>,
): string[] {
  const broker = tokenBrokerConfigFromConnectionConfig(config);
  return [
    ...new Set(
      [
        readConfigString(broker, "tokenUrl"),
        readConfigString(broker, "exchangeTokenUrl"),
        readConfigString(config, "tokenExchangeUrl"),
        readConfigString(config, "pagesTokenExchangeUrl"),
      ].filter((url): url is string => url !== null),
    ),
  ];
}

export function connectionTokenBrokerEnabled(
  connection: typeof toolConnections.$inferSelect,
): boolean {
  const config = asRecord(connection.config);
  const tokenBroker = asRecord(config.tokenBroker);
  if (Object.keys(tokenBroker).length > 0)
    return tokenBroker.enabled === true;
  const broker = asRecord(config.broker);
  if (Object.keys(broker).length > 0) return broker.enabled === true;
  return false;
}

export function isPagesTokenConnection(
  connection: typeof toolConnections.$inferSelect,
  application?: typeof toolApplications.$inferSelect | null,
) {
  const config = asRecord(connection.config);
  const broker = tokenBrokerConfig(connection);
  const applicationKey = application?.applicationKey ?? "";
  return Boolean(
    applicationKey === "paperclip-pages" ||
    applicationKey === "paperclip.pages" ||
    applicationKey === "pages.paperclip" ||
    readConfigString(config, "connectionType") === "pages" ||
    readConfigString(config, "service") === "pages" ||
    readConfigString(broker, "connectionType") === "pages" ||
    readConfigString(broker, "service") === "pages" ||
    asRecord(config.pages).enabled === true,
  );
}

export function inferConnectionTokenPath(
  connection: typeof toolConnections.$inferSelect,
  application?: typeof toolApplications.$inferSelect | null,
): ConnectionTokenIssuancePath {
  const broker = tokenBrokerConfig(connection);
  const configuredPath =
    readConfigString(broker, "path") ??
    readConfigString(asRecord(connection.config), "tokenPath");
  if (
    configuredPath === "exchange" ||
    configuredPath === "oauth_access" ||
    configuredPath === "static"
  )
    return configuredPath;
  if (isPagesTokenConnection(connection, application)) return "exchange";
  if (
    readConfigString(broker, "tokenUrl") ||
    readConfigString(asRecord(connection.config), "tokenExchangeUrl")
  )
    return "exchange";
  return "static";
}

export function parentScopesForConnection(
  connection: typeof toolConnections.$inferSelect,
): string[] {
  const config = asRecord(connection.config);
  const broker = tokenBrokerConfig(connection);
  const configured = [
    ...readConfigStringArray(broker.parentScopes),
    ...readConfigStringArray(broker.scopes),
    ...readConfigStringArray(config.parentScopes),
    ...readConfigStringArray(asRecord(config.oauth).scopes),
    ...readConfigStringArray(asRecord(config.oauth).scope),
  ];
  const namespaceAllowlist = readConfigStringArray(
    config.namespaceAllowlist,
  ).map((namespace) => `pages:publish:ns/${namespace}`);
  return [...new Set([...configured, ...namespaceAllowlist])];
}

export function defaultScopesForConnection(
  connection: typeof toolConnections.$inferSelect,
): string[] {
  const broker = tokenBrokerConfig(connection);
  return [
    ...new Set([
      ...readConfigStringArray(broker.defaultScopes),
      ...readConfigStringArray(asRecord(connection.config).defaultScopes),
    ]),
  ];
}

export function assertScopeSubset(input: {
  requestedScope: string[];
  parentScopes: string[];
}) {
  if (input.requestedScope.length === 0) return;
  const parent = new Set(input.parentScopes);
  if (
    parent.size === 0 ||
    input.requestedScope.some((scope) => !parent.has(scope))
  ) {
    throw forbidden(
      "Requested token scope exceeds the connection parent scope",
    );
  }
}

export function requestedTtlSeconds(
  body: ConnectionTokenRequest,
  connection: typeof toolConnections.$inferSelect,
): number {
  const broker = tokenBrokerConfig(connection);
  const configured = Number(
    broker.defaultTtlSeconds ?? broker.ttlSeconds ?? 900,
  );
  const requested = Number(body.requestedTtlSeconds ?? configured);
  const finite =
    Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 900;
  return Math.max(1, Math.min(900, finite));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function bearerTokenHash(token: string): string {
  return sha256Hex(token);
}

export function exchangeTokenUrl(
  connection: typeof toolConnections.$inferSelect,
  isPages: boolean,
): string {
  const broker = tokenBrokerConfig(connection);
  const config = asRecord(connection.config);
  const url =
    readConfigString(broker, "tokenUrl") ??
    readConfigString(broker, "exchangeTokenUrl") ??
    readConfigString(config, "tokenExchangeUrl") ??
    readConfigString(config, "pagesTokenExchangeUrl");
  if (url) return url;
  const pagesApiBase = process.env.PAPERCLIP_PAGES_API_URL?.trim();
  if (isPages && pagesApiBase)
    return new URL(
      "/v1/tokens/exchange",
      pagesApiBase.endsWith("/") ? pagesApiBase : `${pagesApiBase}/`,
    ).toString();
  throw unprocessable("Connection token exchange URL is not configured", {
    code: "exchange_url_missing",
  });
}

export function pagesNamespaceFromScope(scope: string[]): string | null {
  const first = scope[0];
  if (!first) return null;
  const match = first.match(/^pages:publish:ns\/([^/\s]+)$/);
  return match?.[1] ?? null;
}

export const CONNECTION_TOKEN_MINT_TOOL_NAME = "connection_token.mint";
