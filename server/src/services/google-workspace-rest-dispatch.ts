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
  GoogleWorkspaceAuthError,
  callGoogleWorkspaceRestTool,
  googleCalendarSeriesRefusal,
  googleWorkspaceArgumentRefusal,
  isGoogleWorkspaceRestService,
  listGoogleWorkspaceRestTools,
  probeGoogleWorkspaceRestService,
  type GoogleAuthFailure,
  type GoogleFetch,
  type GoogleWorkspaceRestService,
} from "../google-workspace-rest-tools/index.js";

export type GoogleWorkspaceRestAuthFailure = GoogleAuthFailure;

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

export async function googleWorkspaceMcpPreflightRefusal(input: GoogleWorkspaceMcpPreflight): Promise<string | null> {
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
