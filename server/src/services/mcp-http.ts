import { MCP_APPS_CLIENT_CAPABILITY, MCP_SKILLS_CLIENT_CAPABILITY } from "@paperclipai/shared";
import { createHash } from "node:crypto";
import { markMcpHttpResponseFailure, retainMcpConnectionFailure, withMcpConnectionFailure } from "./mcp-connection-failure.js";
// Helpers for talking to remote MCP servers over the Streamable HTTP transport.
//
// The MCP Streamable HTTP spec requires the client to advertise that it accepts
// BOTH a single JSON response and an SSE stream on every POST:
//
//   Accept: application/json, text/event-stream
//
// Spec-compliant servers reject requests missing this header with 406 Not
// Acceptable, and when the header is present they are free to answer with an
// SSE stream (`event: message\ndata: {…}`) instead of a bare JSON body. So any
// code path that POSTs JSON-RPC to a remote `/mcp` endpoint must (a) send the
// Accept header and (b) be able to read an SSE-framed response.

/** The Accept header value required by the MCP Streamable HTTP transport. */
export const MCP_HTTP_ACCEPT = "application/json, text/event-stream";
/**
 * The newest legacy (initialize-handshake) protocol version Paperclip requests.
 * Servers that only speak an older legacy version answer `initialize` with it.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
/** Stateless MCP: no handshake or session; every request carries its own `_meta`. */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
/** Newest first. Modern versions are tried before the legacy handshake. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_CLIENT_INFO = { name: "paperclip", version: "1" } as const;

export const MCP_ERROR_HEADER_MISMATCH = -32020;
export const MCP_ERROR_MISSING_CLIENT_CAPABILITY = -32021;
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
const MODERN_ERROR_CODES = new Set([MCP_ERROR_HEADER_MISMATCH, MCP_ERROR_MISSING_CLIENT_CAPABILITY, MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION]);

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** True for stateless protocol versions (2026-07-28 and later). */
export function isModernMcpProtocolVersion(version: unknown): version is string {
  return typeof version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(version) && version >= MCP_MODERN_PROTOCOL_VERSION;
}

/**
 * Capabilities for the version in use. Modern servers learn them per request;
 * they may then return URL input requests, which Paperclip shows as a link.
 * Legacy sessions keep the handshake capabilities they have always received.
 */
export function mcpClientCapabilities(protocolVersion: string): Record<string, unknown> {
  // The skills extension is defined against stateless MCP only.
  return isModernMcpProtocolVersion(protocolVersion)
    ? { elicitation: { url: {} }, extensions: { ...MCP_APPS_CLIENT_CAPABILITY, ...MCP_SKILLS_CLIENT_CAPABILITY } }
    : { extensions: MCP_APPS_CLIENT_CAPABILITY };
}

/** Newest version both sides support, or null when there is none. */
export function selectMcpProtocolVersion(serverVersions: unknown): string | null {
  if (!Array.isArray(serverVersions)) return null;
  const offered = new Set(serverVersions.filter((value): value is string => typeof value === "string"));
  return MCP_SUPPORTED_PROTOCOL_VERSIONS.find((version) => offered.has(version)) ?? null;
}

export class McpHttpResponseError extends Error {
  constructor(readonly reason: "invalid_json" | "malformed_response" | "too_large", message: string) {
    super(message);
    this.name = "McpHttpResponseError";
  }
}

/**
 * Default headers for an MCP Streamable HTTP JSON-RPC POST. Caller-supplied
 * headers (e.g. resolved credentials) are preserved, while the required
 * Streamable HTTP Accept value is kept authoritative.
 */
export function mcpHttpRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    ...extra,
    accept: MCP_HTTP_ACCEPT,
  };
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === lower) return value;
  return null;
}

function setHeader(headers: Record<string, string>, name: string, value: string) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key];
  headers[name] = value;
}

/** The protocol version these request headers carry, if any. */
export function mcpProtocolVersionOf(headers: Record<string, string> | undefined): string | null {
  return headerValue(headers, "mcp-protocol-version");
}

/**
 * Header-safe form of a value mirrored from the body (spec: Value Encoding).
 * Unsafe values, and values that look like the sentinel, are Base64 encoded.
 */
