import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  GOOGLE_WORKSPACE_TOOL_TRANSPORT,
  googleWorkspaceServiceToolNames,
  googleWorkspaceToolName,
  googleWorkspaceToolTarget,
  googleWorkspaceToolTitle,
  type GoogleWorkspaceService,
  type GoogleWorkspaceToolTransport,
} from "@paperclipai/shared";
import {
  GOOGLE_WORKSPACE_REST_SHIPPED_SCHEMA_HASHES,
  GoogleWorkspaceAuthError,
  callGoogleWorkspaceRestTool,
  googleCalendarSeriesRefusal,
  googleWorkspaceArgumentRefusal,
  isGoogleWorkspaceRestService,
  listGoogleWorkspaceRestTools,
  probeGoogleWorkspaceRestService,
  type GoogleAuthFailure,
  type GoogleFetch,
  type GoogleWorkspaceRefusal,
  type GoogleWorkspaceRestService,
} from "../google-workspace-rest-tools/index.js";

export type GoogleWorkspaceRestAuthFailure = GoogleAuthFailure;
export type { GoogleWorkspaceRefusal };

export interface GoogleWorkspaceRestContext {
  service: GoogleWorkspaceService;
  credentialHeaders: Record<string, string>;
  fetch: GoogleFetch;
  signal?: AbortSignal;
}

export type GoogleWorkspaceRestCallOutcome =
  | { ok: true; result: CallToolResult }
  | { ok: false; authFailure: GoogleWorkspaceRestAuthFailure };

export type GoogleWorkspaceRestProbeOutcome =
  | { ok: true }
  | { ok: false; authFailure: "unauthenticated" | null; message: string };

export function googleWorkspaceRestAuditEndpoint(service: GoogleWorkspaceService): string {
  return `paperclip-rest:google-workspace/${service}`;
}

export function listGoogleWorkspaceRest(service: GoogleWorkspaceService): Tool[] {
  return listGoogleWorkspaceRestTools(restService(service));
}

export interface GoogleWorkspaceRestToolDefinition {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown>;
}

export function googleWorkspaceRestToolDefinition(toolName: string): GoogleWorkspaceRestToolDefinition | null {
  return googleWorkspaceTransport(toolName) === "paperclip_rest" ? googleWorkspaceRestFallbackDefinition(toolName) : null;
}

export function googleWorkspaceRestFallbackDefinition(toolName: string): GoogleWorkspaceRestToolDefinition | null {
  const target = googleWorkspaceToolTarget(toolName);
  if (!target || !isGoogleWorkspaceRestService(target.service)) return null;
  const tool = listGoogleWorkspaceRestTools(target.service).find((candidate) => candidate.name === target.leaf);
  return tool ? {
    name: tool.name,
    title: googleWorkspaceCatalogToolTitle("google-workspace", toolName, tool.title),
    description: tool.description ?? null,
    inputSchema: { ...tool.inputSchema },
    outputSchema: tool.outputSchema ? { ...tool.outputSchema } : null,
    annotations: { ...tool.annotations },
  } : null;
}

export function googleWorkspaceRestShippedSchemaHashes(toolName: string): readonly string[] {
  const target = googleWorkspaceToolTarget(toolName);
  return target ? GOOGLE_WORKSPACE_REST_SHIPPED_SCHEMA_HASHES[`${target.service}__${target.leaf}`] ?? [] : [];
}

function googleWorkspaceTransport(toolName: string): GoogleWorkspaceToolTransport | null {
  return googleWorkspaceToolTarget(toolName)?.transport ?? null;
}

export function googleWorkspaceCatalogToolTitle(
  sourceTemplateKey: unknown,
  name: string,
  title: string | null | undefined,
): string | null {
  if (sourceTemplateKey !== "google-workspace") return title ?? null;
  const target = googleWorkspaceToolTarget(name);
  const restTitle = target && isGoogleWorkspaceRestService(target.service)
    ? listGoogleWorkspaceRestTools(target.service).find((tool) => tool.name === target.leaf)?.title
    : undefined;
  return googleWorkspaceToolTitle(name, restTitle ?? title);
}

export interface GoogleWorkspaceMcpPreflight {
  toolName: string;
  arguments: unknown;
  inputSchema: unknown;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown | null>;
}

