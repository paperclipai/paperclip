import { describe, it, expect } from "vitest";
import { createToolRegistry } from "../tool-registry.js";

describe("createToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = createToolRegistry();
    const tool = {
      name: "test",
      displayName: "Test",
      description: "A test tool",
      parametersSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    };

    registry.register(tool);
    expect(registry.get("test")).toBe(tool);
    expect(registry.has("test")).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it("lists all tools", () => {
    const registry = createToolRegistry();
    registry.register({
      name: "a",
      displayName: "A",
      description: "Tool A",
      parametersSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "" }),
    });
    registry.register({
      name: "b",
      displayName: "B",
      description: "Tool B",
      parametersSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "" }),
    });

    const tools = registry.list();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("a");
    expect(tools.map((t) => t.name)).toContain("b");
  });

  it("unregisters a tool", () => {
    const registry = createToolRegistry();
    registry.register({
      name: "x",
      displayName: "X",
      description: "Tool X",
      parametersSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "" }),
    });

    registry.unregister("x");
    expect(registry.has("x")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("replaces a tool with the same name", () => {
    const registry = createToolRegistry();
    const first = {
      name: "dup",
      displayName: "First",
      description: "First",
      parametersSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "first" }),
    };
    const second = {
      name: "dup",
      displayName: "Second",
      description: "Second",
      parametersSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "second" }),
    };

    registry.register(first);
    registry.register(second);
    expect(registry.get("dup")).toBe(second);
  });
});
