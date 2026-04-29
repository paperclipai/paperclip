import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodePluginTools } from "./plugin-tools.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

describe("prepareOpenCodePluginTools", () => {
  it("creates ephemeral OpenCode custom tool wrappers for Paperclip plugin tools", async () => {
    const prepared = await prepareOpenCodePluginTools({
      tools: [
        {
          name: "paperclip.example:search-issues",
          displayName: "Search Issues",
          description: "Search plugin issues",
          pluginId: "plugin-1",
          parametersSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              limit: { type: "integer" },
            },
            required: ["query"],
          },
        },
      ],
      env: {},
      runContext: {
        agentId: "agent-1",
        runId: "run-1",
        companyId: "company-1",
        projectId: "project-1",
      },
    });
    cleanupPaths.add(prepared.env.OPENCODE_CONFIG_DIR);

    expect(prepared.notes).toEqual([
      "Injected 1 Paperclip plugin tool wrapper(s) via OPENCODE_CONFIG_DIR.",
    ]);

    const toolFiles = await fs.readdir(`${prepared.env.OPENCODE_CONFIG_DIR}/tools`);
    expect(toolFiles).toHaveLength(1);

    const toolSource = await fs.readFile(
      `${prepared.env.OPENCODE_CONFIG_DIR}/tools/${toolFiles[0]}`,
      "utf8",
    );
    expect(toolSource).toContain('const TOOL_NAME = "paperclip.example:search-issues";');
    expect(toolSource).toContain('"projectId": "project-1"');
    expect(toolSource).toContain('Authorization: "Bearer " + apiKey');
    expect(toolSource).toContain('"query": tool.schema.string().describe("Search query")');
    expect(toolSource).toContain('"limit": tool.schema.number().int().optional()');

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.OPENCODE_CONFIG_DIR);
    await expect(fs.access(prepared.env.OPENCODE_CONFIG_DIR)).rejects.toThrow();
  });

  it("skips injection when the run is not project-scoped", async () => {
    const prepared = await prepareOpenCodePluginTools({
      tools: [
        {
          name: "paperclip.example:search-issues",
          displayName: "Search Issues",
          description: "Search plugin issues",
          pluginId: "plugin-1",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
      env: {},
      runContext: {
        agentId: "agent-1",
        runId: "run-1",
        companyId: "company-1",
        projectId: null,
      },
    });

    expect(prepared.env).toEqual({});
    expect(prepared.notes).toEqual([
      "Skipped Paperclip plugin tool injection because the run has no projectId scope.",
    ]);
    await prepared.cleanup();
  });
});
