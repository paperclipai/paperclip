import { describe, it, expect } from "vitest";
import { buildPaperclipToolsCatalog } from "./tools-catalog.js";

const baseInput = {
  apiUrl: "http://127.0.0.1:3100/api",
  agentJwt: "test-jwt",
  companyId: "00000000-0000-0000-0000-000000000001",
  agentId: "00000000-0000-0000-0000-000000000002",
  runId: "00000000-0000-0000-0000-000000000003",
};

describe("buildPaperclipToolsCatalog", () => {
  it("includes the canonical Paperclip tools (paperclipMe, paperclipAddComment, paperclipUpdateIssue) by default", () => {
    const catalog = buildPaperclipToolsCatalog(baseInput);
    const names = new Set(catalog.zaiToolDefinitions.map((tool) => tool.function.name));
    expect(names.has("paperclipMe")).toBe(true);
    expect(names.has("paperclipAddComment")).toBe(true);
    expect(names.has("paperclipUpdateIssue")).toBe(true);
    expect(names.has("paperclipApiRequest")).toBe(true);
  });

  it("emits OpenAI-format tool definitions (type=function, function.name/description/parameters)", () => {
    const catalog = buildPaperclipToolsCatalog(baseInput);
    for (const tool of catalog.zaiToolDefinitions) {
      expect(tool.type).toBe("function");
      expect(typeof tool.function.name).toBe("string");
      expect(tool.function.name.length).toBeGreaterThan(0);
      expect(typeof tool.function.description).toBe("string");
      expect(typeof tool.function.parameters).toBe("object");
    }
  });

  it("strips $schema from generated parameters JSON Schema", () => {
    const catalog = buildPaperclipToolsCatalog(baseInput);
    for (const tool of catalog.zaiToolDefinitions) {
      const params = tool.function.parameters as Record<string, unknown>;
      expect(params.$schema).toBeUndefined();
    }
  });

  it("respects allowedToolNames filter", () => {
    const catalog = buildPaperclipToolsCatalog({
      ...baseInput,
      allowedToolNames: new Set(["paperclipAddComment", "paperclipUpdateIssue"]),
    });
    expect(catalog.zaiToolDefinitions).toHaveLength(2);
    expect(catalog.zaiToolDefinitions.map((t) => t.function.name).sort()).toEqual([
      "paperclipAddComment",
      "paperclipUpdateIssue",
    ]);
  });

  it("respects deniedToolNames filter (applied after allow)", () => {
    const catalog = buildPaperclipToolsCatalog({
      ...baseInput,
      deniedToolNames: new Set(["paperclipApiRequest"]),
    });
    const names = catalog.zaiToolDefinitions.map((t) => t.function.name);
    expect(names).not.toContain("paperclipApiRequest");
    expect(names).toContain("paperclipAddComment");
  });

  it("toolsByName lookup is in sync with zaiToolDefinitions", () => {
    const catalog = buildPaperclipToolsCatalog(baseInput);
    for (const tool of catalog.zaiToolDefinitions) {
      const looked = catalog.toolsByName.get(tool.function.name);
      expect(looked).toBeDefined();
      expect(looked?.name).toBe(tool.function.name);
    }
    expect(catalog.toolsByName.size).toBe(catalog.zaiToolDefinitions.length);
  });
});