export function encodeMcpHeaderValue(value: string): string {
  const safe = /^[\x20-\x7E\t]*$/.test(value) && !/^[ \t]|[ \t]$/.test(value)
    && !(value.startsWith("=?base64?") && value.endsWith("?="));
  return safe ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate a tool's `x-mcp-header` annotations. Annotations must sit on a
 * primitive property reached only through `properties` keys, use a header
 * token, and be unique. Clients on HTTP must drop tools that break this.
 */
export function mcpToolHeaderParameters(inputSchema: unknown):
  { ok: true; parameters: Array<{ header: string; path: string[] }> } | { ok: false; reason: string } {
  const parameters: Array<{ header: string; path: string[] }> = [];
  // Most tools have no annotations; their schemas are never rejected by this check.
  try {
    if (!JSON.stringify(inputSchema ?? null).includes("x-mcp-header")) return { ok: true, parameters };
  } catch {
    return { ok: true, parameters };
  }
  const seen = new Set<string>();
  let nodes = 0;
  const visit = (node: unknown, path: string[], reachable: boolean, depth: number): string | null => {
    if (++nodes > 5_000 || depth > 32) return "the input schema is too large to check";
    if (Array.isArray(node)) {
      for (const item of node) { const failure = visit(item, path, false, depth + 1); if (failure) return failure; }
      return null;
    }
    const schema = record(node);
    if (!schema) return null;
    if ("x-mcp-header" in schema) {
      const header = schema["x-mcp-header"];
      if (!reachable || path.length === 0) return "x-mcp-header is only allowed on a property reached through properties";
      if (typeof header !== "string" || !HEADER_TOKEN.test(header)) return "x-mcp-header must be an HTTP header name token";
      if (!["string", "integer", "boolean"].includes(String(schema.type))) return "x-mcp-header is only allowed on string, integer, or boolean properties";
      if (seen.has(header.toLowerCase())) return "x-mcp-header values must be unique";
      seen.add(header.toLowerCase());
      parameters.push({ header, path });
    }
    for (const [key, child] of Object.entries(schema)) {
      // Instance values, not subschemas: a large enum is not a large schema.
      if (key === "enum" || key === "const" || key === "examples" || key === "default") continue;
      if (key === "properties" && record(child)) {
        for (const [name, property] of Object.entries(record(child)!)) {
          const failure = visit(property, [...path, name], reachable, depth + 1);
          if (failure) return failure;
        }
      } else if (child && typeof child === "object") {
        const failure = visit(child, path, false, depth + 1);
        if (failure) return failure;
      }
    }
    return null;
  };
  const failure = visit(inputSchema, [], true, 0);
  return failure ? { ok: false, reason: failure } : { ok: true, parameters };
}

function mcpParamHeaders(inputSchema: unknown, args: unknown): Record<string, string> {
  const annotations = mcpToolHeaderParameters(inputSchema);
  if (!annotations.ok) return {};
  const headers: Record<string, string> = {};
  for (const { header, path } of annotations.parameters) {
    let value: unknown = args;
    for (const key of path) value = record(value)?.[key];
    const text = typeof value === "string" ? value
      : typeof value === "boolean" ? String(value)
        : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
    if (text !== null) headers[`Mcp-Param-${header}`] = encodeMcpHeaderValue(text);
  }
  return headers;
}

export type McpJsonRpcRequest = { id?: string | number; method: string; params?: Record<string, unknown> };

/**
 * Build one Streamable HTTP POST. Every request mirrors its method (and name
 * or URI) into headers. When the headers select a modern protocol version the
 * body also carries the version, capabilities, and client identity in `_meta`,
 * because modern servers keep no handshake state.
 */
export function mcpHttpRequestInit(
  headers: Record<string, string> | undefined,
  message: McpJsonRpcRequest,
  options: { toolInputSchema?: unknown } = {},
): { method: "POST"; headers: Record<string, string>; body: string } {
  const requestHeaders = mcpHttpRequestHeaders(headers);
  const protocolVersion = mcpProtocolVersionOf(headers);
  let params = message.params ?? {};
  if (isModernMcpProtocolVersion(protocolVersion)) {
    params = {
      ...params,
      _meta: {
        ...record(params._meta),
        [META_PROTOCOL_VERSION]: protocolVersion,
        [META_CLIENT_CAPABILITIES]: mcpClientCapabilities(protocolVersion),
        [META_CLIENT_INFO]: MCP_CLIENT_INFO,
      },
    };
  }
  for (const key of Object.keys(requestHeaders)) if (key.toLowerCase().startsWith("mcp-param-")) delete requestHeaders[key];
  setHeader(requestHeaders, "Mcp-Method", message.method);
  const name = message.method === "resources/read" ? params.uri
    : message.method === "tools/call" || message.method === "prompts/get" ? params.name : undefined;
  if (typeof name === "string") setHeader(requestHeaders, "Mcp-Name", encodeMcpHeaderValue(name));
  else for (const key of Object.keys(requestHeaders)) if (key.toLowerCase() === "mcp-name") delete requestHeaders[key];
  if (message.method === "tools/call" && options.toolInputSchema !== undefined) {
    Object.assign(requestHeaders, mcpParamHeaders(options.toolInputSchema, params.arguments));
  }
  return {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", ...(message.id !== undefined ? { id: message.id } : {}), method: message.method, params }),
  };
}

export type McpModernError = { code: number; message: string; supported: string[] | null };

/** A JSON-RPC error that only a modern (stateless) server sends. */
export function mcpModernErrorOf(payload: unknown): McpModernError | null {
  const error = record(record(payload)?.error);
  if (!error || typeof error.code !== "number" || !MODERN_ERROR_CODES.has(error.code)) return null;
  const data = record(error.data);
  const supported = Array.isArray(data?.supported) ? data.supported : Array.isArray(data?.supportedVersions) ? data.supportedVersions : null;
  return {
    code: error.code,
    message: typeof error.message === "string" ? error.message : "",
    supported: supported?.filter((value): value is string => typeof value === "string") ?? null,
  };
}

async function readSmallBody(response: Response, maxBytes = 64 * 1024): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, maxBytes);
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Never await this: the body may be one branch of a clone, and its
    // cancellation can wait on the other branch the caller has not read yet.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return text;
}

