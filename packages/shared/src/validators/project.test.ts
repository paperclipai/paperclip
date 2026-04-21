import { describe, expect, it } from "vitest";
import { createProjectSchema, updateProjectSchema } from "./project.js";

describe("project validators", () => {
  it("normalizes project codes on create and update", () => {
    expect(createProjectSchema.parse({ name: "Platform", code: " pap42 " }).code).toBe("PAP42");
    expect(updateProjectSchema.parse({ code: "ops7" }).code).toBe("OPS7");
  });

  it("clears blank project codes", () => {
    expect(createProjectSchema.parse({ name: "Platform", code: "" }).code).toBeNull();
    expect(updateProjectSchema.parse({ code: "   " }).code).toBeNull();
    expect(updateProjectSchema.parse({ code: null }).code).toBeNull();
  });

  it("rejects unsupported project code characters", () => {
    expect(() => createProjectSchema.parse({ name: "Platform", code: "pap-42" })).toThrow(/A-Z and 0-9/);
  });
});
