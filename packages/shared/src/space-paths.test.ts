import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultSpaceRegistry,
  resolveDefaultEmbeddedPostgresDir,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipInstanceConfigPath,
  resolvePaperclipInstanceRoot,
  resolvePaperclipSpaceRoot,
} from "./space-paths.js";

const ORIGINAL_ENV = { ...process.env };

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("space path resolution", () => {
  it("resolves default-space config and data under spaces/default for fresh installs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-space-paths-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_SPACE_ID;

    expect(resolvePaperclipConfigPathForInstance()).toBe(
      path.join(home, "instances", "default", "spaces", "default", "config.json"),
    );
    expect(resolveDefaultEmbeddedPostgresDir()).toBe(
      path.join(home, "instances", "default", "spaces", "default", "db"),
    );
  });

  it("uses the active space pointer from the instance registry", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-space-registry-"));
    process.env.PAPERCLIP_HOME = home;
    writeJson(resolvePaperclipInstanceConfigPath(), {
      ...createDefaultSpaceRegistry("system"),
      activeSpaceId: "dev",
      spaces: [{ id: "dev", root: "spaces/dev", createdAt: "2026-05-09T00:00:00.000Z" }],
    });

    expect(resolvePaperclipSpaceRoot()).toBe(path.join(home, "instances", "default", "spaces", "dev"));
    expect(resolvePaperclipConfigPathForInstance()).toBe(
      path.join(home, "instances", "default", "spaces", "dev", "config.json"),
    );
  });

  it("treats legacy root-shaped default installs as the active default space", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-space-legacy-"));
    process.env.PAPERCLIP_HOME = home;
    const legacyConfigPath = path.join(home, "instances", "default", "config.json");
    writeJson(legacyConfigPath, {
      database: {},
      server: {},
    });

    expect(resolvePaperclipSpaceRoot()).toBe(resolvePaperclipInstanceRoot());
    expect(resolvePaperclipConfigPathForInstance()).toBe(legacyConfigPath);
    expect(resolveDefaultEmbeddedPostgresDir()).toBe(
      path.join(home, "instances", "default", "db"),
    );
  });
});
