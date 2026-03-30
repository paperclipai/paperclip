import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareManagedCodexHome } from "./codex-home.js";

const tmpDirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareManagedCodexHome", () => {
  it("refreshes stale managed config and adds required context-mode approvals", async () => {
    const sharedHome = await makeTempDir("codex-shared-");
    const paperclipHome = await makeTempDir("paperclip-home-");
    const companyId = "company-123";
    const targetHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      companyId,
      "codex-home",
    );

    await fs.mkdir(targetHome, { recursive: true });
    await fs.writeFile(
      path.join(sharedHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        '[mcp_servers.context-mode]',
        `command = ${JSON.stringify(path.join(sharedHome, "bin", "context-mode-poc"))}`,
        "",
        "[mcp_servers.context-mode.tools.ctx_batch_execute]",
        'approval_mode = "approve"',
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(targetHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    await prepareManagedCodexHome(
      {
        ...process.env,
        CODEX_HOME: sharedHome,
        PAPERCLIP_HOME: paperclipHome,
        PAPERCLIP_INSTANCE_ID: "default",
      },
      async () => {},
      companyId,
    );

    const managedConfig = await fs.readFile(path.join(targetHome, "config.toml"), "utf8");
    expect(managedConfig).toContain("[mcp_servers.context-mode]");
    expect(managedConfig).toContain("[mcp_servers.context-mode.tools.ctx_batch_execute]");
    expect(managedConfig).toContain("[mcp_servers.context-mode.tools.ctx_execute]");
    expect(managedConfig).toContain("[mcp_servers.context-mode.tools.ctx_execute_file]");
    expect(managedConfig).toContain("[mcp_servers.context-mode.tools.ctx_search]");
    expect(managedConfig).toContain("[mcp_servers.context-mode.tools.ctx_fetch_and_index]");
    expect(managedConfig).toContain("[mcp_servers.context-mode.tools.ctx_index]");
    expect(managedConfig).toContain("[mcp_servers.context-mode.tools.ctx_stats]");
  });
});
