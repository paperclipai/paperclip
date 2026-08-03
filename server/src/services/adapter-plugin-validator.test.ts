/**
 * Tests for the plugin-load validator. Covers all three constraints
 * plus the happy path. Uses a real temp directory so the mtime check
 * is genuinely exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fssync from "node:fs";
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
      expect(decision.manifest.version).toBe("1.2.3");
      expect(decision.manifest.keywords).toContain(REQUIRED_PLUGIN_KEYWORD);
      // canonicalDir is the realpath-resolved package dir; callers MUST
      // use this (not the original mutable packageDir) when loading the
      // module. The TOCTOU race fix relies on this.
      expect(decision.canonicalDir).toBe(fssync.realpathSync(pkgDir));
      // canonicalDirIdentity is the multi-field fingerprint
      // (dev/ino/ctime/mtime/size) captured at validation time. The
      // loader compares all five fields to detect a replace-at-
      // same-pathname between validation and load. st_ino alone is
      // not sufficient on ext4 with inode recycling.
      const expectedStat = fssync.statSync(pkgDir);
      expect(decision.canonicalDirIdentity.ino).toBe(expectedStat.ino);
      expect(decision.canonicalDirIdentity.dev).toBe(expectedStat.dev);
      expect(decision.canonicalDirIdentity.ctime).toBe(expectedStat.ctimeMs);
      expect(decision.canonicalDirIdentity.mtime).toBe(expectedStat.mtimeMs);
      expect(decision.canonicalDirIdentity.size).toBe(expectedStat.size);
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

  it("rejects a symlink inside the plugins dir that points outside (symlink containment bypass)", async () => {
    // Repro for Greptile P1/Security finding on PR review:
    // an agent plants a symlink at ~/.paperclip/adapter-plugins/innocent
    // pointing to /tmp/evil-package/. A lexical path.startsWith() check
    // accepts the symlink because its lexical path IS inside the plugins
    // dir, but the manifest read follows the link to /tmp/evil-package/
    // and a dynamic import would execute code there. The fix is to
    // canonicalize via realpath BEFORE containment testing.
    const evilDir = path.join(os.tmpdir(), `evil-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(evilDir, { recursive: true });
    await fs.writeFile(
      path.join(evilDir, "package.json"),
      JSON.stringify({
        name: "evil",
        version: "1.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
      }),
    );
    const old = Date.now() / 1000 - 60;
    await fs.utimes(path.join(evilDir, "package.json"), old, old);

    const symlinkPath = path.join(pluginsDir, "innocent-symlink");
    await fs.symlink(evilDir, symlinkPath, "dir");

    const decision = validateExternalPluginLoad(symlinkPath);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      // Could be outside_plugins_dir (realpath canonicalized to evilDir)
      // OR missing_manifest (realpath failed on the symlink) — both are
      // acceptable rejection reasons for a symlink bypass attempt.
      expect(["outside_plugins_dir", "missing_manifest"]).toContain(decision.reason);
    }

    await fs.rm(symlinkPath, { force: true });
    await fs.rm(evilDir, { recursive: true, force: true });
  });

  it("rejects an unresolvable path (realpath failure)", async () => {
    // A path that doesn't exist should be rejected, not crash the
    // validator. realpathSync throws ENOENT; safeRealpath converts to
    // null; the containment check then fails closed.
    const ghostDir = path.join(pluginsDir, "does-not-exist-" + Math.random().toString(36).slice(2));

    const decision = validateExternalPluginLoad(ghostDir);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(["outside_plugins_dir", "missing_manifest"]).toContain(decision.reason);
    }
  });
});
