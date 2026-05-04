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
        "[mcp_servers.kinetica_rag]",
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
});
