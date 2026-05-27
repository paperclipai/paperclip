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
