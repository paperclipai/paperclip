import { readFileSync } from "node:fs";
import {
  MCP_CONNECTOR_MAX_UPSTREAMS,
  isRelayableMcpConnectorRequestHeader,
  isValidMcpConnectorUpstreamName,
} from "@paperclipai/shared/mcp-connector-protocol";

export interface UpstreamConfig {
  /** Only http(s). The connector is the ONLY place this URL exists. */
  url: string;
  /** Headers added to every request for this upstream. They never leave the connector. */
  headers: Record<string, string>;
}

export interface ConnectorConfig {
  paperclipUrl: string;
  enrollmentToken: string | null;
  credentialsFile: string;
  upstreams: Map<string, UpstreamConfig>;
}

export class ConnectorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorConfigError";
  }
}

type Env = Record<string, string | undefined>;

const DEFAULT_CREDENTIALS_FILE = "./paperclip-mcp-connector.credentials.json";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Header values may reference the environment as `env:NAME`, so upstream
 * secrets do not have to be written into the config file.
 */
function resolveHeaderValue(name: string, value: unknown, env: Env): string {
  if (typeof value !== "string") throw new ConnectorConfigError(`Header ${name} must be a string`);
  const resolved = value.startsWith("env:") ? env[value.slice(4)] : value;
  if (resolved === undefined) throw new ConnectorConfigError(`Header ${name} references an unset environment variable`);
  if (/[\r\n\0]/.test(resolved)) throw new ConnectorConfigError(`Header ${name} contains control characters`);
  return resolved;
}

function parseUpstream(name: string, value: unknown, env: Env): UpstreamConfig {
  if (!isValidMcpConnectorUpstreamName(name)) {
    throw new ConnectorConfigError(`Upstream name "${name}" is invalid: use lowercase letters, digits, '-' or '_'`);
  }
  const record = typeof value === "string" ? { url: value } : asRecord(value);
  let url: URL;
  try {
    url = new URL(String(record.url ?? ""));
  } catch {
    throw new ConnectorConfigError(`Upstream "${name}" needs a valid url`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorConfigError(`Upstream "${name}" must use http or https`);
  }
  if (url.username || url.password) {
    throw new ConnectorConfigError(`Upstream "${name}" must not embed credentials in the url; use headers`);
  }
  const headers: Record<string, string> = {};
  for (const [header, raw] of Object.entries(asRecord(record.headers))) {
    if (!isRelayableMcpConnectorRequestHeader(header)) {
      throw new ConnectorConfigError(`Upstream "${name}" header ${header} is not allowed`);
    }
    headers[header.toLowerCase()] = resolveHeaderValue(header, raw, env);
  }
  return { url: url.toString(), headers };
}

/** `name=url,name=url` or a JSON object of `{ name: url | { url, headers } }`. */
function parseUpstreamsEnv(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      throw new ConnectorConfigError("PAPERCLIP_MCP_CONNECTOR_UPSTREAMS is not valid JSON");
    }
  }
  const upstreams: Record<string, unknown> = {};
  for (const entry of trimmed.split(",").map((part) => part.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new ConnectorConfigError(`Invalid upstream entry "${entry}", expected name=url`);
    upstreams[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
  }
  return upstreams;
}

/**
 * Load config from an optional JSON file plus environment variables.
 * Environment variables override file values.
 */
export function loadConnectorConfig(input: { configPath?: string | null; env?: Env } = {}): ConnectorConfig {
  const env = input.env ?? process.env;
  const configPath = input.configPath ?? env.PAPERCLIP_MCP_CONNECTOR_CONFIG ?? null;
  let file: Record<string, unknown> = {};
  if (configPath) {
    try {
      file = asRecord(JSON.parse(readFileSync(configPath, "utf8")));
    } catch (error) {
      throw new ConnectorConfigError(
        `Could not read config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const paperclipUrlRaw = env.PAPERCLIP_URL ?? env.PAPERCLIP_PUBLIC_URL ?? file.paperclipUrl;
  let paperclipUrl: URL;
  try {
    paperclipUrl = new URL(String(paperclipUrlRaw ?? ""));
  } catch {
    throw new ConnectorConfigError("Set PAPERCLIP_URL (or paperclipUrl in the config file) to the Paperclip public URL");
  }
  const loopbackHttp = paperclipUrl.protocol === "http:"
    && (["127.0.0.1", "[::1]", "localhost"].includes(paperclipUrl.hostname));
  if (paperclipUrl.protocol !== "https:" && !loopbackHttp) {
    throw new ConnectorConfigError("PAPERCLIP_URL must use HTTPS (HTTP is allowed only for localhost, 127.0.0.1 or [::1] loopback)");
  }
  // Pin the local-development hostname to a literal loopback address so a
  // hosts-file or DNS change cannot route a credential-bearing HTTP request elsewhere.
  if (paperclipUrl.protocol === "http:" && paperclipUrl.hostname === "localhost") {
    paperclipUrl.hostname = "127.0.0.1";
  }
  const upstreamSource = env.PAPERCLIP_MCP_CONNECTOR_UPSTREAMS
    ? parseUpstreamsEnv(env.PAPERCLIP_MCP_CONNECTOR_UPSTREAMS)
    : asRecord(file.upstreams);
  const upstreams = new Map<string, UpstreamConfig>();
  for (const [name, value] of Object.entries(upstreamSource)) {
    upstreams.set(name, parseUpstream(name, value, env));
  }
  if (upstreams.size === 0) throw new ConnectorConfigError("Configure at least one upstream MCP server");
  if (upstreams.size > MCP_CONNECTOR_MAX_UPSTREAMS) {
    throw new ConnectorConfigError(`At most ${MCP_CONNECTOR_MAX_UPSTREAMS} upstreams are supported`);
  }
  const enrollmentToken = env.PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN
    ?? (typeof file.enrollmentToken === "string" ? file.enrollmentToken : null);
  const credentialsFile = env.PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE
    ?? (typeof file.credentialsFile === "string" ? file.credentialsFile : DEFAULT_CREDENTIALS_FILE);
  paperclipUrl.hash = "";
  paperclipUrl.search = "";
  return {
    paperclipUrl: paperclipUrl.toString().replace(/\/+$/, ""),
    enrollmentToken: enrollmentToken?.trim() || null,
    credentialsFile,
    upstreams,
  };
}
