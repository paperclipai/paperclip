import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgyRuntimeMcpConfig } from "@paperclipai/adapter-agy-local/server";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-runtime-mcp-test-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareAgyRuntimeMcpConfig", () => {
  it("writes Paperclip servers using Antigravity's remote MCP schema and removes run tokens", async () => {
    const cwd = await makeWorkspace();
    const prepared = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "GitHub", url: "http://127.0.0.1:3100/api/mcp/runtime-tools", token: "run-token", connectionId: "conn-1" },
    ]);

    expect(prepared.serverNames).toEqual(["GitHub"]);
    const configPath = path.join(cwd, ".agents", "mcp_config.json");
    const active = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      mcpServers: Record<string, { serverUrl: string; headers: { Authorization: string } }>;
    };
    expect(active.mcpServers.GitHub).toEqual({
      serverUrl: "http://127.0.0.1:3100/api/mcp/runtime-tools",
      headers: { Authorization: "Bearer run-token" },
    });

    await prepared.cleanup();
    await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(cwd, ".agents", ".paperclip-mcp-config.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves user servers and adds a suffix on a name collision", async () => {
    const cwd = await makeWorkspace();
    const agentsDir = path.join(cwd, ".agents");
    await fs.mkdir(agentsDir);
    const configPath = path.join(agentsDir, "mcp_config.json");
    const userConfigText = '{\n  "mcpServers": {"GitHub":{"serverUrl":"https://user.example/mcp"},"local":{"command":"server"}},\n  "custom": true\n}\n';
    await fs.writeFile(configPath, userConfigText);

    const prepared = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "run-token", connectionId: "paperclip-connection" },
    ]);
    expect(prepared.serverNames).toEqual(["GitHub-paperclip-connection"]);
    await prepared.cleanup();

    expect(await fs.readFile(configPath, "utf8")).toBe(userConfigText);
  });

  it("injects selected skills only into the workspace and removes its links during cleanup", async () => {
    const cwd = await makeWorkspace();
    const sourceRoot = await makeWorkspace();
    const source = path.join(sourceRoot, "selected-skill");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "SKILL.md"), "skill contents");

    const prepared = await prepareAgyRuntimeMcpConfig(cwd, [], undefined, [
      { name: "selected-skill", source },
    ]);
    const skillLink = path.join(cwd, ".agents", "skills", "selected-skill");
    expect(await fs.realpath(skillLink)).toBe(await fs.realpath(source));
    expect(prepared.serverNames).toEqual([]);

    await prepared.cleanup();
    await expect(fs.lstat(skillLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(cwd, ".agents", ".paperclip-mcp-config.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores the original MCP config when selected skill staging fails", async () => {
    const cwd = await makeWorkspace();
    const agentsDir = path.join(cwd, ".agents");
    await fs.mkdir(agentsDir);
    const configPath = path.join(agentsDir, "mcp_config.json");
    const originalConfig = '{"mcpServers":{"local":{"command":"server"}}}\n';
    await fs.writeFile(configPath, originalConfig);

    await expect(
      prepareAgyRuntimeMcpConfig(
        cwd,
        [{ name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "run-token", connectionId: "github" }],
        undefined,
        [{ name: "missing-skill", source: path.join(cwd, "missing-skill") }],
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
    await expect(fs.access(path.join(agentsDir, ".paperclip-mcp-config.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes the injected MCP config when selected skill staging fails without an original config", async () => {
    const cwd = await makeWorkspace();
    const agentsDir = path.join(cwd, ".agents");
    const configPath = path.join(agentsDir, "mcp_config.json");

    await expect(
      prepareAgyRuntimeMcpConfig(
        cwd,
        [{ name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "run-token", connectionId: "github" }],
        undefined,
        [{ name: "missing-skill", source: path.join(cwd, "missing-skill") }],
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(agentsDir, ".paperclip-mcp-config.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32")(
    "restricts an existing config while a run token is present and restores its original mode",
    async () => {
      const cwd = await makeWorkspace();
      const agentsDir = path.join(cwd, ".agents");
      await fs.mkdir(agentsDir);
      const configPath = path.join(agentsDir, "mcp_config.json");
      const userConfigText = '{"mcpServers":{"local":{"command":"server"}}}\n';
      await fs.writeFile(configPath, userConfigText, { mode: 0o644 });
      await fs.chmod(configPath, 0o644);

      const prepared = await prepareAgyRuntimeMcpConfig(cwd, [
        { name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "secret-run-token", connectionId: "github" },
      ]);

      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(configPath, "utf8")).toContain("secret-run-token");
      await prepared.cleanup();

      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o644);
      expect(await fs.readFile(configPath, "utf8")).toBe(userConfigText);
    },
  );

  it("does not create configuration when there are no runtime servers", async () => {
    const cwd = await makeWorkspace();
    const prepared = await prepareAgyRuntimeMcpConfig(cwd, []);
    expect(prepared.serverNames).toEqual([]);
    await expect(fs.access(path.join(cwd, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
    await prepared.cleanup();
  });

  it("rejects a symlinked workspace MCP directory before writing the run token", async () => {
    const cwd = await makeWorkspace();
    const externalDir = await makeWorkspace();
    await fs.symlink(externalDir, path.join(cwd, ".agents"), "junction");

    await expect(
      prepareAgyRuntimeMcpConfig(cwd, [
        { name: "GitHub", url: "http://127.0.0.1:3100/runtime", token: "test-run-token", connectionId: "github" },
      ]),
    ).rejects.toThrow(/must be a real directory/);
    await expect(fs.access(path.join(externalDir, "mcp_config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for another run's config lease and proceeds after the first run cleans up", async () => {
    const cwd = await makeWorkspace();
    const first = await prepareAgyRuntimeMcpConfig(cwd, [
      { name: "First", url: "http://127.0.0.1:3100/first", token: "first-token", connectionId: "first" },
    ]);
    let secondSettled = false;
    const secondPromise = prepareAgyRuntimeMcpConfig(cwd, [
      { name: "Second", url: "http://127.0.0.1:3100/second", token: "second-token", connectionId: "second" },
    ]).then((prepared) => {
      secondSettled = true;
      return prepared;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondSettled).toBe(false);
    await first.cleanup();
    const second = await secondPromise;
    expect(second.serverNames).toEqual(["Second"]);
    await second.cleanup();
  });
});
