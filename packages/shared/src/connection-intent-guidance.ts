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
  "- If installed tools are Off or the connection is not enabled for this agent, call `connection_request` with the saved connectionId and required toolNames. It creates a scoped human access card; never substitute a generic permission question or change permissions yourself.",
  "- When waiting for user action, finish independent work, then yield without retrying or polling. On continuation, follow the recorded outcome and use the installed connection.",
  "- Do not use connection tools for arbitrary MCP URLs or unrelated work.",
].join("\n");

export const CONNECTIONS_SEARCH_TOOL_DESCRIPTION = "Search connections across tool, channel/email, and AI purposes with a service name or a natural-language description (up to 4000 characters). Results tolerate extra words, split names, and small typos. Choose the relevant match using its description and method purpose. Follow the returned instruction to present an inline setup card with connection_request or share the method's setupPath. Also discovers verified external aggregator apps. Use first when the user asks to connect a service, or when usable access is uncertain; follow the returned instruction and exact providerQuestion, if any. Do not use for arbitrary MCP URLs. Search is read-only.";

export const CONNECTION_REQUEST_TOOL_DESCRIPTION = "Request the service identifier returned by connections_search. For an existing connection with missing agent access, pass connectionId and the exact required toolNames to create an embedded Grant access card; only the human can approve it. Follow the search instruction; aggregator routes require the saved provider-selection interaction ID. Only this tool creates the real setup card. If user action is needed, finish independent work, then yield without retrying or asking for credentials in comments.";

export const CONNECTION_RUNTIME_TOOL_NAMES = [
  "connections_search",
  "connection_request",
] as const;