/**
 * Read a rejected response's modern error without consuming the caller's body.
 * Modern servers reject unsupported versions and header mismatches with 400.
 */
export async function readMcpModernError(response: Response): Promise<McpModernError | null> {
  if (response.ok || ![400, 404].includes(response.status)) return null;
  try {
    const text = await readSmallBody(response.clone());
    return mcpModernErrorOf(parseMcpHttpResponseBody(text, response.headers.get("content-type")));
  } catch {
    return null;
  }
}

/** `resultType` is required from modern servers; older servers omit it. */
export function mcpResultType(result: unknown): string {
  const value = record(result)?.resultType;
  return typeof value === "string" && value ? value : "complete";
}

export type McpInputRequired = {
  inputRequests: Record<string, { method: string; params: Record<string, unknown> }>;
  requestState: string | null;
};

/** An interim multi round-trip result asking the client for more input. */
export function mcpInputRequired(result: unknown): McpInputRequired | null {
  const value = record(result);
  if (!value || mcpResultType(value) !== "input_required") return null;
  const inputRequests: McpInputRequired["inputRequests"] = {};
  for (const [key, entry] of Object.entries(record(value.inputRequests) ?? {})) {
    const request = record(entry);
    if (typeof request?.method === "string") inputRequests[key] = { method: request.method, params: record(request.params) ?? {} };
  }
  return { inputRequests, requestState: typeof value.requestState === "string" ? value.requestState : null };
}

/** Freshness hint on a complete cacheable result (spec: Caching). */
export function mcpCacheHint(result: unknown, maxTtlMs = 10 * 60_000): { ttlMs: number; scope: "public" | "private" } | null {
  const value = record(result);
  if (!value || mcpResultType(value) !== "complete" || typeof value.ttlMs !== "number" || !Number.isFinite(value.ttlMs) || value.ttlMs <= 0) return null;
  return { ttlMs: Math.min(Math.floor(value.ttlMs), maxTtlMs), scope: value.cacheScope === "public" ? "public" : "private" };
}

/**
 * A bounded in-memory cache for cacheable MCP results. Results come from
 * providers, so both the entry count and the bytes held are capped: a result
 * larger than `maxEntryBytes` is never cached, and the oldest entries are
 * evicted to keep the total under `maxBytes`. One connection can only push out
 * others' entries (a cache miss), never grow the process.
 */
