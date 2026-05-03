import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareManagedCodexHome, resolveManagedCodexHomeDir } from "./codex-home.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("prepareManagedCodexHome", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }),
    );
  });

  it("adds missing MCP server sections from shared config.toml into existing managed config", async () => {
    const paperclipHome = await makeTempDir("paperclip-home-");
    const sourceHome = await makeTempDir("codex-home-source-");
    createdDirs.push(paperclipHome, sourceHome);

    await fs.writeFile(
      path.join(sourceHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        '[mcp_servers.kinetica_rag]',
        'url = "http://127.0.0.1:8765/sse"',
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: sourceHome,
    };
    const targetHome = resolveManagedCodexHomeDir(env, "company-1");
    await fs.mkdir(targetHome, { recursive: true });
    await fs.writeFile(
      path.join(targetHome, "config.toml"),
      ['model = "gpt-5.4"', "", "[projects.'c:/repo']", 'trust_level = "trusted"'].join("\n"),
      "utf8",
    );

    const logs: string[] = [];
    await prepareManagedCodexHome(
      env,
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      "company-1",
    );

    const mergedToml = await fs.readFile(path.join(targetHome, "config.toml"), "utf8");
    expect(mergedToml).toContain("[projects.'c:/repo']");
    expect(mergedToml).toContain("[mcp_servers.kinetica_rag]");
    expect(logs.join("")).toContain("Synced missing Codex MCP server blocks");
  });

  it("normalizes Notion update-page requirements and adds query-data-sources alias in cached app tools", async () => {
    const paperclipHome = await makeTempDir("paperclip-home-");
    const sourceHome = await makeTempDir("codex-home-source-");
    createdDirs.push(paperclipHome, sourceHome);

    await fs.writeFile(path.join(sourceHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: sourceHome,
    };
    const targetHome = resolveManagedCodexHomeDir(env, "company-1");
    const cacheDir = path.join(targetHome, "cache", "codex_apps_tools");
    await fs.mkdir(cacheDir, { recursive: true });

    const cacheFile = path.join(cacheDir, "tools.json");
    const cacheFixture = {
      schema_version: 2,
      tools: [
        {
          server_name: "codex_apps",
          tool_name: "_notion_update_page",
          tool_namespace: "mcp__codex_apps__notion",
          tool: {
            inputSchema: {
              type: "object",
              properties: {
                page_id: { type: "string" },
                command: {
                  type: "string",
                  enum: [
                    "update_properties",
                    "update_content",
                    "replace_content",
                    "apply_template",
                    "update_verification",
                  ],
                },
                properties: { type: "object" },
                content_updates: { type: "array" },
                new_str: { type: "string" },
                template_id: { type: "string" },
                verification_status: { type: "string" },
              },
              required: ["page_id", "command", "properties", "content_updates"],
            },
          },
        },
        {
          server_name: "codex_apps",
          tool_name: "_notion_query_data_sources",
          tool_namespace: "mcp__codex_apps__notion",
          tool: {
            inputSchema: {
              type: "object",
              properties: {
                data: { type: "object" },
              },
              required: ["data"],
            },
          },
        },
      ],
    };
    await fs.writeFile(cacheFile, `${JSON.stringify(cacheFixture, null, 2)}\n`, "utf8");

    const logs: string[] = [];
    await prepareManagedCodexHome(
      env,
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      "company-1",
    );

    const updated = JSON.parse(await fs.readFile(cacheFile, "utf8")) as {
      tools: Array<{ tool_name: string; tool_namespace: string; tool: { inputSchema: Record<string, unknown> } }>;
    };

    const updatePage = updated.tools.find((entry) => entry.tool_name === "_notion_update_page");
    expect(updatePage).toBeDefined();

    const updateSchema = updatePage?.tool.inputSchema ?? {};
    expect(updateSchema.required).toEqual(["page_id", "command"]);
    const allOf = Array.isArray(updateSchema.allOf) ? updateSchema.allOf : [];
    expect(allOf).toHaveLength(5);
    expect(JSON.stringify(allOf)).toContain("\"update_properties\"");
    expect(JSON.stringify(allOf)).toContain("\"content_updates\"");
    expect(JSON.stringify(allOf)).toContain("\"verification_status\"");

    const queryAlias = updated.tools.find((entry) => entry.tool_name === "notion-query-data-sources");
    expect(queryAlias).toBeDefined();
    expect(queryAlias?.tool_namespace).toBe("mcp__codex_apps__notion");
    expect(logs.join("")).toContain("Normalized");
  });
});
