/**
 * Tests for the plugin-load validator. Covers all three constraints
 * plus the happy path. Uses a real temp directory so the mtime check
 * is genuinely exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  REQUIRED_PLUGIN_KEYWORD,
  MTIME_FLOOR_MS,
  validateExternalPluginLoad,
} from "./adapter-plugin-validator.js";

const { getAdapterPluginsDirMock } = vi.hoisted(() => ({
  getAdapterPluginsDirMock: vi.fn(),
}));

vi.mock("./adapter-plugin-store.js", () => ({
  getAdapterPluginsDir: getAdapterPluginsDirMock,
}));

let pluginsDir: string;

describe("validateExternalPluginLoad", () => {
  beforeEach(async () => {
    pluginsDir = path.join(
      os.tmpdir(),
      `paperclip-validator-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(pluginsDir, { recursive: true });
    getAdapterPluginsDirMock.mockReturnValue(pluginsDir);
  });

  afterEach(async () => {
    await fs.rm(pluginsDir, { recursive: true, force: true });
    getAdapterPluginsDirMock.mockReset();
  });

  it("accepts a package inside the plugins dir with the keyword and an old mtime", async () => {
    const pkgDir = path.join(pluginsDir, "good-plugin");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "good-plugin",
        version: "1.2.3",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
      }),
    );
    // Backdate the mtime so the floor is satisfied regardless of clock.
    const old = Date.now() / 1000 - 60;
    await fs.utimes(path.join(pkgDir, "package.json"), old, old);

    const decision = validateExternalPluginLoad(pkgDir);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.manifest.name).toBe("good-plugin");
      expect(decision.manifest.version).toBe("1.2.3");
      expect(decision.manifest.keywords).toContain(REQUIRED_PLUGIN_KEYWORD);
    }
  });

  it("rejects a package outside the plugins dir", async () => {
    const otherDir = path.join(os.tmpdir(), `outside-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(
      path.join(otherDir, "package.json"),
      JSON.stringify({ name: "x", keywords: [REQUIRED_PLUGIN_KEYWORD] }),
    );

    const decision = validateExternalPluginLoad(otherDir);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("outside_plugins_dir");
    }
    await fs.rm(otherDir, { recursive: true, force: true });
  });

  it("rejects a package that does not declare the required keyword", async () => {
    const pkgDir = path.join(pluginsDir, "no-keyword");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "no-keyword", keywords: ["other"] }),
    );
    const old = Date.now() / 1000 - 60;
    await fs.utimes(path.join(pkgDir, "package.json"), old, old);

    const decision = validateExternalPluginLoad(pkgDir);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("missing_keyword");
    }
  });

  it("rejects when keywords field is missing entirely", async () => {
    const pkgDir = path.join(pluginsDir, "no-keywords-field");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "no-keywords-field", version: "0.0.1" }),
    );
    const old = Date.now() / 1000 - 60;
    await fs.utimes(path.join(pkgDir, "package.json"), old, old);

    const decision = validateExternalPluginLoad(pkgDir);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("missing_keyword");
    }
  });

  it("rejects when package.json was modified within the mtime floor", async () => {
    const pkgDir = path.join(pluginsDir, "fresh-write");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "fresh-write", keywords: [REQUIRED_PLUGIN_KEYWORD] }),
    );

    const decision = validateExternalPluginLoad(pkgDir);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("manifest_too_recent");
    }
  });

  it("rejects when package.json does not exist", async () => {
    const pkgDir = path.join(pluginsDir, "no-manifest");
    await fs.mkdir(pkgDir, { recursive: true });

    const decision = validateExternalPluginLoad(pkgDir);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("missing_manifest");
    }
  });

  it("rejects when package.json is malformed JSON", async () => {
    const pkgDir = path.join(pluginsDir, "bad-json");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, "package.json"), "{ this is not valid JSON");
    const old = Date.now() / 1000 - 60;
    await fs.utimes(path.join(pkgDir, "package.json"), old, old);

    const decision = validateExternalPluginLoad(pkgDir);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("invalid_json");
    }
  });

  it("custom `now` parameter is honored for mtime floor edge cases", async () => {
    const pkgDir = path.join(pluginsDir, "edge-mtime");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "edge", keywords: [REQUIRED_PLUGIN_KEYWORD] }),
    );

    // Pretend "now" is far in the future so mtime is "old enough".
    const farFutureNow = Date.now() + 60_000;
    const decision = validateExternalPluginLoad(pkgDir, farFutureNow);
    expect(decision.ok).toBe(true);
  });

  it("the keyword constant matches what is enforced", () => {
    expect(REQUIRED_PLUGIN_KEYWORD).toBe("paperclip-adapter-plugin");
    expect(MTIME_FLOOR_MS).toBe(2000);
  });
});
