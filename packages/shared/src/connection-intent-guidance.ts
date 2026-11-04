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
  "- Distinguish tool, chat/channel, and AI account purposes. Use `search_api` and `call_api` for authorized connection configuration requested by the user. Standard agents can manage connections under their responsible user's authority; inspect the returned capabilities and respect explicit restrictions. Reuse saved accounts and setup drafts.",
  "- Suggest a relevant connection when it would help the task and usable access is missing. Respect recorded declines and provider choices. Ask only for missing decisions, consent, credentials, or authority; never ask for credentials in comments. Hand off the exact required human action at the saved setup link, then inspect status and continue through the API.",
  "- If a tool call is blocked by Off/Ask first or missing installation access, use `connection_request` with the saved connectionId and required toolNames. Do not silently relax policy to work around a failed call. You may perform an access-policy change explicitly requested by the user when authorized; never approve your own governed action or change your own principal permissions.",
  "- Report saved, authenticated, usable, and verified as separate states. A saved connection is not proof of successful authentication or a verified provider action.",
  "- When waiting for user action, finish independent work, then yield without retrying or polling. On continuation, follow the recorded outcome and use the installed connection.",
  "- Do not use connection tools for arbitrary MCP URLs or unrelated work.",
].join("\n");

export const CONNECTIONS_SEARCH_TOOL_DESCRIPTION = "Search connections across tool, channel/email, and AI purposes with a service name or natural-language description (up to 4000 characters). Choose the relevant method and inspect its management capabilities. For user-requested configuration, discover and call the existing REST operation with search_api/call_api; reuse saved drafts and hand off only required human authentication or consent. Use connection_request for missing access or required user input. Also discovers verified external aggregator apps. Use first when asked to connect a service or usable access is uncertain; respect the returned instruction, recorded declines, and exact providerQuestion. Do not use for arbitrary MCP URLs. Search is read-only.";

export const CONNECTION_REQUEST_TOOL_DESCRIPTION = "Request the service identifier returned by connections_search. For an existing connection with missing agent access, pass connectionId and the exact required toolNames to create an embedded Grant access card; only the human can approve it. Follow the search instruction; aggregator routes require the saved provider-selection interaction ID. Only this tool creates the real setup card. If user action is needed, finish independent work, then yield without retrying or asking for credentials in comments.";

export const CONNECTION_RUNTIME_TOOL_NAMES = [
  "connections_search",
  "connection_request",
] as const;
