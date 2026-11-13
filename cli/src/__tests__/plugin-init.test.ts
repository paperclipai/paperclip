import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scaffoldPluginProject: vi.fn((options: { outputDir: string }) => options.outputDir),
}));

vi.mock("../../../packages/plugins/create-paperclip-plugin/src/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../packages/plugins/create-paperclip-plugin/src/index.js")>(
      "../../../packages/plugins/create-paperclip-plugin/src/index.js",
    );
  return {
    ...actual,
    scaffoldPluginProject: mocks.scaffoldPluginProject,
  };
});

import {
  buildPluginInstallRequest,
  buildPluginInitNextCommands,
  buildPluginInitScaffoldOptions,
  formatTargetDiagnostics,
  probeTargetDiagnostics,
  registerPluginCommands,
} from "../commands/client/plugin.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-plugin-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin init", () => {
  beforeEach(() => {
    mocks.scaffoldPluginProject.mockClear();
  });

  it("maps package name and flags to scaffolder options", () => {
    const cwd = path.resolve("/tmp/paperclip-cli-test");
    const options = buildPluginInitScaffoldOptions(
      "@acme/plugin-linear",
      {
        output: "plugins",
        template: "connector",
        category: "automation",
        displayName: "Linear Bridge",
        description: "Syncs Linear issues",
        author: "Acme",
        sdkPath: "../paperclip/packages/plugins/sdk",
      },
      cwd,
    );

    expect(options).toEqual({
      pluginName: "@acme/plugin-linear",
      outputDir: path.resolve(cwd, "plugins", "plugin-linear"),
      template: "connector",
      category: "automation",
      displayName: "Linear Bridge",
      description: "Syncs Linear issues",
      author: "Acme",
      sdkPath: "../paperclip/packages/plugins/sdk",
    });
  });

  it("builds exact next commands using the scaffold path", () => {
    expect(buildPluginInitNextCommands("/tmp/acme plugin")).toEqual([
      "cd '/tmp/acme plugin'",
      "pnpm install",
      "pnpm dev",
      "paperclipai plugin install '/tmp/acme plugin'",
    ]);
  });

  it("registers the CLI wrapper and invokes the existing scaffolder", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerPluginCommands(program);

    await program.parseAsync(
      [
        "plugin",
        "init",
        "demo-plugin",
        "--output",
        "/tmp/paperclip-init-output",
        "--template",
        "workspace",
        "--category",
        "workspace",
        "--display-name",
        "Demo Plugin",
        "--description",
        "Demo description",
        "--author",
        "Paperclip",
        "--sdk-path",
        "/repo/packages/plugins/sdk",
      ],
      { from: "user" },
    );

    expect(mocks.scaffoldPluginProject).toHaveBeenCalledTimes(1);
    expect(mocks.scaffoldPluginProject).toHaveBeenCalledWith({
      pluginName: "demo-plugin",
      outputDir: path.resolve("/tmp/paperclip-init-output", "demo-plugin"),
      template: "workspace",
      category: "workspace",
      displayName: "Demo Plugin",
      description: "Demo description",
      author: "Paperclip",
      sdkPath: "/repo/packages/plugins/sdk",
    });
  });
});

describe("plugin install", () => {
  it("resolves an existing relative local path to an absolute local install request", () => {
    const cwd = makeTempDir();
    const pluginDir = path.join(cwd, "demo-plugin");
    fs.mkdirSync(pluginDir);

    expect(buildPluginInstallRequest("demo-plugin", {}, { cwd })).toEqual({
      packageName: pluginDir,
      version: undefined,
      isLocalPath: true,
    });
  });

  it("keeps an absolute local path absolute and marks it as local", () => {
    const pluginDir = path.join(makeTempDir(), "demo-plugin");
    fs.mkdirSync(pluginDir);

    expect(buildPluginInstallRequest(pluginDir, {}, { cwd: "/" })).toEqual({
      packageName: pluginDir,
      version: undefined,
      isLocalPath: true,
    });
  });

  it("preserves npm package installs when no local path exists", () => {
    expect(
      buildPluginInstallRequest("@acme/plugin-linear", { version: "1.2.3" }, {
        cwd: makeTempDir(),
      }),
    ).toEqual({
      packageName: "@acme/plugin-linear",
      version: "1.2.3",
      isLocalPath: false,
    });
  });
});

describe("plugin target diagnostics", () => {
  it("probes /api/health and reports the resolved api base on success", async () => {
    const get = vi.fn(async () => ({
      status: "ok",
      version: "1.2.3",
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    }));

    const diag = await probeTargetDiagnostics({ apiBase: "http://127.0.0.1:3100", get });

    expect(get).toHaveBeenCalledWith("/api/health");
    expect(diag).toEqual({
      apiBase: "http://127.0.0.1:3100",
      reachable: true,
      health: {
        status: "ok",
        version: "1.2.3",
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
      },
    });
  });

  it("marks the target unreachable when the health probe throws", async () => {
    const get = vi.fn(async () => {
      throw new Error("Could not reach the Paperclip API.\nRequest: GET ...");
    });

    const diag = await probeTargetDiagnostics({ apiBase: "http://other-host:9999", get });

    expect(diag.apiBase).toBe("http://other-host:9999");
    expect(diag.reachable).toBe(false);
    expect(diag.error).toContain("Could not reach the Paperclip API.");
  });

  it("formats reachable diagnostics with version and mode", () => {
    const rendered = formatTargetDiagnostics({
      apiBase: "http://127.0.0.1:3100",
      reachable: true,
      health: { status: "ok", version: "9.9.9", deploymentMode: "local_trusted" },
    });

    expect(rendered).toContain("http://127.0.0.1:3100");
    expect(rendered).toContain("version=9.9.9");
    expect(rendered).toContain("mode=local_trusted");
  });

  it("formats unreachable diagnostics with a remediation hint", () => {
    const rendered = formatTargetDiagnostics({
      apiBase: "http://127.0.0.1:3100",
      reachable: false,
      error: "ECONNREFUSED",
    });

    expect(rendered).toContain("unreachable");
    expect(rendered).toContain("--api-base");
    expect(rendered).toContain("PAPERCLIP_API_URL");
  });
});