export class McpResultCache<T> {
  readonly #entries = new Map<string, { value: T; expiresAt: number; bytes: number }>();
  #bytes = 0;
  constructor(
    readonly maxEntries = 500,
    readonly now: () => number = Date.now,
    readonly maxBytes = 32 * 1024 * 1024,
    readonly maxEntryBytes = 2 * 1024 * 1024,
  ) {}
  get bytes() { return this.#bytes; }
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.delete(key); return undefined; }
    return entry.value;
  }
  set(key: string, value: T, ttlMs: number) {
    if (ttlMs <= 0) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"); } catch { return; }
    this.delete(key);
    if (bytes > this.maxEntryBytes) return;
    while (this.#entries.size > 0 && (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes)) {
      this.delete(this.#entries.keys().next().value!);
    }
    this.#entries.set(key, { value, expiresAt: this.now() + ttlMs, bytes });
    this.#bytes += bytes;
  }
  delete(key: string) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#entries.delete(key);
  }
  deletePrefix(prefix: string) {
    for (const key of [...this.#entries.keys()]) if (key.startsWith(prefix)) this.delete(key);
  }
  clear() { this.#entries.clear(); this.#bytes = 0; }
}

export class McpHttpInitializationError extends Error {
  constructor(
    message: string,
    readonly stage: "initialize" | "initialized_notification",
    readonly status: number | null,
    readonly response?: Response,
  ) {
    super(message);
    this.name = "McpHttpInitializationError";
  }
}

// The protocol era is a property of the server, not of one identity's session,
// so it is remembered per connection endpoint for much longer than a session.
const eras = new Map<string, { protocolVersion: string; expiresAt: number }>();
const ERA_TTL_MS = 24 * 60 * 60_000;

/** Remember a server's negotiated version, e.g. from the saved connection. */
export function rememberMcpProtocolVersion(eraKey: string, protocolVersion: string) {
  if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion as never)) return;
  for (const [key, value] of eras) if (value.expiresAt <= Date.now()) eras.delete(key);
  if (eras.size >= 2000) eras.delete(eras.keys().next().value!);
  eras.set(eraKey, { protocolVersion, expiresAt: Date.now() + ERA_TTL_MS });
}

export function knownMcpProtocolVersion(eraKey: string): string | null {
  const cached = eras.get(eraKey);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.protocolVersion;
}

export function forgetMcpProtocolVersion(eraKey: string) {
  eras.delete(eraKey);
  serverCapabilities.delete(eraKey);
}

// Which extensions a stateless server declared in `server/discover`, kept
// beside its era so a catalog refresh can tell whether the server serves skills
// without asking again. Only the extension names are kept, never the payload,
// so each entry is small and bounded however large the server's answer is.
const MAX_REMEMBERED_EXTENSIONS = 32;
const MAX_EXTENSION_ID_LENGTH = 128;
const serverCapabilities = new Map<string, { capabilities: Record<string, unknown>; expiresAt: number }>();

export function rememberMcpServerCapabilities(eraKey: string, capabilities: Record<string, unknown>) {
  const declared = Object.keys(record(capabilities.extensions) ?? {})
    .filter((id) => id.length <= MAX_EXTENSION_ID_LENGTH)
    .slice(0, MAX_REMEMBERED_EXTENSIONS);
  for (const [key, value] of serverCapabilities) if (value.expiresAt <= Date.now()) serverCapabilities.delete(key);
  if (serverCapabilities.size >= 2000) serverCapabilities.delete(serverCapabilities.keys().next().value!);
  serverCapabilities.set(eraKey, {
    capabilities: { extensions: Object.fromEntries(declared.map((id) => [id, {}])) },
    expiresAt: Date.now() + ERA_TTL_MS,
  });
}

/** The extensions a stateless server last declared (`{extensions: {id: {}}}`), or null when not known in this process. */
export function knownMcpServerCapabilities(eraKey: string): Record<string, unknown> | null {
  const cached = serverCapabilities.get(eraKey);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.capabilities;
}

/** Whether advertised capabilities declare an MCP extension. */
export function mcpServerDeclaresExtension(capabilities: Record<string, unknown> | null, extensionId: string): Record<string, unknown> | null {
  const extensions = record(capabilities?.extensions);
  return record(extensions?.[extensionId]);
}

