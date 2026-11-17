import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { GoogleWorkspaceAuthError } from "./errors.js";
import { CALENDAR_TOOLS } from "./calendar/index.js";
import { DOCS_TOOLS } from "./docs/index.js";
import { GMAIL_TOOLS } from "./gmail/index.js";
import { SLIDES_TOOLS } from "./slides/index.js";
import { createGoogleHttp, type GoogleFetch } from "./google-http.js";
import { SHEETS_TOOLS } from "./sheets/index.js";
import type { RestTool } from "./tool.js";

export const GOOGLE_WORKSPACE_REST_SERVICES = ["gmail", "calendar", "docs", "slides", "sheets"] as const;
export type GoogleWorkspaceRestService = (typeof GOOGLE_WORKSPACE_REST_SERVICES)[number];

const TOOLS: Record<GoogleWorkspaceRestService, readonly RestTool[]> = {
  gmail: GMAIL_TOOLS,
  calendar: CALENDAR_TOOLS,
  docs: DOCS_TOOLS,
  slides: SLIDES_TOOLS,
  sheets: SHEETS_TOOLS,
};

export function isGoogleWorkspaceRestService(value: string): value is GoogleWorkspaceRestService {
  return (GOOGLE_WORKSPACE_REST_SERVICES as readonly string[]).includes(value);
}

export function listGoogleWorkspaceRestTools(service: GoogleWorkspaceRestService): Tool[] {
  return TOOLS[service].map((tool) => tool.definition);
}

export interface CallGoogleWorkspaceRestToolInput {
  service: GoogleWorkspaceRestService;
  name: string;
  arguments?: Record<string, unknown>;
  accessToken: string;
  fetch?: GoogleFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function callGoogleWorkspaceRestTool(input: CallGoogleWorkspaceRestToolInput): Promise<CallToolResult> {
  const tool = TOOLS[input.service].find((candidate) => candidate.definition.name === input.name);
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${input.name}`);
  if (!input.accessToken) throw new GoogleWorkspaceAuthError("unauthenticated");
  const http = createGoogleHttp({ accessToken: input.accessToken, fetch: input.fetch, signal: input.signal, timeoutMs: input.timeoutMs });
  return tool.call(input.arguments, http);
}
