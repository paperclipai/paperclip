export const GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS = [
  "gmail.read", "gmail.draft", "drive.read", "drive.write", "docs.read", "docs.write",
  "sheets.read", "sheets.write", "slides.read", "slides.write", "calendar.read",
  "calendar.write", "chat.read", "chat.write", "people.read", "workspace-search.read",
] as const;

export type GoogleWorkspaceConnectorProfileId = (typeof GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS)[number];

const auth = (scope: string) => `https://www.googleapis.com/auth/${scope}`;

export const GOOGLE_WORKSPACE_CONNECTOR_PROFILES: Readonly<Record<GoogleWorkspaceConnectorProfileId, {
  appSlug: string;
  serverUrl: string;
  scopes: readonly string[];
  writeTools: readonly string[];
}>> = {
  "gmail.read": def("gmail", "https://gmailmcp.googleapis.com/mcp/v1", [auth("gmail.readonly")]),
  "gmail.draft": def("gmail", "https://gmailmcp.googleapis.com/mcp/v1", [auth("gmail.readonly"), auth("gmail.compose")], ["create_draft"]),
  "drive.read": def("google-drive", "https://drivemcp.googleapis.com/mcp/v1", [auth("drive.readonly")]),
  "drive.write": def("google-drive", "https://drivemcp.googleapis.com/mcp/v1", [auth("drive.readonly"), auth("drive.file")], ["copy_file", "create_file"]),
  "docs.read": def("google-docs", "https://docsmcp.googleapis.com/mcp/v1", [auth("drive.readonly"), auth("documents.readonly")]),
  "docs.write": def("google-docs", "https://docsmcp.googleapis.com/mcp/v1", [auth("drive.readonly"), auth("drive.file"), auth("documents")], ["update_doc"]),
  "sheets.read": def("google-sheets", "https://sheetsmcp.googleapis.com/mcp/v1", [auth("drive.readonly"), auth("spreadsheets.readonly")]),
  "sheets.write": def("google-sheets", "https://sheetsmcp.googleapis.com/mcp/v1", [auth("drive.readonly"), auth("drive.file"), auth("spreadsheets")], ["update_spreadsheet", "update_values", "update_formulas", "insert_dimension"]),
  "slides.read": def("google-slides", "https://slidesmcp.googleapis.com/mcp/v1", [auth("drive.readonly"), auth("presentations.readonly")]),
  "slides.write": def("google-slides", "https://slidesmcp.googleapis.com/mcp/v1", [auth("drive.readonly"), auth("drive.file"), auth("presentations")], ["update_presentation"]),
  "calendar.read": def("google-calendar", "https://calendarmcp.googleapis.com/mcp/v1", [auth("calendar.calendarlist.readonly"), auth("calendar.events.freebusy"), auth("calendar.events.readonly")]),
  "calendar.write": def("google-calendar", "https://calendarmcp.googleapis.com/mcp/v1", [auth("calendar.calendarlist.readonly"), auth("calendar.events.freebusy"), auth("calendar.events")], ["create_event", "update_event", "delete_event", "respond_to_event"]),
  "chat.read": def("google-chat", "https://chatmcp.googleapis.com/mcp/v1", [auth("chat.spaces.readonly"), auth("chat.memberships.readonly"), auth("chat.messages.readonly"), auth("chat.users.readstate.readonly")]),
  "chat.write": def("google-chat", "https://chatmcp.googleapis.com/mcp/v1", [auth("chat.spaces.readonly"), auth("chat.memberships.readonly"), auth("chat.messages.readonly"), auth("chat.users.readstate.readonly"), auth("chat.messages.create")], ["send_message"]),
  "people.read": def("google-people", "https://people.googleapis.com/mcp/v1", [auth("directory.readonly"), auth("userinfo.profile"), auth("contacts.readonly")]),
  "workspace-search.read": def("google-workspace-search", "https://workspacemcp.googleapis.com/mcp/v1", [auth("gmail.readonly"), auth("drive.readonly"), auth("calendar.readonly"), auth("chat.messages.readonly")]),
};

export function isGoogleWorkspaceConnectorProfileId(value: string): value is GoogleWorkspaceConnectorProfileId {
  return Object.prototype.hasOwnProperty.call(GOOGLE_WORKSPACE_CONNECTOR_PROFILES, value);
}

function def(appSlug: string, serverUrl: string, scopes: readonly string[], writeTools: readonly string[] = []) {
  return { appSlug, serverUrl, scopes, writeTools };
}
