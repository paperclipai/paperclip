import { describe, expect, it } from "vitest";
import { grantsFromDefaults } from "../routes/access.js";

describe("grantsFromDefaults", () => {
  it("adds tasks:assign for agents when invite defaults omit grants", () => {
    expect(grantsFromDefaults(null, "agent")).toEqual([
      { permissionKey: "tasks:assign", scope: null },
    ]);
  });

  it("preserves explicit agent grants without duplicating tasks:assign", () => {
    expect(
      grantsFromDefaults(
        {
          agent: {
            grants: [
              { permissionKey: "tasks:assign", scope: null },
              { permissionKey: "joins:approve", scope: { team: "ops" } },
            ],
          },
        },
        "agent",
      ),
    ).toEqual([
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "joins:approve", scope: { team: "ops" } },
    ]);
  });

  it("does not add tasks:assign defaults for human invite grants", () => {
    expect(grantsFromDefaults(null, "human")).toEqual([]);
  });
});
