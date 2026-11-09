import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { configureHermesRuntimeTools } from "./runtime-tools-config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("configureHermesRuntimeTools", () => {
  it("adds only the current runtime tool bundle to an isolated Hermes home", async () => {
    const profileHome = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-profile-"));
    roots.push(profileHome);
    const originalConfig = [
      "toolsets:",
      "  - terminal",
      "mcp_servers:",
      "  existing:",
      "    url: https://example.test/existing",
      "",
    ].join("\n");
    await fs.writeFile(path.join(profileHome, "config.yaml"), originalConfig, { mode: 0o600 });
    await fs.writeFile(path.join(profileHome, ".env"), "PROFILE_KEY=not-read-by-test\n", { mode: 0o600 });

    const configured = await configureHermesRuntimeTools(profileHome, {
      mcpEndpoint: "https://paperclip.test/api/mcp/runtime-tools",
      bearerToken: "runtime-token-not-persisted",
      tools: ["connections_search", "connection_request"],
    });
    expect(configured).toBeDefined();
    roots.push(configured!.homeDir);

    const merged = parse(await fs.readFile(path.join(configured!.homeDir, "config.yaml"), "utf8")) as Record<string, any>;
    const runtimeServer = merged.mcp_servers[configured!.toolset.slice("mcp-".length)];
    expect(runtimeServer.url).toBe("https://paperclip.test/api/mcp/runtime-tools");
    expect(runtimeServer.headers.Authorization).toBe("Bearer ${PAPERCLIP_RUNTIME_TOOLS_TOKEN}");
    expect(runtimeServer.tools.include).toEqual(["connections_search", "connection_request"]);
    expect(merged.toolsets).toContain("terminal");
    expect(merged.toolsets).toContain(configured!.toolset);
    expect(merged.mcp_servers.existing.url).toBe("https://example.test/existing");
    expect(await fs.readFile(path.join(profileHome, "config.yaml"), "utf8")).toBe(originalConfig);
    await expect(fs.realpath(path.join(configured!.homeDir, ".env"))).resolves.toBe(path.join(profileHome, ".env"));
    expect(await fs.stat(path.join(configured!.homeDir, "config.yaml")).then((stat) => stat.mode & 0o777)).toBe(0o600);
  });

  it("does not create an overlay without the complete scoped runtime bundle", async () => {
    await expect(configureHermesRuntimeTools(undefined, undefined)).resolves.toBeUndefined();
    await expect(configureHermesRuntimeTools(undefined, { mcpEndpoint: "https://example.test/mcp", tools: ["connections_search"] })).resolves.toBeUndefined();
  });
});
