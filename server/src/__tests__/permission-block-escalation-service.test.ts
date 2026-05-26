import { describe, expect, it } from "vitest";

import { detectPermissionBlockMarker } from "../services/permission-block-escalation.js";

describe("detectPermissionBlockMarker", () => {
  it("matches 'Missing permission: <key>' and extracts the key", () => {
    const match = detectPermissionBlockMarker("Missing permission: agents:create");
    expect(match).toEqual({
      trigger: "missing_permission",
      permissionKey: "agents:create",
      unblockOwnerRole: "ceo",
    });
  });

  it("matches the HUM-162 phrasing inside a multi-line blocked comment", () => {
    const body = [
      "Blocked. Cannot fire the hire payload.",
      "",
      "Missing permission: agents:create",
      "",
      "Unblock owner: CEO",
    ].join("\n");
    const match = detectPermissionBlockMarker(body);
    expect(match?.permissionKey).toBe("agents:create");
    expect(match?.unblockOwnerRole).toBe("ceo");
  });

  it("matches 'Unblock owner: CEO' when no permission key is present", () => {
    const match = detectPermissionBlockMarker("blocked. unblock owner: CEO. need a board lever.");
    expect(match).toEqual({
      trigger: "unblock_owner_role",
      permissionKey: null,
      unblockOwnerRole: "ceo",
    });
  });

  it("matches 'Unblock owner: Board' as ceo-target", () => {
    const match = detectPermissionBlockMarker("status: blocked\nunblock owner: Board");
    expect(match?.trigger).toBe("unblock_owner_role");
    expect(match?.unblockOwnerRole).toBe("ceo");
  });

  it("matches the 'requires board approval and CEO action' phrase", () => {
    const match = detectPermissionBlockMarker("This requires board approval and CEO action.");
    expect(match?.trigger).toBe("board_approval_phrase");
    expect(match?.unblockOwnerRole).toBe("ceo");
  });

  it("returns null for unrelated blocked comments", () => {
    expect(detectPermissionBlockMarker("Blocked on upstream API outage.")).toBeNull();
    expect(detectPermissionBlockMarker("waiting on the design review.")).toBeNull();
    expect(detectPermissionBlockMarker("")).toBeNull();
    expect(detectPermissionBlockMarker(null)).toBeNull();
    expect(detectPermissionBlockMarker(undefined)).toBeNull();
  });

  it("does not match permission keys outside the 'Missing permission' marker", () => {
    expect(detectPermissionBlockMarker("we use agents:create elsewhere but it's not blocked")).toBeNull();
  });
});
