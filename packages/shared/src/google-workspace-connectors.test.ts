import { describe, expect, it } from "vitest";
import { getConnectableAppDefinition } from "./app-definitions.js";
import {
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES as profiles, GOOGLE_WORKSPACE_SERVICES,
  googleWorkspaceGrantedScopes, googleWorkspaceToolTarget, isGoogleWorkspaceToolGranted,
  googleWorkspaceServiceGranted, isGoogleWorkspaceScopeGrant,
  googleWorkspaceSelectedScopes, googleWorkspaceEffectiveScopes, GOOGLE_WORKSPACE_DEFAULT_SELECTION,
  googleWorkspaceDraftRequestedScopes, GOOGLE_WORKSPACE_SERVICE_GROUPS, GOOGLE_WORKSPACE_SUBMITTED_SCOPES,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS, googleWorkspaceProfileWithinSubmittedScopes,
  GOOGLE_WORKSPACE_TOOL_TRANSPORT, googleWorkspaceServiceToolNames, googleWorkspaceSelectionForScopes,
  googleWorkspaceToolTitle, type GoogleWorkspaceServiceSelection,
} from "./google-workspace-connectors.js";

describe("googleWorkspaceToolTitle", () => {
  it("names a Google tool by service and action, never by its internal name", () => {
    expect(googleWorkspaceToolTitle("gmail__get_message")).toBe("Gmail: Get message");
    expect(googleWorkspaceToolTitle("gmail__get_message", "Read a message")).toBe("Gmail: Read a message");
    expect(googleWorkspaceToolTitle("calendar__list_events", "Calendar: List events")).toBe("Calendar: List events");
    expect(googleWorkspaceToolTitle("search__search_corpus")).toBe("Workspace search: Search corpus");
  });

  it("returns the given title for anything that is not an allowlisted Google tool", () => {
    expect(googleWorkspaceToolTitle("gmail__send_message")).toBeNull();
    expect(googleWorkspaceToolTitle("create_issue", " Create issue ")).toBe("Create issue");
  });
});

const scope = (value: string) => `https://www.googleapis.com/auth/${value}`;