type McpInitializeInput = {
  send: (init: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  requestId: string;
  /** Identifies the server (connection + endpoint) so its era is probed once. */
  eraKey?: string;
};

type DiscoverOutcome = { protocolVersion: string; capabilities?: Record<string, unknown> } | { legacy: true };

/**
 * Ask the server which versions it supports (`server/discover`). A modern
 * server answers with them, or with a modern error listing them. Anything
 * else identifies a legacy server, which then gets the `initialize` handshake.
 */
async function discoverMcpProtocol(input: McpInitializeInput): Promise<DiscoverOutcome> {
  const requestId = `${input.requestId}-discover`;
  const init = mcpHttpRequestInit(
    { ...input.headers, "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION },
    { id: requestId, method: "server/discover", params: {} },
  );
  let response: Response;
  try {
    response = await input.send(init);
  } catch (error) {
    // A timeout or abort belongs to the caller. Other failures are what some
    // legacy servers do with an unknown method; the handshake reports its own.
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    return { legacy: true };
  }
  if (response.status === 401 || response.status === 403) {
    // Preserve the challenge exactly as the handshake would have, for sign-in.
    throw markMcpHttpResponseFailure(response, new McpHttpInitializationError(
      `Remote MCP initialization returned HTTP ${response.status}`, "initialize", response.status, response,
    ));
  }
  let payload: unknown = null;
  try {
    payload = response.ok
      ? await readMcpHttpResponse(response, requestId, { maxBytes: 256 * 1024 })
      : parseMcpHttpResponseBody(await readSmallBody(response), response.headers.get("content-type"));
  } catch {
    return { legacy: true };
  }
  const result = record(record(payload)?.result);
  if (result && Array.isArray(result.supportedVersions)) {
    const selected = selectMcpProtocolVersion(result.supportedVersions);
    if (!selected) throw new McpHttpInitializationError("This app uses an MCP version Paperclip does not support yet.", "initialize", response.status);
    const capabilities = record(result.capabilities);
    return { protocolVersion: selected, ...(capabilities ? { capabilities } : {}) };
  }
  const modernError = mcpModernErrorOf(payload);
  if (modernError) {
    if (modernError.code !== MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION || !modernError.supported) return { protocolVersion: MCP_MODERN_PROTOCOL_VERSION };
    const selected = selectMcpProtocolVersion(modernError.supported);
    if (!selected) throw new McpHttpInitializationError("This app uses an MCP version Paperclip does not support yet.", "initialize", response.status);
    return { protocolVersion: selected };
  }
  return { legacy: true };
}

/**
 * Establish how to talk to a Streamable HTTP server and return the protocol
 * headers for later requests. Modern servers get only the version header (no
 * handshake, no session); legacy servers get the `initialize` handshake.
 * Callers may retain the headers in the in-memory cache scoped to the
 * connection and effective credential identity.
 */
export async function initializeMcpHttpSession(input: McpInitializeInput): Promise<Record<string, string>> {
  const remembered = input.eraKey ? knownMcpProtocolVersion(input.eraKey) : null;
  const protocolVersion = await negotiateMcpProtocolVersion(input);
  if (isModernMcpProtocolVersion(protocolVersion)) return { ...input.headers, "MCP-Protocol-Version": protocolVersion };
  try {
    return await initializeLegacyMcpHttpSession(input, protocolVersion);
  } catch (error) {
    // A remembered legacy server that now refuses the handshake may have moved
    // to stateless MCP. Probe again rather than failing every call until the
    // cached era expires.
    if (!remembered || !input.eraKey || !(error instanceof McpHttpInitializationError)
      || error.stage !== "initialize" || ![400, 404, 405].includes(error.status ?? 0)) throw error;
    forgetMcpProtocolVersion(input.eraKey);
    const reprobed = await negotiateMcpProtocolVersion(input);
    if (!isModernMcpProtocolVersion(reprobed)) throw error;
    await error.response?.body?.cancel().catch(() => undefined);
    return { ...input.headers, "MCP-Protocol-Version": reprobed };
  }
}

/**
 * The version to use with this server: the remembered one, or the newest
 * mutually supported version from `server/discover`. A legacy server yields
 * the legacy version Paperclip requests in its `initialize` handshake.
 */
export async function negotiateMcpProtocolVersion(input: McpInitializeInput): Promise<string> {
  const known = input.eraKey ? knownMcpProtocolVersion(input.eraKey) : null;
  if (known) return known;
  const outcome = await discoverMcpProtocol(input);
  const protocolVersion = "protocolVersion" in outcome ? outcome.protocolVersion : MCP_PROTOCOL_VERSION;
  if (input.eraKey) rememberMcpProtocolVersion(input.eraKey, protocolVersion);
  if (input.eraKey && "capabilities" in outcome && outcome.capabilities) rememberMcpServerCapabilities(input.eraKey, outcome.capabilities);
  return protocolVersion;
}

async function initializeLegacyMcpHttpSession(input: McpInitializeInput, requestedVersion: string): Promise<Record<string, string>> {
  const initializeResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders({ ...input.headers, "Mcp-Method": "initialize" }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${input.requestId}-initialize`,
      method: "initialize",
      params: {
        protocolVersion: requestedVersion,
        capabilities: mcpClientCapabilities(requestedVersion),
        clientInfo: MCP_CLIENT_INFO,
      },
    }),
  });
  if (!initializeResponse.ok) {
    throw markMcpHttpResponseFailure(initializeResponse, new McpHttpInitializationError(
      `Remote MCP initialization returned HTTP ${initializeResponse.status}`,
      "initialize",
      initializeResponse.status,
      initializeResponse,
    ));
  }
  let payload: unknown;
  try {
    payload = await withMcpConnectionFailure(() => readMcpHttpResponse(initializeResponse, `${input.requestId}-initialize`));
  } catch (error) {
    throw retainMcpConnectionFailure(error, new McpHttpInitializationError("Remote MCP initialization returned an invalid response", "initialize", null));
  }
  const result = payload && typeof payload === "object" && "result" in payload
    ? (payload as { result?: unknown }).result
    : null;
  const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : null;
  if (!resultRecord) throw new McpHttpInitializationError("Remote MCP initialization failed", "initialize", null);
  const protocolVersion = typeof resultRecord?.protocolVersion === "string" && resultRecord.protocolVersion
    ? resultRecord.protocolVersion
    : requestedVersion;
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  const sessionHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    "MCP-Protocol-Version": protocolVersion,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
  const initializedResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders({ ...sessionHeaders, "Mcp-Method": "notifications/initialized" }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  if (!initializedResponse.ok) {
    throw markMcpHttpResponseFailure(initializedResponse, new McpHttpInitializationError(
      `Remote MCP initialized notification returned HTTP ${initializedResponse.status}`,
      "initialized_notification",
      initializedResponse.status,
    ));
  }
  return sessionHeaders;
}

function looksLikeJsonRpcMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "result" in record || "error" in record || "method" in record || "id" in record;
}

/**
 * Parse the body of an MCP Streamable HTTP response into its JSON-RPC payload.
 *
 * Handles both response shapes the transport allows:
 *  - `application/json`: the body is the JSON-RPC message directly.
 *  - `text/event-stream`: one or more SSE events; we return the JSON payload of
 *    the first `data:` event that parses as a JSON-RPC message.
 *
 * Falls back to a plain JSON parse when the content type is unknown so we stay
 * compatible with non-compliant servers that ignore the Accept header.
 */
export function parseMcpHttpResponseBody(bodyText: string, contentType: string | null): unknown {
  const isEventStream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isEventStream) {
    return JSON.parse(bodyText) as unknown;
  }

  // Split the SSE stream into events on blank lines, then collect each event's
  // `data:` lines (which may span multiple lines per the SSE spec).
  const events = bodyText.replace(/\r\n/g, "\n").split(/\n\n+/);
  let lastError: unknown = null;
  let firstParsed: unknown;
  let sawData = false;
  for (const event of events) {
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!sawData) {
      firstParsed = parsed;
      sawData = true;
    }
    if (looksLikeJsonRpcMessage(parsed)) {
      return parsed;
    }
  }
  if (sawData) return firstParsed;
  if (lastError) throw lastError;
  throw new SyntaxError("MCP SSE response contained no data events");
}

export type McpHttpResponseProgress = {
  bytesReceived: number;
  chunksReceived: number;
  eventsReceived: number;
  matchedResponse: boolean;
  ended: boolean;
};

/** Read until the response for this request arrives, without waiting for an SSE
 * connection to close. Notifications and responses for other IDs are ignored. */
export async function readMcpHttpResponse(
  response: Response,
  requestId: string | number,
  options: {
    maxBytes?: number;
    onRequest?: (message: Record<string, unknown>) => Promise<void>;
    onProgress?: (progress: McpHttpResponseProgress) => void;
  } = {},
): Promise<unknown> {
  const progress: McpHttpResponseProgress = { bytesReceived: 0, chunksReceived: 0, eventsReceived: 0, matchedResponse: false, ended: false };
  options.onProgress?.(progress);
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const isStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
  const reader = response.body?.getReader();
  // Injected HTTP transports can expose a buffered text response rather than a
  // Web ReadableStream. Keep the same size and message-ID checks for both forms.
  if (!reader) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new McpHttpResponseError("too_large", "MCP response exceeded the size limit");
    return readMcpHttpResponse(new Response(body, {
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    }), requestId, options);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const parse = (text: string): unknown => {
    try { return JSON.parse(text); }
    catch { throw new McpHttpResponseError("invalid_json", "MCP response contained invalid JSON"); }
  };
  const inspect = async (message: unknown): Promise<unknown | undefined> => {
    if (!message || typeof message !== "object") return undefined;
    const record = message as Record<string, unknown>;
    if (record.id === requestId && ("result" in record || "error" in record)) {
      progress.matchedResponse = true;
      return record;
    }
    if ("method" in record && "id" in record) await options.onRequest?.(record);
    return undefined;
  };
  const event = async (value: string) => {
    const data = value.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return undefined;
    progress.eventsReceived += 1;
    return inspect(parse(data));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength ?? 0;
      progress.bytesReceived = bytes;
      if (value) progress.chunksReceived += 1;
      progress.ended = done;
      if (bytes > maxBytes) throw new McpHttpResponseError("too_large", "MCP response exceeded the size limit");
      buffer += decoder.decode(value, { stream: !done });
      if (isStream) {
        // Normalize CRLF after concatenating chunks, including split CR/LF pairs.
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const result = await event(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (result !== undefined) return result;
        }
      }
      if (done) break;
    }
    const result = isStream ? await event(buffer) : await inspect(parse(buffer));
    if (result !== undefined) return result;
    throw new McpHttpResponseError("malformed_response", "MCP response did not contain the requested message ID");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const sessions = new Map<string, { headers: Record<string, string>; expiresAt: number }>();
const initializing = new Map<string, Promise<Record<string, string>>>();
const SESSION_TTL_MS = 30 * 60_000;

/** Separates cached state per credential without keeping the credential. */
export function mcpCredentialFingerprint(headers: Record<string, string> | undefined) {
  return createHash("sha256").update(JSON.stringify(Object.entries(headers ?? {}).sort())).digest("hex");
}

/** Key for one server's protocol era: the connection and the endpoint it calls. */
export function mcpEraKey(connectionId: string, endpoint: string | URL) {
  return `${connectionId}:era:${String(endpoint)}`;
}

function mcpHttpSessionKey(scope: string, headers: Record<string, string> | undefined) {
  return `${scope}:${mcpCredentialFingerprint(headers)}`;
}

/** Cache only protocol headers; credential hashes and scope separate every
 * connection and effective identity. Never cache a tool call or replay a write. */
export async function getMcpHttpSession(input: Parameters<typeof initializeMcpHttpSession>[0] & { scope: string }) {
  const key = mcpHttpSessionKey(input.scope, input.headers);
  const cached = sessions.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...input.headers, ...cached.headers };
  const pending = initializing.get(key);
  if (pending) return pending;
  const promise = initializeMcpHttpSession(input).then((headers) => {
    if (initializing.get(key) !== promise) throw new Error("MCP connection changed while initializing; reconnect before calling tools");
    for (const [id, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(id);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
    const protocolHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => ["mcp-session-id", "mcp-protocol-version"].includes(name.toLowerCase())));
    sessions.set(key, { headers: protocolHeaders, expiresAt: Date.now() + SESSION_TTL_MS });
    return headers;
  }).finally(() => { if (initializing.get(key) === promise) initializing.delete(key); });
  initializing.set(key, promise);
  return promise;
}

/** Drop one identity's cached session after the server may have ended it. Other
 * identities, in-flight initializations, and a session that already replaced
 * the failed one are kept. */
export function forgetMcpHttpSession(input: { scope: string; headers?: Record<string, string>; sessionId: string }) {
  const key = mcpHttpSessionKey(input.scope, input.headers);
  const cached = sessions.get(key);
  if (cached && new Headers(cached.headers).get("mcp-session-id") === input.sessionId) sessions.delete(key);
}

export function forgetMcpHttpSessions(connectionId: string) {
  for (const key of sessions.keys()) if (key.startsWith(`${connectionId}:`)) sessions.delete(key);
  for (const key of initializing.keys()) if (key.startsWith(`${connectionId}:`)) initializing.delete(key);
  for (const key of eras.keys()) if (key.startsWith(`${connectionId}:`)) eras.delete(key);
}
