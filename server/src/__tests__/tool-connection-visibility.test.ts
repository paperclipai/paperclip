import { describe, expect, it } from "vitest";
import { filterVisibleToolConnections } from "../routes/tool-access.js";

const connections = [
  { id: "other-draft", status: "draft", createdByUserId: "other-user" },
  { id: "own-draft", status: "draft", createdByUserId: "member-user" },
  { id: "active", status: "active", createdByUserId: "other-user" },
];

describe("tool connection visibility", () => {
  it("keeps foreign drafts out of a regular member's reusable connection candidates", () => {
    expect(filterVisibleToolConnections(connections, {
      userId: "member-user",
      canManageConnections: false,
    })).toEqual([
      connections[1],
      connections[2],
    ]);
  });

  it("keeps every draft visible to a connection manager", () => {
    expect(filterVisibleToolConnections(connections, {
      userId: "owner-user",
      canManageConnections: true,
    })).toEqual(connections);
  });
});
