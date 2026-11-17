import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoogleWorkspaceAuthError } from "./errors.js";
import type { GoogleFetch } from "./google-http.js";
import { callGoogleWorkspaceRestTool, listGoogleWorkspaceRestTools, type GoogleWorkspaceRestService } from "./tools.js";

export interface GoogleWorkspaceRestServerOptions {
  fetch?: GoogleFetch;
  timeoutMs?: number;
}

export function createGoogleWorkspaceRestServer(service: GoogleWorkspaceRestService, options: GoogleWorkspaceRestServerOptions = {}): Server {
  const server = new Server(
    { name: `paperclip-google-workspace-rest-${service}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listGoogleWorkspaceRestTools(service) }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const accessToken = extra.authInfo?.token;
    if (!accessToken) throw new GoogleWorkspaceAuthError("unauthenticated");
    return callGoogleWorkspaceRestTool({
      service,
      name: request.params.name,
      arguments: request.params.arguments,
      accessToken,
      fetch: options.fetch,
      signal: extra.signal,
      timeoutMs: options.timeoutMs,
    });
  });
  return server;
}
