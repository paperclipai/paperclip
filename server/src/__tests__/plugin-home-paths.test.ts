import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultLocalPluginDir } from "../home-paths.js";
import { pluginLoader } from "../services/plugin-loader.js";

const ORIGINAL_ENV = { ...process.env };

function createPluginFixture(root: string, packageName: string) {
  const pluginDir = path.join(root, packageName);
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.2.3",
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "manifest.js"),
    [
      "export default {",
      `  id: ${JSON.stringify(packageName)},`,
      '  apiVersion: 1,',
      '  version: "1.2.3",',
      '  displayName: "Fixture Plugin",',
      '  description: "Fixture plugin for tests.",',
      '  author: "Paperclip",',
      '  categories: ["automation"],',
      '  capabilities: ["plugin.state.read"],',
      '  entrypoints: { worker: "./dist/worker.js" }',
      '};',
      '',
    ].join("\n"),
  );
}

describe("plugin home-aware paths", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("resolves the local plugin dir from PAPERCLIP_HOME", () => {
    process.env.PAPERCLIP_HOME = "/tmp/paperclip-home";

    expect(resolveDefaultLocalPluginDir()).toBe(path.resolve("/tmp/paperclip-home", "plugins"));
  });

  it("defaults plugin discovery to PAPERCLIP_HOME/plugins when configured", async () => {
    const paperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-home-"));
    const pluginRoot = path.join(paperclipHome, "plugins");
    process.env.PAPERCLIP_HOME = paperclipHome;
    createPluginFixture(pluginRoot, "paperclip-plugin-fixture");

    const loader = pluginLoader({} as never);
    const result = await loader.discoverFromLocalFilesystem();

    expect(result.errors).toEqual([]);
    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]?.packagePath).toBe(path.join(pluginRoot, "paperclip-plugin-fixture"));
    expect(result.discovered[0]?.packageName).toBe("paperclip-plugin-fixture");
    expect(result.discovered[0]?.manifest?.id).toBe("paperclip-plugin-fixture");
  });
});