import { describe, it, expect } from "vitest";
import { buildToolSchemas } from "../tool-schema.js";

describe("Tool Schema Generation", () => {
  it("should convert tools to OpenAI function format", () => {
    const tools = [
      {
        name: "search_files",
        description: "Search for files in the workspace",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            includePattern: { type: "string", description: "File pattern to include" },
          },
          required: ["query"],
        },
      },
    ];

    const schema = buildToolSchemas(tools);

    expect(schema).toHaveLength(1);
    expect(schema[0].type).toBe("function");
    expect(schema[0].function.name).toBe("search_files");
    expect(schema[0].function.parameters.type).toBe("object");
    expect(schema[0].function.parameters.required).toEqual(["query"]);
  });

  it("should compress tool descriptions", () => {
    const tools = [
      {
        name: "long_tool_name",
        description: "Use this tool to search the GitHub issues database for relevant information about bugs and features",
        parametersSchema: { type: "object", properties: {} },
      },
    ];

    const schema = buildToolSchemas(tools);

    // Description should be shorter
    expect(schema[0].function.description.length).toBeLessThan(50);
    expect(schema[0].function.description).toContain("search");
    expect(schema[0].function.description).toContain("GitHub");
  });

  it("should limit to 15 tools", () => {
    const tools = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      parametersSchema: { type: "object", properties: {} },
    }));

    const schema = buildToolSchemas(tools);

    expect(schema).toHaveLength(15);
  });
});