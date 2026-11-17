import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  GOOGLE_WORKSPACE_TOOL_TRANSPORT,
  googleWorkspaceServiceToolNames,
  type GoogleWorkspaceService,
  type GoogleWorkspaceToolTransport,
} from "@paperclipai/shared";
import {
  GoogleWorkspaceAuthError,
  callGoogleWorkspaceRestTool,
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

export async function callGoogleWorkspaceRest(
  input: GoogleWorkspaceRestContext & { toolName: string; arguments: unknown },
): Promise<GoogleWorkspaceRestCallOutcome> {
  try {
    const result = await callGoogleWorkspaceRestTool({
      service: restService(input.service),
      name: input.toolName,
      arguments: input.arguments as Record<string, unknown> | undefined,
      accessToken: bearerToken(input.credentialHeaders),
      fetch: input.fetch,
      signal: input.signal,
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
