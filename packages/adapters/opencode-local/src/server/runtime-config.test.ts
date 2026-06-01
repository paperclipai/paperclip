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

async function makeConfigHome(
  initialConfig?: Record<string, unknown>,
  options?: { filename?: string; raw?: string },
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-"));
  cleanupPaths.add(root);
  const configDir = path.join(root, "opencode");
  await fs.mkdir(configDir, { recursive: true });
  const filename = options?.filename ?? "opencode.json";
  if (options?.raw !== undefined) {
    await fs.writeFile(path.join(configDir, filename), options.raw, "utf8");
  } else if (initialConfig) {
    await fs.writeFile(
      path.join(configDir, filename),
      `${JSON.stringify(initialConfig, null, 2)}\n`,
      "utf8",
    );
  }
  return root;
}

async function readRuntimeConfigFile(configHome: string, filename: string) {
  return JSON.parse(
    await fs.readFile(path.join(configHome, "opencode", filename), "utf8"),
  ) as Record<string, unknown>;
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

  it("preserves fields from an opencode.jsonc config with comments and trailing commas", async () => {
    const configHome = await makeConfigHome(undefined, {
      filename: "opencode.jsonc",
      raw: [
        "{",
        '  // user plugins',
        '  "plugin": ["my-plugin"],',
        "  /* model context protocol servers */",
        '  "mcp": { "context7": { "type": "local" } },',
        '  "permission": { "read": "allow" },',
        "}",
        "",
      ].join("\n"),
    });

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    // The merged config is written back to the .jsonc file the user has, not a
    // fresh permission-only opencode.json that would shadow it.
    await expect(
      fs.access(path.join(prepared.env.XDG_CONFIG_HOME, "opencode", "opencode.json")),
    ).rejects.toThrow();
    const runtimeConfig = await readRuntimeConfigFile(
      prepared.env.XDG_CONFIG_HOME,
      "opencode.jsonc",
    );
    expect(runtimeConfig).toMatchObject({
      plugin: ["my-plugin"],
      mcp: { context7: { type: "local" } },
      permission: {
        read: "allow",
        external_directory: "allow",
      },
    });

    await prepared.cleanup();
  });

  it("prefers opencode.json over opencode.jsonc when both exist", async () => {
    const configHome = await makeConfigHome({ source: "json" });
    await fs.writeFile(
      path.join(configHome, "opencode", "opencode.jsonc"),
      `${JSON.stringify({ source: "jsonc" }, null, 2)}\n`,
      "utf8",
    );

    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { XDG_CONFIG_HOME: configHome },
      config: {},
    });
    cleanupPaths.add(prepared.env.XDG_CONFIG_HOME);

    const runtimeConfig = await readRuntimeConfigFile(
      prepared.env.XDG_CONFIG_HOME,
      "opencode.json",
    );
    expect(runtimeConfig).toMatchObject({
      source: "json",
      permission: { external_directory: "allow" },
    });

    await prepared.cleanup();
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
});
