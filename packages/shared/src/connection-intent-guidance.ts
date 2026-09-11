/**
 * Canonical instructions for the run-scoped connection tools.
 *
 * Keep this text provider-neutral and free of run identity, credentials, URLs,
 * or bearer tokens: it is reused in prompts, adapter descriptors, CLI help,
 * environment delivery, and MCP tool descriptions.
 */
export const CONNECTION_INTENT_AGENT_GUIDANCE = [
  "Connection tools:",
  "- When work requires a known external service and usable access is uncertain, call `connections_search` with the service name or capability.",
  "- This applies both when the user explicitly asks to connect a service and when the requested work implicitly depends on that service.",
  "- If search returns `ready`, use the installed connection; do not create a connection intent.",
  "- If search returns `available` or `needs_user_action`, call `connection_request` with the returned service identifier.",
  "- If search returns `unavailable`, explain that the service is unavailable and do not call `connection_request`.",
  "- If `connection_request` returns `needs_user_action`, finish any independent work, then yield in a waiting posture. Do not retry the request, ask for credentials in comments, or claim access.",
  "- Do not use connection tools for arbitrary MCP URLs, unsupported services, or work that does not require an external service.",
  "- Keep an existing pending card across messages. Do not request again after the user declines unless they explicitly ask to retry.",
  "- On a continuation run after connection setup, use the newly installed connection instead of requesting it again.",
].join("\n");

export const CONNECTIONS_SEARCH_TOOL_DESCRIPTION = [
  "Search Paperclip's catalog services and authorized configured custom connections and report this run's agent-relative access state.",
  "Use it when work requires a known external service and usable access is uncertain; do not use it for arbitrary MCP URLs or unrelated work.",
].join(" ");

export const CONNECTION_REQUEST_TOOL_DESCRIPTION = [
  "Request access to a known connectable service for this run's agent from the responsible user.",
  "Call it only with the service identifier returned as available or needs_user_action by connections_search; if user action is needed, finish independent work, then yield without retrying or asking for credentials in comments.",
].join(" ");

export const CONNECTION_RUNTIME_TOOL_NAMES = [
  "connections_search",
  "connection_request",
] as const;
