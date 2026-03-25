import { describe, expect, it } from "vitest";
import { agentJoinGrantsFromDefaults } from "../routes/access.js";

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