export async function googleWorkspaceMcpPreflightRefusal(input: GoogleWorkspaceMcpPreflight): Promise<GoogleWorkspaceRefusal | null> {
  const target = googleWorkspaceToolTarget(input.toolName);
  if (!target || !isGoogleWorkspaceRestService(target.service)) return null;
  const refusal = googleWorkspaceArgumentRefusal({ service: target.service, toolName: target.leaf, arguments: input.arguments, inputSchema: input.inputSchema });
  if (refusal || target.service !== "calendar" || target.leaf !== "delete_event") return refusal;
  const args = (input.arguments ?? {}) as Record<string, unknown>;
  const lookup = Object.fromEntries(["calendarId", "eventId"].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
  const result = await input.callTool(googleWorkspaceToolName("calendar", "get_event"), lookup);
  const record = (result && typeof result === "object" ? result : {}) as { content?: unknown; data?: { isError?: unknown; structuredContent?: unknown } };
  return googleCalendarSeriesRefusal({
    isError: record.data?.isError === true,
    structuredContent: record.data?.structuredContent ?? null,
    text: typeof record.content === "string" ? record.content : null,
  });
}

const GOOGLE_STATUSES = ["INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE", "UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND",
  "ABORTED", "ALREADY_EXISTS", "RESOURCE_EXHAUSTED", "CANCELLED", "DATA_LOSS", "UNKNOWN", "INTERNAL", "NOT_IMPLEMENTED", "UNAVAILABLE",
  "DEADLINE_EXCEEDED"] as const;
const GOOGLE_HTTP_STATUSES: Readonly<Record<number, (typeof GOOGLE_STATUSES)[number]>> = {
  400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 409: "ABORTED", 412: "FAILED_PRECONDITION",
  429: "RESOURCE_EXHAUSTED", 499: "CANCELLED", 500: "INTERNAL", 501: "NOT_IMPLEMENTED", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED",
};
const GOOGLE_RETRYABLE_STATUSES = new Set(["RESOURCE_EXHAUSTED", "UNAVAILABLE", "DEADLINE_EXCEEDED"]);
const GOOGLE_STATUS_TEXT = new RegExp(`\\b(${GOOGLE_STATUSES.join("|")})\\b`);
const GOOGLE_HTTP_STATUS_TEXT = /\b(?:HTTP|status|code)\b["']?\s*[:=]?\s*([45]\d\d)\b/i;

function googleStatusOf(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.status === "string" && (GOOGLE_STATUSES as readonly string[]).includes(record.status)) return record.status;
  for (const key of ["code", "status"]) {
    const http = record[key];
    if (typeof http === "number" && GOOGLE_HTTP_STATUSES[http]) return GOOGLE_HTTP_STATUSES[http]!;
  }
  return googleStatusOf(record.error, depth + 1);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function googleStatusInText(text: string): string | null {
  const parsed = googleStatusOf(parseJson(text));
  if (parsed) return parsed;
  const named = GOOGLE_STATUS_TEXT.exec(text)?.[1];
  if (named) return named;
  const http = Number(GOOGLE_HTTP_STATUS_TEXT.exec(text)?.[1]);
  return GOOGLE_HTTP_STATUSES[http] ?? null;
}

export function googleWorkspaceMcpErrorDetails(result: unknown): { toolCode: string; retryable?: true } {
  const record = (result && typeof result === "object" ? result : {}) as { content?: unknown; structuredContent?: unknown };
  const texts = Array.isArray(record.content)
    ? record.content.flatMap((item) => item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text] : [])
    : [];
  const status = googleStatusOf(record.structuredContent) ?? texts.map(googleStatusInText).find(Boolean) ?? null;
  if (!status) return { toolCode: "google_error" };
  return { toolCode: `google_${status.toLowerCase()}`, ...(GOOGLE_RETRYABLE_STATUSES.has(status) ? { retryable: true as const } : {}) };
}

export async function callGoogleWorkspaceRest(
  input: GoogleWorkspaceRestContext & { toolName: string; arguments: unknown; maxResultBytes: number },
): Promise<GoogleWorkspaceRestCallOutcome> {
  try {
    const result = await callGoogleWorkspaceRestTool({
      service: restService(input.service),
      name: input.toolName,
      arguments: input.arguments as Record<string, unknown> | undefined,
      accessToken: bearerToken(input.credentialHeaders),
      fetch: input.fetch,
      signal: input.signal,
      maxResultBytes: input.maxResultBytes,
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof GoogleWorkspaceAuthError) return { ok: false, authFailure: error.reason };
    throw error;
  }
}

export async function probeGoogleWorkspaceRest(
  input: GoogleWorkspaceRestContext & { grantedScopes: readonly string[] },
): Promise<GoogleWorkspaceRestProbeOutcome> {
  try {
    const probe = await probeGoogleWorkspaceRestService({
      service: restService(input.service),
      accessToken: bearerToken(input.credentialHeaders),
      grantedScopes: input.grantedScopes,
      fetch: input.fetch,
      signal: input.signal,
    });
    return probe.ok ? { ok: true } : { ok: false, authFailure: null, message: probe.message };
  } catch (error) {
    if (error instanceof GoogleWorkspaceAuthError && error.reason === "unauthenticated") {
      return { ok: false, authFailure: "unauthenticated", message: error.message };
    }
    throw error;
  }
}

export function googleWorkspaceRestTransportGaps(
  transport: Readonly<Record<GoogleWorkspaceService, GoogleWorkspaceToolTransport>> = GOOGLE_WORKSPACE_TOOL_TRANSPORT,
): Array<{ service: GoogleWorkspaceService; missing: string[] }> {
  return (Object.keys(transport) as GoogleWorkspaceService[])
    .filter((service) => transport[service] === "paperclip_rest")
    .map((service) => {
      const implemented = new Set(isGoogleWorkspaceRestService(service)
        ? listGoogleWorkspaceRestTools(service).map((tool) => tool.name) : []);
      return { service, missing: googleWorkspaceServiceToolNames(service).filter((name) => !implemented.has(name)) };
    })
    .filter((gap) => gap.missing.length > 0);
}

function restService(service: GoogleWorkspaceService): GoogleWorkspaceRestService {
  if (!isGoogleWorkspaceRestService(service)) throw new Error(`Google Workspace ${service} has no Paperclip REST tools`);
  return service;
}

function bearerToken(headers: Record<string, string>): string {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1] ?? "";
  return value.replace(/^Bearer\s+/i, "").trim();
}
