/**
 * Canonical instructions for the run-scoped connection tools.
 *
 * Keep this text provider-neutral and free of run identity, credentials, URLs,
 * or bearer tokens: it is reused in prompts, adapter descriptors, CLI help,
 * environment delivery, and MCP tool descriptions.
 */
export const CONNECTION_INTENT_AGENT_GUIDANCE = [
  "Connection tools:",
  "- When the user asks to connect a service, call `connections_search` before any service tool, even if already installed. Also search when a task needs a service and usable access is uncertain. Search by its name or capability and follow the returned `instruction`.",
  "- Use the returned service identifiers and connection tools for setup. Respect recorded user choices; never invent access or ask for credentials in comments.",
  "- When waiting for user action, finish independent work, then yield without retrying or polling. On continuation, follow the recorded outcome and use the installed connection.",
  "- Do not use connection tools for arbitrary MCP URLs or unrelated work.",
].join("\n");

export const CONNECTIONS_SEARCH_TOOL_DESCRIPTION = "Search Paperclip connections first and eligible external aggregator routes when no built-in service matches. Use first when the user asks to connect a service, or when usable access is uncertain; follow the returned instruction and exact providerQuestion, if any. Do not use for arbitrary MCP URLs. Search is read-only.";

export const CONNECTION_REQUEST_TOOL_DESCRIPTION = "Request the service identifier returned by connections_search as available or needs_user_action. Follow the search instruction; aggregator routes require the saved provider-selection interaction ID. Only this tool creates the real setup card. If user action is needed, finish independent work, then yield without retrying or asking for credentials in comments.";

export const CONNECTION_RUNTIME_TOOL_NAMES = [
  "connections_search",
  "connection_request",
] as const;
