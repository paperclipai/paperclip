import { describe, expect, it } from "vitest";
import { getConnectableAppDefinition } from "./app-definitions.js";
import {
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES as profiles, GOOGLE_WORKSPACE_SERVICES,
  googleWorkspaceGrantedScopes, googleWorkspaceToolTarget, isGoogleWorkspaceToolGranted,
  googleWorkspaceServiceGranted, isGoogleWorkspaceScopeGrant,
} from "./google-workspace-connectors.js";

const scope = (value: string) => `https://www.googleapis.com/auth/${value}`;

describe("combined Google Workspace consent", () => {
  it("requests the existing union with one profile and preserves legacy definitions", () => {
    const expected = [...new Set(Object.entries(profiles).filter(([key]) => key !== "workspace.all").flatMap(([, value]) => value.scopes))];
    expect(profiles["workspace.all"].scopes).toEqual(expected);
    expect(expected).toHaveLength(21);
    const app = getConnectableAppDefinition("google-workspace")!;
    expect(app.methods).toHaveLength(2);
    expect(app.methods.filter((method) => method.connectorProfile)).toHaveLength(1);
    for (const method of app.methods) expect(method.defaults?.scopesHint).toEqual(expected);
    for (const profile of Object.values(GOOGLE_WORKSPACE_SERVICES)) expect(getConnectableAppDefinition(profiles[profile].appSlug)).not.toBeNull();
  });

  it("accepts a nonempty subset but not missing or unrequested permissions", () => {
    expect(isGoogleWorkspaceScopeGrant([scope("documents")])).toBe(true);
    expect(isGoogleWorkspaceScopeGrant([])).toBe(false);
    expect(isGoogleWorkspaceScopeGrant([scope("chat.memberships.readonly")])).toBe(false);
    expect(isGoogleWorkspaceScopeGrant([scope("gmail.send")])).toBe(false);
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

  it("never substitutes requested scopes for actual consent", () => {
    expect(googleWorkspaceGrantedScopes(null)).toEqual([]);
    expect(googleWorkspaceGrantedScopes({ providerTenant: { oauth: { scopes: [scope("documents")], scopeSource: "requested_fallback" } } })).toEqual([]);
    expect(googleWorkspaceGrantedScopes({ providerTenant: { oauth: { scopes: [scope("documents")], scopeSource: "provider" } } })).toEqual([scope("documents")]);
  });
});