describe("combined Google Workspace consent", () => {
  it("restores draft intent only for its exact identity and current service scopes", () => {
    const binding = { companyId: "company", connectionId: "connection", actorType: "user", actorId: "owner",
      grantKind: "user" as const, subjectId: "owner" };
    const draft = { version: 1, ...binding, requestedScopes: [scope("gmail.readonly")] };
    expect(googleWorkspaceDraftRequestedScopes(draft, binding)).toEqual([scope("gmail.readonly")]);
    for (const field of ["companyId", "connectionId", "actorType", "actorId", "grantKind", "subjectId"] as const) {
      expect(googleWorkspaceDraftRequestedScopes({ ...draft, [field]: "different" }, binding)).toBeNull();
    }
    for (const requestedScopes of [[], [scope("chat.messages.readonly")], [scope("contacts.readonly")], [scope("gmail.send")], "gmail.readonly"]) {
      expect(googleWorkspaceDraftRequestedScopes({ ...draft, requestedScopes }, binding)).toBeNull();
    }
    expect(googleWorkspaceDraftRequestedScopes(undefined, binding)).toBeNull();
  });

  it("defaults to Gmail, combined Drive, and Calendar write scopes without Chat or People", () => {
    const selected = googleWorkspaceSelectedScopes(GOOGLE_WORKSPACE_DEFAULT_SELECTION);
    expect(selected).toHaveLength(10);
    expect(googleWorkspaceSelectedScopes({ gmail: "read", drive: "read", calendar: "read" })).toHaveLength(8);
    expect(selected).toContain(scope("gmail.compose"));
    expect(selected.some(value => /chat|contacts|directory|userinfo/.test(value))).toBe(false);
    expect(googleWorkspaceSelectedScopes({})).toEqual([]);
    expect(googleWorkspaceSelectedScopes({ drive: "read" })).toEqual([
      scope("documents.readonly"), scope("drive.readonly"), scope("presentations.readonly"), scope("spreadsheets.readonly"),
    ]);
  });

  it("caps cumulative Google grants to the selected access on callback and refresh", () => {
    const effective = googleWorkspaceEffectiveScopes([scope("documents.readonly")], [scope("documents"), scope("gmail.compose")]);
    expect(effective).toEqual([scope("documents.readonly")]);
    expect(isGoogleWorkspaceToolGranted("docs__update_doc", effective)).toBe(false);
    expect(isGoogleWorkspaceToolGranted("docs__read_doc", effective)).toBe(true);
    expect(googleWorkspaceEffectiveScopes([scope("documents")], [scope("documents.readonly")])).toEqual([scope("documents.readonly")]);
  });
  it("requests the free/busy permission with read and write Calendar access", () => {
    expect(googleWorkspaceSelectedScopes({ calendar: "read" })).toEqual([
      scope("calendar.calendarlist.readonly"), scope("calendar.events.freebusy"), scope("calendar.events.readonly"),
    ]);
    expect(googleWorkspaceSelectedScopes({ calendar: "write" })).toEqual([
      scope("calendar.calendarlist.readonly"), scope("calendar.events"), scope("calendar.events.freebusy"),
    ]);
    expect([...profiles["calendar.write"].scopes]).toEqual([scope("calendar.calendarlist.readonly"), scope("calendar.events")]);
  });

  it("keeps Calendar read and write access for grants made before and after free/busy was requested", () => {
    const before = [scope("calendar.calendarlist.readonly"), scope("calendar.events")];
    const after = googleWorkspaceSelectedScopes({ calendar: "write" });
    for (const [requested, granted] of [[before, before], [after, after], [after, before]]) {
      const effective = googleWorkspaceEffectiveScopes(requested!, granted!);
      expect(effective).toEqual(granted);
      expect(googleWorkspaceSelectionForScopes(effective)).toEqual({ calendar: "write" });
      for (const tool of ["list_calendars", "list_events", "suggest_time", "create_event", "delete_event"]) {
        expect(isGoogleWorkspaceToolGranted(`calendar__${tool}`, effective), tool).toBe(true);
      }
    }
    expect(googleWorkspaceSelectionForScopes(googleWorkspaceSelectedScopes({ calendar: "read" }))).toEqual({ calendar: "read" });
  });

  it("does not record a free/busy permission that Google did not grant", () => {
    const write = googleWorkspaceSelectedScopes({ calendar: "write" });
    expect(googleWorkspaceEffectiveScopes(write, [scope("calendar.events")])).toEqual([scope("calendar.events")]);
    expect(googleWorkspaceEffectiveScopes(googleWorkspaceSelectedScopes({ calendar: "read" }), [scope("calendar.events")]))
      .toEqual([scope("calendar.events.readonly")]);
    expect(googleWorkspaceEffectiveScopes([scope("calendar.events")], write)).toEqual([scope("calendar.events")]);
  });

  it("limits every selectable service combination to the 14 scopes submitted for Google verification", () => {
    const submitted = [
      "gmail.readonly", "gmail.compose",
      "drive.readonly", "drive.file",
      "documents.readonly", "documents",
      "spreadsheets.readonly", "spreadsheets",
      "presentations.readonly", "presentations",
      "calendar.calendarlist.readonly", "calendar.events.readonly", "calendar.events.freebusy", "calendar.events",
    ].map(scope);
    expect([...GOOGLE_WORKSPACE_SUBMITTED_SCOPES].sort()).toEqual([...submitted].sort());
    let selections: GoogleWorkspaceServiceSelection[] = [{}];
    for (const group of GOOGLE_WORKSPACE_SERVICE_GROUPS) {
      selections = selections.flatMap((selection) => [selection, { ...selection, [group.id]: "read" }, { ...selection, [group.id]: "write" }]);
    }
    expect(selections).toHaveLength(27);
    const union = new Set<string>();
    for (const selection of selections) {
      const selected = googleWorkspaceSelectedScopes(selection);
      for (const value of selected) expect(submitted, JSON.stringify(selection)).toContain(value);
      selected.forEach((value) => union.add(value));
    }
    expect([...union].sort()).toEqual([...submitted].sort());
    expect([...profiles["workspace.all"].scopes].sort()).toEqual([...submitted].sort());
    const app = getConnectableAppDefinition("google-workspace")!;
    expect(app.methods).toHaveLength(2);
    expect(app.methods.filter((method) => method.connectorProfile)).toHaveLength(1);
    for (const method of app.methods) expect([...method.defaults!.scopesHint!].sort()).toEqual([...submitted].sort());
    for (const profile of Object.values(GOOGLE_WORKSPACE_SERVICES)) expect(getConnectableAppDefinition(profiles[profile].appSlug)).not.toBeNull();
  });

  it("marks only profiles inside the submitted scopes as usable with Paperclip's Google client", () => {
    const outside = GOOGLE_WORKSPACE_CONNECTOR_PROFILE_IDS.filter((profile) => !googleWorkspaceProfileWithinSubmittedScopes(profile));
    expect(outside).toEqual(["gmail.archive", "chat.read", "chat.write", "people.read", "workspace-search.read"]);
  });

  it("accepts a nonempty subset but not missing or unrequested permissions", () => {
    expect(isGoogleWorkspaceScopeGrant([scope("documents")])).toBe(true);
    expect(isGoogleWorkspaceScopeGrant(GOOGLE_WORKSPACE_SUBMITTED_SCOPES)).toBe(true);
    expect(isGoogleWorkspaceScopeGrant([])).toBe(false);
    expect(isGoogleWorkspaceScopeGrant([scope("chat.memberships.readonly")])).toBe(false);
    expect(isGoogleWorkspaceScopeGrant([scope("gmail.send")])).toBe(false);
    for (const legacy of ["chat.spaces.readonly", "chat.messages.readonly", "chat.messages.create", "directory.readonly",
      "userinfo.profile", "contacts.readonly", "calendar.readonly", "gmail.modify"]) {
      expect(isGoogleWorkspaceScopeGrant([scope("documents"), scope(legacy)]), legacy).toBe(false);
    }
  });

  it("declining Gmail leaves Drive available without enabling Gmail or Docs", () => {
    const granted = [scope("drive.readonly")];
    expect(isGoogleWorkspaceToolGranted("drive__search_files", granted)).toBe(true);
    expect(isGoogleWorkspaceToolGranted("drive__create_file", granted)).toBe(false);
    expect(isGoogleWorkspaceToolGranted("gmail__get_message", granted)).toBe(false);
    expect(isGoogleWorkspaceToolGranted("docs__read_doc", granted)).toBe(false);
    expect(googleWorkspaceServiceGranted("gmail", granted)).toBe(false);
    expect(googleWorkspaceServiceGranted("drive", granted)).toBe(true);
    expect(isGoogleWorkspaceToolGranted("search__search_corpus", granted)).toBe(false);
  });

  it("allows read-only grants and write grants for the corresponding editors", () => {
    for (const [service, permission, read, write] of [
      ["docs", "documents", "read_doc", "update_doc"],
      ["sheets", "spreadsheets", "get_values", "update_values"],
      ["slides", "presentations", "read_presentation", "update_presentation"],
    ]) {
      expect(isGoogleWorkspaceToolGranted(`${service}__${read}`, [scope(`${permission}.readonly`)])).toBe(true);
      expect(isGoogleWorkspaceToolGranted(`${service}__${write}`, [scope(`${permission}.readonly`)])).toBe(false);
      expect(isGoogleWorkspaceToolGranted(`${service}__${read}`, [scope(permission!)])).toBe(true);
      expect(isGoogleWorkspaceToolGranted(`${service}__${write}`, [scope(permission!)])).toBe(true);
    }
  });

  it("routes colliding tool names to closed endpoints and rejects unknown actions", () => {
    expect(googleWorkspaceToolTarget("gmail__search_messages")?.serverUrl).toContain("gmailmcp.googleapis.com");
    expect(googleWorkspaceToolTarget("chat__search_messages")?.serverUrl).toContain("chatmcp.googleapis.com");
    for (const name of ["gmail__send_message", "chat__list_members", "docs__delete_doc", "evil__get_message", "__proto____get_message", "gmail__constructor"])
      expect(googleWorkspaceToolTarget(name)).toBeNull();
    expect(isGoogleWorkspaceToolGranted("gmail__send_message", profiles["workspace.all"].scopes)).toBe(false);
  });

  it("runs every service on Google's MCP servers, as the AI Tools Addendum requires, and reports the transport on each target", () => {
    expect(Object.keys(GOOGLE_WORKSPACE_TOOL_TRANSPORT).sort()).toEqual(Object.keys(GOOGLE_WORKSPACE_SERVICES).sort());
    expect(GOOGLE_WORKSPACE_TOOL_TRANSPORT).toEqual({
      gmail: "google_mcp", drive: "google_mcp", docs: "google_mcp", sheets: "google_mcp",
      slides: "google_mcp", calendar: "google_mcp", chat: "google_mcp", people: "google_mcp", search: "google_mcp",
    });
    expect(googleWorkspaceToolTarget("gmail__get_message")?.transport).toBe("google_mcp");
    expect(googleWorkspaceToolTarget("chat__list_messages")?.transport).toBe("google_mcp");
    expect(googleWorkspaceServiceToolNames("docs")).toEqual(["read_doc", "update_doc"]);
  });

  it("never substitutes requested scopes for actual consent", () => {
    expect(googleWorkspaceGrantedScopes(null)).toEqual([]);
    expect(googleWorkspaceGrantedScopes({ providerTenant: { oauth: { scopes: [scope("documents")], scopeSource: "requested_fallback" } } })).toEqual([]);
    expect(googleWorkspaceGrantedScopes({ providerTenant: { oauth: { scopes: [scope("documents")], scopeSource: "provider" } } })).toEqual([scope("documents")]);
  });
});
