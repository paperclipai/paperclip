export const GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS = [
  "gmail.read", "gmail.draft", "drive.read", "drive.write", "docs.read", "docs.write",
  "sheets.read", "sheets.write", "slides.read", "slides.write", "calendar.read",
  "calendar.write", "chat.read", "chat.write", "people.read", "workspace-search.read",
  "workspace.all",
] as const;

export type GoogleWorkspaceConnectorProfileId = (typeof GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS)[number];

const auth = (scope: string) => `https://www.googleapis.com/auth/${scope}`;

const SERVICE_PROFILES: Readonly<Record<Exclude<GoogleWorkspaceConnectorProfileId, "workspace.all">, {
  appSlug: string;
  serverUrl: string;
  scopes: readonly string[];
  writeTools: readonly string[];
}>> = {
  "gmail.read": def("gmail", "https://gmailmcp.googleapis.com/mcp/v1", [auth("gmail.readonly")]),
  "gmail.draft": def("gmail", "https://gmailmcp.googleapis.com/mcp/v1", [auth("gmail.readonly"), auth("gmail.compose")], ["create_draft"]),
  "drive.read": def("google-drive", "https://drivemcp.googleapis.com/mcp/v1", [auth("drive.readonly")]),
  "drive.write": def("google-drive", "https://drivemcp.googleapis.com/mcp/v1", [auth("drive.readonly"), auth("drive.file")], ["copy_file", "create_file"]),
  "docs.read": def("google-docs", "https://docsmcp.googleapis.com/mcp/v1", [auth("documents.readonly")]),
  "docs.write": def("google-docs", "https://docsmcp.googleapis.com/mcp/v1", [auth("documents")], ["update_doc"]),
  "sheets.read": def("google-sheets", "https://sheetsmcp.googleapis.com/mcp/v1", [auth("spreadsheets.readonly")]),
  "sheets.write": def("google-sheets", "https://sheetsmcp.googleapis.com/mcp/v1", [auth("spreadsheets")], ["update_spreadsheet", "update_values", "update_formulas", "insert_dimension"]),
  "slides.read": def("google-slides", "https://slidesmcp.googleapis.com/mcp/v1", [auth("presentations.readonly")]),
  "slides.write": def("google-slides", "https://slidesmcp.googleapis.com/mcp/v1", [auth("presentations")], ["update_presentation"]),
  "calendar.read": def("google-calendar", "https://calendarmcp.googleapis.com/mcp/v1", [auth("calendar.calendarlist.readonly"), auth("calendar.events.freebusy"), auth("calendar.events.readonly")]),
  "calendar.write": def("google-calendar", "https://calendarmcp.googleapis.com/mcp/v1", [auth("calendar.calendarlist.readonly"), auth("calendar.events")], ["create_event", "update_event", "delete_event", "respond_to_event"]),
  "chat.read": def("google-chat", "https://chatmcp.googleapis.com/mcp/v1", [auth("chat.spaces.readonly"), auth("chat.messages.readonly")]),
  "chat.write": def("google-chat", "https://chatmcp.googleapis.com/mcp/v1", [auth("chat.spaces.readonly"), auth("chat.messages.readonly"), auth("chat.messages.create")], ["send_message"]),
  "people.read": def("google-people", "https://people.googleapis.com/mcp/v1", [auth("directory.readonly"), auth("userinfo.profile"), auth("contacts.readonly")]),
  "workspace-search.read": def("google-workspace-search", "https://workspacemcp.googleapis.com/mcp/v1", [auth("gmail.readonly"), auth("drive.readonly"), auth("calendar.readonly"), auth("chat.messages.readonly")]),
};

/** One consent request, containing only scopes already reviewed for our services. */
export const GOOGLE_WORKSPACE_CONNECTOR_PROFILES = {
  ...SERVICE_PROFILES,
  "workspace.all": def("google-workspace", "https://workspacemcp.googleapis.com/mcp/v1",
    [...new Set(Object.values(SERVICE_PROFILES).flatMap((profile) => profile.scopes))]),
};

export const GOOGLE_WORKSPACE_SERVICES = {
  gmail: "gmail.draft", drive: "drive.write", docs: "docs.write", sheets: "sheets.write",
  slides: "slides.write", calendar: "calendar.write", chat: "chat.write",
  people: "people.read", search: "workspace-search.read",
} as const;
export type GoogleWorkspaceService = keyof typeof GOOGLE_WORKSPACE_SERVICES;

