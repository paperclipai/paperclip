import { describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/db", () => ({
  agentDepartments: {},
  agents: {},
  departments: {},
}));

import { orderedDepartmentNames } from "../services/departments.js";

describe("orderedDepartmentNames", () => {
  it("sorts folded names so concurrent creates lock in the same order", () => {
    expect(orderedDepartmentNames(["Zeta", "alpha", "Alpha"])).toEqual(["Alpha", "alpha", "Zeta"]);
    expect(orderedDepartmentNames(["Beta", "Alpha"])).toEqual(["Alpha", "Beta"]);
    expect(orderedDepartmentNames(["Alpha", "Beta"])).toEqual(["Alpha", "Beta"]);
  });
});
