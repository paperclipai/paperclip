import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = {
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
};

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginUiStaticRoutes } from "../routes/plugin-ui-static.js";

const ORIGINAL_ENV = { ...process.env };
const TEMP_DIRS: string[] = [];

describe("pluginUiStaticRoutes PAPERCLIP_HOME fallback", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockRegistry.getById.mockReset();
    mockRegistry.getByKey.mockReset();
    mockRegistry.getConfig.mockReset();
    mockRegistry.getConfig.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    while (TEMP_DIRS.length > 0) {
      const dir = TEMP_DIRS.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("serves plugin UI assets from PAPERCLIP_HOME/plugins when localPluginDir is omitted", async () => {
    const paperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-ui-home-"));
    TEMP_DIRS.push(paperclipHome);
    const uiDir = path.join(
      paperclipHome,
      "plugins",
      "node_modules",
      "paperclip-plugin-fixture",
      "dist",
      "ui",
    );
    fs.mkdirSync(uiDir, { recursive: true });
    fs.writeFileSync(path.join(uiDir, "index.js"), "export const fixture = true;\n");

    process.env.PAPERCLIP_HOME = paperclipHome;
    mockRegistry.getById.mockResolvedValue({
      id: "plugin-1",
      pluginKey: "paperclip-plugin-fixture",
      packageName: "paperclip-plugin-fixture",
      status: "ready",
      packagePath: null,
      manifestJson: {
        entrypoints: {
          ui: "./dist/ui",
        },
      },
    });

    const app = express();
    app.use(pluginUiStaticRoutes({} as never, {}));

    const response = await request(app)
      .get("/_plugins/plugin-1/ui/index.js")
      .expect(200);

    expect(response.text).toContain("fixture = true");
  });
});
