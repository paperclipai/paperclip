import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createHermesRuntimeMcpHome } from "./runtime-mcp.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Hermes run-scoped MCP config", () => {
  it("adds only run-scoped gateways and keeps bearer tokens out of the config file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-runtime-mcp-test-"));
    temporaryRoots.push(root);
    const baseHome = path.join(root, "base", ".hermes");
    await fs.mkdir(path.join(baseHome, "sessions"), { recursive: true });
    await fs.writeFile(path.join(baseHome, "config.yaml"), "model:\n  provider: custom\nmcp_servers:\n  personal:\n    url: https://example.test/mcp\n", "utf8");
    await fs.writeFile(path.join(baseHome, "sessions", "state.json"), "{}", "utf8");

    const accessToken = "short-lived-paperclip-gateway-token";
    const runHome = await createHermesRuntimeMcpHome({
      servers: [{
        name: "paperclip-assigned",
        url: "http://127.0.0.1:3100/mcp/gateways/gw_123",
        token: accessToken,
      }],
      env: { HOME: path.join(root, "base"), PAPERCLIP_HERMES_HOME: path.join(root, "base") },
      runId: "12345678",
    });

    expect(runHome).not.toBeNull();
    const configText = await fs.readFile(path.join(runHome!.home, "config.yaml"), "utf8");
    const config = parse(configText) as Record<string, any>;
    expect(config.model.provider).toBe("custom");
    expect(config.mcp_servers.personal.url).toBe("https://example.test/mcp");
    expect(config.mcp_servers.paperclip_assigned_12345678_0.url).toBe("${PAPERCLIP_RUNTIME_MCP_URL_0}");
    expect(config.mcp_servers.paperclip_assigned_12345678_0.headers.Authorization).toBe("Bearer ${PAPERCLIP_RUNTIME_MCP_TOKEN_0}");
    expect(runHome!.serverNames).toEqual(["paperclip_assigned_12345678_0"]);
    expect(configText).not.toContain(accessToken);
    expect(runHome!.env).toEqual({
      PAPERCLIP_RUNTIME_MCP_URL_0: "http://127.0.0.1:3100/mcp/gateways/gw_123",
      PAPERCLIP_RUNTIME_MCP_TOKEN_0: accessToken,
    });
    expect((await fs.lstat(path.join(runHome!.home, "sessions"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(runHome!.home, "sessions", "state.json"), "utf8")).toBe("{}");

    await runHome!.cleanup();
    await expect(fs.access(runHome!.home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(baseHome, "config.yaml"), "utf8")).toContain("personal:");
  });

  it("does not create an override when Paperclip supplies no gateway", async () => {
    await expect(createHermesRuntimeMcpHome({
      servers: [],
      env: {},
      runId: "run-no-gateway",
    })).resolves.toBeNull();
  });

  it("falls back to the persistent Hermes home when HERMES_HOME points to a stale run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-runtime-mcp-stale-home-test-"));
    temporaryRoots.push(root);
    const persistentHome = path.join(root, "persistent", ".hermes");
    const staleHome = path.join(root, "removed-run", ".hermes");
    const stablePython = path.join(persistentHome, "tools", "python-test", "bin", "python3");
    await fs.mkdir(path.dirname(stablePython), { recursive: true });
    await fs.writeFile(stablePython, "test runtime", "utf8");
    const launcherPath = path.join(persistentHome, "hermes-agent", ".hermes", "bin", "hermes");
    await fs.mkdir(path.dirname(launcherPath), { recursive: true });
    await fs.writeFile(
      launcherPath,
      "#!/bin/sh\nexec /tmp/paperclip-hermes-run-old/.hermes/tools/python-test/bin/python3 -I -c 'pass'\n",
      { encoding: "utf8", mode: 0o755 },
    );

    const runHome = await createHermesRuntimeMcpHome({
      servers: [{ name: "paperclip-read", url: "https://example.test/mcp", token: "token" }],
      env: {
        HERMES_HOME: staleHome,
        PAPERCLIP_HERMES_HOME: path.join(root, "persistent"),
      },
      runId: "stale-home",
    });

    expect(runHome).not.toBeNull();
    expect((await fs.lstat(path.join(runHome!.home, "tools"))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(runHome!.home, "tools"))).toBe(path.join(persistentHome, "tools"));
    expect(await fs.readFile(launcherPath, "utf8")).toContain(stablePython);
    await runHome!.cleanup();
  });
});
