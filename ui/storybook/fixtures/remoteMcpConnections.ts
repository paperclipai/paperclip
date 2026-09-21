import { type JsonSchemaNode } from "@/components/JsonSchemaForm";
import { remoteMcpProviders, type RemoteMcpProviderId } from "@/features/connections/remote-mcp/providers";
import type { ConnectStatus, RemoteMcpSetupState, RemoteMcpTool } from "@/features/connections/remote-mcp/types";

export const reviewAgents = [
  { id: "researcher", name: "Researcher" },
  { id: "operator", name: "Operator" },
  { id: "unassigned", name: "Unassigned agent" },
];

const querySchema: JsonSchemaNode = { type: "object", required: ["query"], properties: { query: { type: "string", title: "Search query", default: "Paperclip connector review", description: "Use disposable review data." }, limit: { type: "integer", default: 5, minimum: 1, maximum: 20 } } };
const codeSchema: JsonSchemaNode = { type: "object", required: ["code"], properties: { code: { type: "string", title: "Code", default: 'return { message: "Paperclip connector review" };', description: "Example only. Real tools supply their own argument schema." } } };
const action = (id: string, name: string, description: string, schema = querySchema, broad = false, readOnly = false): RemoteMcpTool => ({
  id, toolName: id, title: name, description, inputSchema: schema as Record<string, unknown>, broad,
  companyId: "company-storybook", applicationId: null, connectionId: "review-fixture", entryKind: "tool",
  outputSchema: null, annotations: { readOnlyHint: readOnly }, riskLevel: readOnly ? "read" : "write",
  isReadOnly: readOnly, isWrite: !readOnly, isDestructive: false, status: "active",
  addedAt: new Date("2026-09-21"), version: null, schemaHash: null,
  firstSeenAt: new Date("2026-09-21"), lastSeenAt: new Date("2026-09-21"),
  reviewedAt: null, reviewedByAgentId: null, reviewedByUserId: null,
  createdAt: new Date("2026-09-21"), updatedAt: new Date("2026-09-21"),
});
const readAction = (id: string, name: string, description: string, schema = querySchema, broad = false) => action(id, name, description, schema, broad, true);

// Representative response fixtures, not hardcoded production catalogs. Discovery owns
// real tool names, descriptions and schemas. Never put credentials or account data here.
function providerTools(provider: RemoteMcpProviderId, broad = false): RemoteMcpTool[] {
  switch (provider) {
    case "zapier": return broad ? [
      readAction("execute_zapier_read_action", "Execute a read action", "Run a read action available to this Zapier server.", querySchema, true),
      action("execute_zapier_write_action", "Execute a write action", "Run a write action available to this Zapier server.", querySchema, true),
      action("enable_zapier_action", "Enable an action", "Change the actions available inside Zapier.", querySchema, true),
    ] : [
      readAction("google_sheets_find_rows", "Find spreadsheet rows", "Find matching rows in the connected review spreadsheet."),
      action("google_sheets_create_row", "Create a spreadsheet row", "Add one row to the connected review spreadsheet.", { type: "object", required: ["text"], properties: { text: { type: "string", default: "Disposable connector review row" } } }),
      readAction("gmail_find_email", "Find email", "Search the connected mailbox."),
    ];
    case "arcade": return broad ? [
      action("Review.Execute", "Execute connected tools", "An example custom execution tool explicitly exposed by this gateway.", codeSchema, true),
      readAction("Gmail.ListEmails", "List emails", "List messages in the connected Gmail account."),
    ] : [
      readAction("Gmail.ListEmails", "List emails", "List messages in the connected Gmail account."),
      readAction("GoogleCalendar.ListEvents", "List calendar events", "Find events on the connected calendar."),
      action("Slack.SendMessage", "Send a Slack message", "Send to a disposable review channel.", { type: "object", required: ["channel", "text"], properties: { channel: { type: "string", default: "connector-review" }, text: { type: "string", default: "Disposable review message" } } }),
    ];
    case "composio": return [
      readAction("COMPOSIO_SEARCH_TOOLS", "Search tools", "Discover actions across your Composio apps.", querySchema, true),
      action("COMPOSIO_MULTI_EXECUTE_TOOL", "Execute tools", "Execute one or more actions through Composio.", { type: "object", required: ["tools"], properties: { tools: { type: "array", items: { type: "object", properties: { tool_slug: { type: "string" }, arguments: { type: "object", additionalProperties: true } } } } } }, true),
      action("COMPOSIO_MANAGE_CONNECTIONS", "Manage app connections", "Start app authorization and manage accounts inside Composio.", querySchema, true),
      action("COMPOSIO_REMOTE_WORKBENCH", "Run workbench code", "Use connected apps from Composio’s execution environment.", codeSchema, true),
    ];
    case "executor": return [
      action("execute", "Execute code", "Run code using the sources configured in your Executor workspace.", codeSchema, true),
      action("resume", "Resume execution", "Continue a paused execution after its provider approval.", { type: "object", required: ["executionId", "action"], properties: { executionId: { type: "string", default: "review-execution-001" }, action: { type: "string", enum: ["accept", "decline", "cancel"], default: "accept" }, content: { type: "string", default: "{}" } } }, true),
    ];
  }
}

