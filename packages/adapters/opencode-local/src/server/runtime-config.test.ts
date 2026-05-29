import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function makeConfigHome(initialConfig?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

describe("prepareOpenCodeRuntimeConfig", () => {
  it("injects an external_directory allow rule by default", async () => {
    const configHome = await makeConfigHome({
      permission: {
        read: "allow",
      },
      theme: "system",
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(configHome);
    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(runtimeConfig).toMatchObject({
      theme: "system",
      permission: {
        read: "allow",
        external_directory: "allow",
      },
    });

    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("respects explicit opt-out", async () => {
    const configHome = await makeConfigHome();
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: { dangerouslySkipPermissions: false },
    });

    expect(prepared.env).toEqual({ XDG_CONFIG_HOME: configHome });
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("applies MCP_LIST and writes filtered mcp tree", async () => {
    const configHome = await makeConfigHome({
      mcp: {
        "jira-ibm": { type: "local", command: ["legacy", "args"], enabled: true },
        "ghost-mcp": { type: "local", command: ["should-be-removed"], enabled: true },
      },
    });
    const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-mcp-"));
    cleanupPaths.add(registryRoot);
    await fs.mkdir(path.join(registryRoot, "manifests"), { recursive: true });
    await fs.writeFile(
      path.join(registryRoot, "registry.json"),
      JSON.stringify({
        servers: [
          { id: "jira-ibm", status: "validated", manifest: "manifests/jira-ibm.json" },
          { id: "wikipedia", status: "validated", manifest: "manifests/wikipedia.json" },
        ],
      }),
    );
    await fs.writeFile(
      path.join(registryRoot, "manifests", "jira-ibm.json"),
      JSON.stringify({ id: "jira-ibm", environment: { requiredNames: [] } }),
    );
    await fs.writeFile(
      path.join(registryRoot, "manifests", "wikipedia.json"),
      JSON.stringify({ id: "wikipedia", environment: { requiredNames: [] } }),
    );

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: {
        XDG_CONFIG_HOME: configHome,
        MCP_LIST: "jira-ibm, wikipedia",
        PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
        PAPERCLIP_MCP_RUN_SCRIPT: "/run-mcp.sh",
      },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = JSON.parse(
      await fs.readFile(
        path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    const mcp = (runtimeConfig as { mcp?: Record<string, unknown> }).mcp ?? {};
    expect(Object.keys(mcp).sort()).toEqual(["jira-ibm", "wikipedia"]);
    // Inherited config wins for jira-ibm.
    expect(mcp["jira-ibm"]).toMatchObject({ command: ["legacy", "args"] });
    // wikipedia is rendered from registry pointing at run-mcp.sh.
    expect(mcp.wikipedia).toMatchObject({
      type: "local",
      command: ["bash", "/run-mcp.sh", "wikipedia"],
      enabled: true,
    });
    expect(prepared.notes.some((n) => n.includes("MCP_LIST"))).toBe(true);
    await prepared.cleanup();
    cleanupPaths.delete(prepared.env.XDG_CONFIG_HOME);
  });

  it("fails closed on unknown MCP_LIST id", async () => {
    const configHome = await makeConfigHome({});
    const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-mcp-"));
    cleanupPaths.add(registryRoot);
    await fs.mkdir(path.join(registryRoot, "manifests"), { recursive: true });
    await fs.writeFile(
      path.join(registryRoot, "registry.json"),
      JSON.stringify({ servers: [] }),
    );

    await expect(
      prepareOpenCodeRuntimeConfig({
        env: {
          XDG_CONFIG_HOME: configHome,
          MCP_LIST: "ghost",
          PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
        },
        config: {},
      }),
    ).rejects.toThrow(/MCP_LIST validation failed/);
  });

  it("fails closed on blocked MCP_LIST status", async () => {
    const configHome = await makeConfigHome({});
    const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-mcp-"));
    cleanupPaths.add(registryRoot);
    await fs.mkdir(path.join(registryRoot, "manifests"), { recursive: true });
    await fs.writeFile(
      path.join(registryRoot, "registry.json"),
      JSON.stringify({
        servers: [{ id: "box", status: "blocked-runtime-mismatch", manifest: "manifests/box.json" }],
      }),
    );
    await fs.writeFile(
      path.join(registryRoot, "manifests", "box.json"),
      JSON.stringify({ id: "box" }),
    );

    await expect(
      prepareOpenCodeRuntimeConfig({
        env: {
          XDG_CONFIG_HOME: configHome,
          MCP_LIST: "box",
          PAPERCLIP_MCP_REGISTRY_ROOT: registryRoot,
        },
        config: {},
      }),
    ).rejects.toThrow(/blocked_status/);
  });
});
