import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pathToFileURLSpy } = vi.hoisted(() => ({
  pathToFileURLSpy: vi.fn(),
}));

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  pathToFileURLSpy.mockImplementation(actual.pathToFileURL);
  return {
    ...actual,
    pathToFileURL: pathToFileURLSpy,
  };
});

import { pluginLoader } from "../services/plugin-loader.ts";

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempPluginRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-loader-"));
  tempDirs.push(dir);
  return dir;
}

function writePluginPackage(rootDir: string): string {
  const packageDir = path.join(rootDir, "@acme", "plugin-windows-manifest-import");
  mkdirSync(path.join(packageDir, "dist", "ui"), { recursive: true });

  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: "@acme/plugin-windows-manifest-import",
        version: "0.1.0",
        type: "module",
        paperclipPlugin: {
          manifest: "./dist/manifest.js",
          worker: "./dist/worker.js",
          ui: "./dist/ui",
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    path.join(packageDir, "dist", "manifest.js"),
    `export default ${JSON.stringify(
      {
        id: "acme.windows-manifest-import",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Windows Manifest Import",
        description: "Test plugin manifest for Windows file URL loading.",
        author: "Paperclip",
        categories: ["ui"],
        capabilities: ["ui.dashboardWidget.register"],
        entrypoints: {
          worker: "./dist/worker.js",
          ui: "./dist/ui",
        },
        ui: {
          slots: [
            {
              type: "dashboardWidget",
              id: "windows-manifest-widget",
              displayName: "Windows Manifest Widget",
              exportName: "WindowsManifestWidget",
            },
          ],
        },
      },
      null,
      2,
    )};\n`,
  );

  writeFileSync(
    path.join(packageDir, "dist", "worker.js"),
    "export default {};\n",
  );

  writeFileSync(
    path.join(packageDir, "dist", "ui", "index.js"),
    "export const WindowsManifestWidget = () => null;\n",
  );

  return packageDir;
}

describe("pluginLoader", () => {
  it("converts manifest paths to file URLs before dynamic import", async () => {
    const pluginRoot = makeTempPluginRoot();
    const packageDir = writePluginPackage(pluginRoot);
    const loader = pluginLoader({} as Parameters<typeof pluginLoader>[0], {
      enableNpmDiscovery: false,
      localPluginDir: pluginRoot,
    });

    const manifest = await loader.loadManifest(packageDir);

    expect(manifest?.id).toBe("acme.windows-manifest-import");
    expect(pathToFileURLSpy).toHaveBeenCalledWith(
      path.join(packageDir, "dist", "manifest.js"),
    );
  });
});