export const newFixtureTool = readAction("review_new_tool", "Newly discovered tool", "An example tool added in the provider since your last refresh.");

export function fixtureTools(provider: RemoteMcpProviderId, broad = false) {
  return providerTools(provider, broad).map((tool) => ({ ...tool, connectionId: `review-${provider}` }));
}

export const reviewScenarios = [
  "journey", "initial", "selected_agents", "connect", "advanced", "connecting", "sign_in", "returned", "cancelled", "invalid_url", "rejected", "unreachable", "permissions", "broad", "completed", "reconnect", "draft", "new_tools", "direct_tools", "provider_pending",
] as const;
export type ReviewScenario = typeof reviewScenarios[number];

export function exampleUrl(provider: RemoteMcpProviderId): string {
  return provider === "composio" ? remoteMcpProviders.composio.defaultUrl : `https://${provider}.example.invalid/review/mcp`;
}

export function initialReviewState(provider: RemoteMcpProviderId, scenario: ReviewScenario): RemoteMcpSetupState {
  const config = remoteMcpProviders[provider];
  let tools = fixtureTools(provider, scenario === "broad");
  if (scenario === "direct_tools") tools = [readAction("GMAIL_FETCH_EMAILS", "Fetch emails", "An individual action from an externally configured direct-tools session.")];
  if (scenario === "new_tools") tools = [...tools, newFixtureTool];
  const access = ["journey", "initial", "selected_agents"].includes(scenario);
  const setupComplete = !access && !["connect", "advanced", "connecting", "sign_in", "cancelled", "invalid_url", "rejected", "unreachable", "draft"].includes(scenario);
  const connectCases: Partial<Record<ReviewScenario, ConnectStatus>> = { connect: "idle", advanced: "idle", connecting: "connecting", sign_in: "sign_in", cancelled: "cancelled", invalid_url: "invalid_url", rejected: "rejected", unreachable: "unreachable", reconnect: "idle" };
  const isConnect = scenario in connectCases;
  const state: RemoteMcpSetupState = {
    step: access ? "access" : isConnect ? "connect" : scenario === "completed" ? "management" : scenario === "draft" ? "draft" : "permissions",
    grantKind: "organization", setupComplete,
    url: ["initial", "journey", "connect", "selected_agents"].includes(scenario) ? config.defaultUrl : scenario === "invalid_url" ? "not-a-server-url" : exampleUrl(provider),
    auth: scenario === "advanced" ? provider === "composio" ? "headers" : "bearer" : config.supportsBrowserAuth ? "auto" : "none",
    token: "", headers: scenario === "advanced" ? [{ id: "header-1", name: provider === "arcade" ? "Arcade-User-ID" : "X-Session-Key", value: "" }] : [],
    advanced: scenario === "advanced", connectStatus: connectCases[scenario] ?? "idle",
    connected: !access && !isConnect, identity: provider === "zapier" ? null : "reviewer@example.invalid",
    allAgents: scenario !== "selected_agents", agentIds: access && scenario !== "selected_agents" ? [] : ["researcher", "operator"],
    permissions: Object.fromEntries(tools.map((tool, index) => [tool.id, scenario !== "new_tools" || tool.id === newFixtureTool.id ? "allowed" : index === 1 ? "ask_first" : index === 2 ? "off" : "allowed"])),
    tools: tools.map((tool) => ({ ...tool, connectionId: `review-${provider}` })),
    notice: scenario === "reconnect" ? "Reconnect this connection. Saved agent access and tool permissions will be retained." : scenario === "new_tools" ? "1 new tool is Allowed. Existing Off and Ask first choices were preserved." : scenario === "direct_tools" ? "Imported direct-tools session. The external setup controls which actions are exposed." : null,
    refreshing: false,
  };
  return state;
}
