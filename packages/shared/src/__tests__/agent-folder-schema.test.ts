import { describe, expect, it } from "vitest";
import { createAgentSchema, updateAgentSchema } from "../validators/agent.js";

describe("agent folderId schema (Phase 3 / JAC-4752)", () => {
  it("createAgentSchema accepts folderId as a valid UUID", () => {
    const result = createAgentSchema.safeParse({
      name: "TestAgent",
      adapterType: "hermes_local",
      folderId: "123e4567-e89b-12d3-a456-426614174002",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.folderId).toBe("123e4567-e89b-12d3-a456-426614174002");
    }
  });

  it("createAgentSchema rejects invalid folderId", () => {
    const result = createAgentSchema.safeParse({
      name: "TestAgent",
      adapterType: "hermes_local",
      folderId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("createAgentSchema allows folderId to be null", () => {
    const result = createAgentSchema.safeParse({
      name: "TestAgent",
      adapterType: "hermes_local",
      folderId: null,
    });
    expect(result.success).toBe(true);
  });

  it("createAgentSchema allows folderId to be omitted", () => {
    const result = createAgentSchema.safeParse({
      name: "TestAgent",
      adapterType: "hermes_local",
    });
    expect(result.success).toBe(true);
  });

  it("updateAgentSchema accepts folderId for moving agents between folders", () => {
    const result = updateAgentSchema.safeParse({
      folderId: "123e4567-e89b-12d3-a456-426614174003",
    });
    expect(result.success).toBe(true);
  });

  it("updateAgentSchema accepts folderId as null to unassign", () => {
    const result = updateAgentSchema.safeParse({
      folderId: null,
    });
    expect(result.success).toBe(true);
  });

  it("createAgentHireSchema inherits folderId", async () => {
    const { createAgentHireSchema } = await import("../validators/agent.js");
    const result = createAgentHireSchema.safeParse({
      name: "HireAgent",
      adapterType: "hermes_local",
      folderId: "123e4567-e89b-12d3-a456-426614174004",
    });
    expect(result.success).toBe(true);
  });
});
