import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertCursorWorkspacePolicy, CURSOR_FIXED_ARGUMENTS, cursorPrivateEnvironment } from "./cursor-launch-policy.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "cursor-policy-")); roots.push(root); await mkdir(join(root, "project")); await mkdir(join(root, ".git")); return root; }
it("uses fixed update/project config flags and memory-only credential storage", () => {
  expect(CURSOR_FIXED_ARGUMENTS).toEqual(["--disable-project-configs", "--disable-auto-update", "acp"]);
  expect(cursorPrivateEnvironment({ agentHomeDirectory: "/private/home", dataDirectory: "/private/data", cacheDirectory: "/private/cache" })).toEqual({ CURSOR_CONFIG_DIR: "/private/home", CURSOR_DATA_DIR: "/private/data", NODE_COMPILE_CACHE: "/private/cache/cursor-compile-cache", AGENT_CLI_CREDENTIAL_STORE: "memory", NO_OPEN_BROWSER: "1" });
});
it("rejects parent-root MCP/hooks and symlinked config, while leaving ordinary Claude settings alone", async () => {
  const root = await fixture(); const project = join(root, "project");
  await assertCursorWorkspacePolicy(project);
  await mkdir(join(root, ".claude")); await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ model: "x" }));
  await assertCursorWorkspacePolicy(project);
  await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
  await expect(assertCursorWorkspacePolicy(project)).rejects.toThrow("ambient execution configuration");
  await rm(join(root, ".claude"), { recursive: true }); await mkdir(join(root, ".cursor"));
  await writeFile(join(root, ".cursor", "mcp.json"), "{}");
  await expect(assertCursorWorkspacePolicy(project)).rejects.toThrow("mcp.json");
  await rm(join(root, ".cursor", "mcp.json")); await symlink("missing", join(root, ".cursor", "hooks.json"));
  await expect(assertCursorWorkspacePolicy(project)).rejects.toThrow("hooks.json");
});
