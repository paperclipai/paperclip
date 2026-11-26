import { describe, expect, it } from "vitest";
import { actionPermissionMutation } from "./action-permissions";
import { finishAppPermissions } from "./useConnectionPermissionSave";

describe("actionPermissionMutation", () => {
  const enabled = new Set(["a", "b", "c"]);
  const askFirst = new Set(["b"]);

  it("sets every action in a group at once", () => {
    expect(actionPermissionMutation(["a", "b", "c"], "ask", enabled, askFirst)).toEqual({
      enabled: new Set(["a", "b", "c"]),
      askFirst: new Set(["a", "b", "c"]),
    });
    expect(actionPermissionMutation(["a", "b", "c"], "off", enabled, askFirst)).toEqual({
      enabled: new Set(),
      askFirst: new Set(),
    });
    expect(actionPermissionMutation(["a", "b", "c"], "allowed", new Set(), askFirst)).toEqual({
      enabled: new Set(["a", "b", "c"]),
      askFirst: new Set(),
    });
  });

  it("leaves actions outside the group alone", () => {
    expect(actionPermissionMutation(["a"], "off", enabled, askFirst)).toEqual({
      enabled: new Set(["b", "c"]),
      askFirst: new Set(["b"]),
    });
  });
});

describe("finishAppPermissions", () => {
  it("never asks to turn on an action Google no longer offers or a disabled action", () => {
    const catalog = [
      { id: "get-message", status: "quarantined" as const },
      { id: "create-draft", status: "quarantined" as const },
      { id: "list-threads", status: "disabled" as const },
      { id: "search-messages", status: "disabled" as const },
      { id: "retired", status: "removed" as const },
    ];
    expect(finishAppPermissions({
      enabled: new Set(["get-message", "create-draft", "list-threads", "search-messages", "retired"]),
      askFirst: new Set(["create-draft", "list-threads"]),
      reviewed: new Set(["get-message", "create-draft"]),
      access: { mode: "all", agentIds: new Set() },
    }, catalog)).toEqual({
      enabledCatalogEntryIds: ["get-message", "create-draft"],
      askFirstCatalogEntryIds: ["create-draft"],
      reviewedCatalogEntryIds: ["get-message", "create-draft"],
      access: "all_agents",
    });
  });
});
