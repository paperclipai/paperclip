// Public surface: MCP tool definitions, MCP results and MCP errors only.
// No Google REST types are exported.
export {
  GOOGLE_WORKSPACE_REST_SERVICES,
  callGoogleWorkspaceRestTool,
  isGoogleWorkspaceRestService,
  listGoogleWorkspaceRestTools,
  type CallGoogleWorkspaceRestToolInput,
  type GoogleWorkspaceRestService,
} from "./tools.js";
export { createGoogleWorkspaceRestServer, type GoogleWorkspaceRestServerOptions } from "./server.js";
export { GOOGLE_AUTH_ERROR_CODE, GoogleWorkspaceAuthError, type GoogleAuthFailure } from "./errors.js";
export type { GoogleFetch } from "./google-http.js";