// Each inner group is a set of authorization alternatives; every group is required.
// Keep the reviewed tool allowlist closed, even when upstream adds tools.
const one = (...scopes: string[]) => [scopes.map(auth)];
const toolScopes: Record<GoogleWorkspaceService, Record<string, string[][]>> = {
  gmail: Object.fromEntries([
    ...["get_message", "get_thread", "get_draft", "list_drafts", "list_labels", "search_threads", "list_threads", "search_messages"]
      .map((name) => [name, one("gmail.readonly")]),
    ["create_draft", one("gmail.compose")],
  ]),
  drive: Object.fromEntries([
    ...["download_file_content", "get_file_metadata", "get_file_permissions", "list_recent_files", "read_file_content", "search_files"]
      .map((name) => [name, one("drive.readonly")]),
    ...["copy_file", "create_file"].map((name) => [name, one("drive.file")]),
  ]),
  docs: { read_doc: one("documents.readonly", "documents"), update_doc: one("documents") },
  sheets: Object.fromEntries([
    ...["get_values", "get_spreadsheet"].map((name) => [name, one("spreadsheets.readonly", "spreadsheets")]),
    ...["update_spreadsheet", "update_values", "update_formulas", "insert_dimension"].map((name) => [name, one("spreadsheets")]),
  ]),
  slides: { read_presentation: one("presentations.readonly", "presentations"), update_presentation: one("presentations") },
  calendar: Object.fromEntries([
    ["list_calendars", one("calendar.calendarlist.readonly", "calendar.readonly")],
    ...["get_event", "list_events", "search_events"].map((name) => [name, one("calendar.events.readonly", "calendar.events", "calendar.readonly")]),
    ["suggest_time", one("calendar.events.freebusy", "calendar.events", "calendar.readonly")],
    ...["create_event", "update_event", "delete_event", "respond_to_event"].map((name) => [name, one("calendar.events")]),
  ]),
  chat: {
    search_conversations: one("chat.spaces.readonly"),
    list_messages: one("chat.messages.readonly"), search_messages: one("chat.messages.readonly"),
    send_message: one("chat.messages.create"),
  },
  people: {
    search_directory_people: one("directory.readonly"), search_contacts: one("contacts.readonly"),
    get_user_profile: one("userinfo.profile"),
  },
  search: { search_corpus: SERVICE_PROFILES["workspace-search.read"].scopes.map((scope) => [scope]) },
};

export function googleWorkspaceToolName(service: GoogleWorkspaceService, upstreamName: string): string {
  return `${service}__${upstreamName}`;
}

/** The endpoint is derived from a closed registry, never provider annotations or caller input. */
export function googleWorkspaceToolTarget(name: string) {
  const separator = name.indexOf("__");
  const service = name.slice(0, separator) as GoogleWorkspaceService;
  if (separator < 1 || !Object.hasOwn(GOOGLE_WORKSPACE_SERVICES, service)) return null;
  const upstreamName = name.slice(separator + 2);
  const leaf = (upstreamName.split(/[.:/]/).pop() ?? upstreamName)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
  if (!Object.hasOwn(toolScopes[service], leaf)) return null;
  const profile = SERVICE_PROFILES[GOOGLE_WORKSPACE_SERVICES[service]];
  return { service, upstreamName, leaf, serverUrl: profile.serverUrl, appSlug: profile.appSlug,
    requiredScopes: toolScopes[service][leaf]!, write: profile.writeTools.some((tool) => tool === leaf) };
}

export function isGoogleWorkspaceToolGranted(name: string, scopes: readonly string[]): boolean {
  const target = googleWorkspaceToolTarget(name);
  return Boolean(target && target.requiredScopes.every((alternatives) => alternatives.some((scope) => scopes.includes(scope))));
}

export function isGoogleWorkspaceScopeGrant(scopes: readonly string[]): boolean {
  const allowed = GOOGLE_WORKSPACE_CONNECTOR_PROFILES["workspace.all"].scopes;
  return scopes.length > 0 && scopes.every((scope) => allowed.includes(scope));
}

export function googleWorkspaceServiceGranted(service: GoogleWorkspaceService, scopes: readonly string[]): boolean {
  return Object.keys(toolScopes[service]).some((name) => isGoogleWorkspaceToolGranted(googleWorkspaceToolName(service, name), scopes));
}

/** Requested scopes and connection-wide defaults are never evidence of consent. */
export function googleWorkspaceGrantedScopes(grant: { providerTenant?: unknown } | null): string[] {
  const tenant = grant?.providerTenant as { oauth?: { scopes?: unknown; scopeSource?: unknown } } | undefined;
  const oauth = tenant?.oauth;
  if (oauth?.scopeSource === "requested_fallback" || !Array.isArray(oauth?.scopes)) return [];
  return oauth.scopes.filter((scope): scope is string => typeof scope === "string");
}

export function isGoogleWorkspaceConnectorProfileId(value: string): value is GoogleWorkspaceConnectorProfileId {
  return Object.prototype.hasOwnProperty.call(GOOGLE_WORKSPACE_CONNECTOR_PROFILES, value);
}

function def(appSlug: string, serverUrl: string, scopes: readonly string[], writeTools: readonly string[] = []) {
  return { appSlug, serverUrl, scopes, writeTools };
}
