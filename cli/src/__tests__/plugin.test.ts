import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PluginHostService,
  describePluginConfig,
  doctorPlugins,
  installLocalPlugin,
  listInstalledPlugins,
  setPluginConfig,
  setPluginEnabled,
  uninstallPlugin,
  validateLocalPluginPackage,
} from "../commands/plugin-lib.js";

const ORIGINAL_ENV = { ...process.env };

function createPluginFixture(
  root: string,
  input?: { apiVersion?: number; pluginId?: string; workerMode?: "ok" | "fail-on-init" },
): string {
  const pluginDir = path.resolve(root, "plugin-sample");
  fs.mkdirSync(path.resolve(pluginDir, "dist"), { recursive: true });

  const apiVersion = input?.apiVersion ?? 1;
  const pluginId = input?.pluginId ?? "@paperclip/plugin-sample";
  const workerMode = input?.workerMode ?? "ok";

  fs.writeFileSync(
    path.resolve(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: "@paperclip/plugin-sample",
        version: "0.1.0",
        type: "module",
        paperclipPlugin: {
          manifest: "./dist/manifest.js",
          worker: "./dist/worker.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  fs.writeFileSync(
    path.resolve(pluginDir, "dist", "manifest.js"),
    `export default {
  id: ${JSON.stringify(pluginId)},
  apiVersion: ${apiVersion},
  version: "0.1.0",
  displayName: "Sample Plugin",
  description: "fixture",
  capabilities: []
};\n`,
    "utf8",
  );

  const workerBody =
    workerMode === "fail-on-init"
      ? `
export async function initialize(_input) { throw new Error("init failed"); }
export async function health() { return { status: "never" }; }
export async function shutdown() { return undefined; }
`
      : `
let initialized = false;
let initInput = null;
export async function initialize(input) { initialized = true; initInput = input; }
export async function health() {
  return {
    status: initialized ? "ok" : "booting",
    hostApiVersion: initInput?.hostApiVersion ?? null,
    configValue: initInput?.config?.sample ?? null,
  };
}
export async function shutdown() { initialized = false; }
`;

  fs.writeFileSync(path.resolve(pluginDir, "dist", "worker.js"), workerBody, "utf8");

  return pluginDir;
}

function readRegistry(home: string): unknown {
  const registryPath = path.resolve(home, "instances", "default", "plugins", "registry.json");
  return JSON.parse(fs.readFileSync(registryPath, "utf8"));
}

describe("plugin host capability", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("installs, sets config, doctors, and uninstalls local plugin path", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-host-"));
    process.env.PAPERCLIP_HOME = path.resolve(tempRoot, "home");

    const pluginPath = createPluginFixture(tempRoot);

    const installed = await installLocalPlugin(pluginPath, {});
    expect(installed.pluginId).toBe("@paperclip/plugin-sample");
    expect(installed.status).toBe("ready");

    const configured = setPluginConfig("@paperclip/plugin-sample", { sample: "abc" }, {});
    expect(configured.config).toEqual({ sample: "abc" });

    const listed = listInstalledPlugins({});
    expect(listed).toHaveLength(1);
    expect(listed[0]?.pluginId).toBe("@paperclip/plugin-sample");
    expect(listed[0]?.lifecycle.loadCount).toBeGreaterThanOrEqual(1);

    const doctor = await doctorPlugins({});
    expect(doctor).toHaveLength(1);
    expect(doctor[0]?.ok).toBe(true);
    expect(doctor[0]?.health).toMatchObject({ status: "ok" });

    await uninstallPlugin("@paperclip/plugin-sample", {});
    expect(listInstalledPlugins({})).toHaveLength(0);
  });

  it("supports enable/disable state transitions", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-enable-"));
    process.env.PAPERCLIP_HOME = path.resolve(tempRoot, "home");
    const pluginPath = createPluginFixture(tempRoot);

    await installLocalPlugin(pluginPath, {});

    const disabled = await setPluginEnabled("@paperclip/plugin-sample", false, {});
    expect(disabled.enabled).toBe(false);
    expect(disabled.status).toBe("disabled");

    const doctorDisabled = await doctorPlugins({ pluginId: "@paperclip/plugin-sample" });
    expect(doctorDisabled[0]).toMatchObject({ ok: true, status: "disabled" });

    const enabled = await setPluginEnabled("@paperclip/plugin-sample", true, {});
    expect(enabled.enabled).toBe(true);

    const doctorEnabled = await doctorPlugins({ pluginId: "@paperclip/plugin-sample" });
    expect(doctorEnabled[0]).toMatchObject({ ok: true, status: "ready" });
  });

  it("marks error status when worker initialize fails", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-bad-worker-"));
    process.env.PAPERCLIP_HOME = path.resolve(tempRoot, "home");
    const pluginPath = createPluginFixture(tempRoot, { workerMode: "fail-on-init" });

    const installed = await installLocalPlugin(pluginPath, {});
    expect(installed.status).toBe("error");
    expect(installed.lastError).toMatch(/init failed/);

    const doctor = await doctorPlugins({ pluginId: "@paperclip/plugin-sample", restartOnFail: true });
    expect(doctor[0]).toMatchObject({ ok: false, status: "error" });
  });

  it("migrates v1 registry to v2 format", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-registry-v1-"));
    const home = path.resolve(tempRoot, "home");
    process.env.PAPERCLIP_HOME = home;

    const instanceRoot = path.resolve(home, "instances", "default");
    const pluginsRoot = path.resolve(instanceRoot, "plugins");
    fs.mkdirSync(path.resolve(pluginsRoot, "installed"), { recursive: true });

    fs.writeFileSync(
      path.resolve(pluginsRoot, "registry.json"),
      JSON.stringify(
        {
          version: 1,
          plugins: [
            {
              pluginId: "@paperclip/legacy",
              packageName: "@paperclip/legacy",
              packageVersion: "0.0.1",
              sourcePath: "/tmp/legacy",
              symlinkPath: "/tmp/legacy-link",
              manifestPath: "/tmp/legacy/manifest.js",
              workerPath: "/tmp/legacy/worker.js",
              status: "ready",
              installedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const host = new PluginHostService();
    const listed = host.listInstalled();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.enabled).toBe(true);
    expect(listed[0]?.lifecycle.loadCount).toBe(0);
  });

  it("rejects invalid manifest apiVersion", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-host-invalid-"));
    const pluginPath = createPluginFixture(tempRoot, { apiVersion: 2 });

    await expect(validateLocalPluginPackage(pluginPath)).rejects.toThrow(
      /Unsupported plugin apiVersion/,
    );
  });

  it("writes v2 registry shape with lifecycle metadata", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-registry-v2-"));
    const home = path.resolve(tempRoot, "home");
    process.env.PAPERCLIP_HOME = home;

    const pluginPath = createPluginFixture(tempRoot);
    await installLocalPlugin(pluginPath, {});

    const registry = readRegistry(home) as { version: number; plugins: Array<{ lifecycle?: unknown }> };
    expect(registry.version).toBe(2);
    expect(registry.plugins[0]?.lifecycle).toBeTruthy();
  });

  it("describes inferred config schema from current config", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-config-describe-"));
    process.env.PAPERCLIP_HOME = path.resolve(tempRoot, "home");

    const pluginPath = createPluginFixture(tempRoot);
    await installLocalPlugin(pluginPath, {});
    setPluginConfig("@paperclip/plugin-sample", { apiKey: "abc", retries: 3, enabled: true }, {});

    const described = await describePluginConfig("@paperclip/plugin-sample", {});
    expect(described.schemaSource).toBe("inferred");
    expect(described.schema.fields.some((field) => field.key === "apiKey" && field.type === "password")).toBe(true);
    expect(described.schema.fields.some((field) => field.key === "retries" && field.type === "number")).toBe(true);
    expect(described.schema.fields.some((field) => field.key === "enabled" && field.type === "boolean")).toBe(true);
  });
});
