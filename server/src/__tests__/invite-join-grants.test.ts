import { describe, expect, it } from "vitest";
import {
  agentJoinGrantsFromDefaults,
  humanJoinGrantsFromDefaults,
} from "../services/invite-grants.js";
import {
  grantsForHumanRole,
  normalizeHumanRole,
  resolveHumanInviteRole,
} from "../services/company-member-roles.js";

describe("agentJoinGrantsFromDefaults", () => {
  it("adds tasks:assign when invite defaults do not specify agent grants", () => {
    expect(agentJoinGrantsFromDefaults(null)).toEqual([
      {
        permissionKey: "tasks:assign",
        scope: null,
      },
    ]);
  });

  it("preserves invite agent grants and appends tasks:assign", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "agents:create",
              scope: null,
            },
          ],
        },
      }),
    ).toEqual([
      {
        permissionKey: "agents:create",
        scope: null,
      },
      {
        permissionKey: "tasks:assign",
        scope: null,
      },
    ]);
  });

  it("does not duplicate tasks:assign when invite defaults already include it", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "tasks:assign",
              scope: { projectId: "project-1" },
            },
          ],
        },
      }),
    ).toEqual([
      {
        permissionKey: "tasks:assign",
        scope: { projectId: "project-1" },
      },
    ]);
  });
});

describe("human invite roles", () => {
  it("maps owner to the full management grant set", () => {
    expect(grantsForHumanRole("owner")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "users:manage_permissions", scope: null },
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "joins:approve", scope: null },
    ]);
  });

  it("defaults legacy or missing roles to operator", () => {
    expect(normalizeHumanRole("member")).toBe("operator");
    expect(resolveHumanInviteRole(null)).toBe("operator");
  });

  it("reads the configured human invite role from defaults", () => {
    expect(
      resolveHumanInviteRole({
        human: {
          role: "viewer",
        },
      }),
    ).toBe("viewer");
  });

  it("falls back to role grants when human invite defaults omit explicit grants", () => {
    expect(humanJoinGrantsFromDefaults(null, "operator")).toEqual([
      { permissionKey: "tasks:assign", scope: null },
    ]);
  });

  it("preserves explicit human invite grants", () => {
    expect(
      humanJoinGrantsFromDefaults(
        {
          human: {
            grants: [
              {
                permissionKey: "users:invite",
                scope: { companyId: "company-1" },
              },
            ],
          },
        },
        "operator",
      ),
    ).toEqual([
      {
        permissionKey: "users:invite",
        scope: { companyId: "company-1" },
      },
    ]);
  });
});
