import { describe, expect, it } from "vitest";
import { acceptInviteSchema, createAgentSchema, updateAgentSchema } from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("accepts coo and normalizes the legacy operations alias", () => {
    expect(
      createAgentSchema.parse({
        name: "Chief Operating Officer",
        role: "coo",
        adapterType: "external_adapter",
      }).role,
    ).toBe("coo");

    expect(
      createAgentSchema.parse({
        name: "Operations Lead",
        role: "operations",
        adapterType: "external_adapter",
      }).role,
    ).toBe("coo");

    expect(
      updateAgentSchema.parse({
        role: "operations",
      }).role,
    ).toBe("coo");
  });

  it("accepts external adapter types in create/update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "External Agent",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");

    expect(
      updateAgentSchema.parse({
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("still rejects blank adapter types", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Blank Adapter",
        adapterType: "   ",
      }),
    ).toThrow();
  });

  it("accepts external adapter types in invite acceptance schema", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });
});
