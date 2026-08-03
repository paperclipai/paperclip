/**
 * Tests for the plugin-loader's entry-point containment guard.
 * Covers the Greptile P1/Security "Entry point escapes containment"
 * finding on PR #10706 — `resolveCanonicalEntryPoint` rejects
 * absolute entry points and `../`-escape entry points, and only
 * accepts entries that realpath-resolve inside the canonical package
 * dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// We mock `getAdapterPluginsDir` so the validator + loader see our
// test pluginsDir rather than the production one. vi.hoisted lifts
// the mock fn declaration above the module-graph freeze that vi.mock
// triggers, so the mock is wired before plugin-loader is imported.
const { getAdapterPluginsDirMock } = vi.hoisted(() => ({
  getAdapterPluginsDirMock: vi.fn(),
}));

vi.mock("../services/adapter-plugin-store.js", () => ({
  getAdapterPluginsDir: getAdapterPluginsDirMock,
}));

import { REQUIRED_PLUGIN_KEYWORD } from "../services/adapter-plugin-validator.js";

let pluginsDir: string;
let evilOutsideDir: string;

describe("plugin-loader entry-point containment guard", () => {
  beforeEach(async () => {
    pluginsDir = path.join(
      os.tmpdir(),
      `paperclip-entrypoint-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(pluginsDir, { recursive: true });
    getAdapterPluginsDirMock.mockReturnValue(pluginsDir);

    // A directory outside the plugins dir that holds an "evil" entry
    // we want to make sure is never imported.
    evilOutsideDir = path.join(
      os.tmpdir(),
      `paperclip-evil-outside-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(evilOutsideDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(pluginsDir, { recursive: true, force: true });
    await fs.rm(evilOutsideDir, { recursive: true, force: true });
    getAdapterPluginsDirMock.mockReset();
  });

  it("rejects an absolute entry point in package.json (exports field)", async () => {
    // package.json declares `exports["."] = "/tmp/evil-outside/.../index.js"`
    // — an absolute path. The loader must refuse to load this rather
    // than silently importing code from outside the managed plugins
    // dir. Without the absolute-entry-point guard, path.resolve(pkgDir,
    // "/abs/path") returns just "/abs/path", bypassing containment.
    const pkgDir = path.join(pluginsDir, "abs-entry");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "abs-entry",
        version: "1.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        exports: { ".": path.join(evilOutsideDir, "evil-index.js") },
      }),
    );

    // Validator still accepts this package (it can't see the
    // malicious exports field; exports is just a string here). The
    // entry-point guard runs at load time, not at validate time.
    const validator = await import("../services/adapter-plugin-validator.js");
    const pkgJsonForMtime = path.join(pkgDir, "package.json");
    const old = Date.now() / 1000 - 60;
    await fs.utimes(pkgJsonForMtime, old, old);
    const preflight = validator.validateExternalPluginLoad(pkgDir);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    // The actual loader call should now refuse the absolute entry point.
    const loader = await import("./plugin-loader.js");
    await expect(
      loader.loadExternalAdapterPackage(
        "abs-entry",
        pkgDir,
        preflight.canonicalDir,
      ),
    ).rejects.toThrow(/absolute path/i);
  });

  it("rejects a `../`-escape entry point in package.json (main field)", async () => {
    // `main: "../evil-outside-XXXX/evil-index.js"` would, after
    // path.resolve(pkgDir, "../evil-outside-XXXX/evil-index.js"),
    // land inside the evilOutsideDir rather than inside pkgDir. The
    // realpath containment check must reject this. We must create
    // the file at the escape target so realpath succeeds (otherwise
    // the loader throws ENOENT first, before the containment check).
    const pkgDir = path.join(pluginsDir, "escape-entry");
    await fs.mkdir(pkgDir, { recursive: true });
    const escapeRel = path.relative(pkgDir, evilOutsideDir);
    const escapeTarget = path.join(evilOutsideDir, "evil-index.js");
    await fs.writeFile(
      escapeTarget,
      `export function createServerAdapter() { return { type: "evil", configSchema: {} }; }`,
    );
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "escape-entry",
        version: "1.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        main: path.join(escapeRel, "evil-index.js"),
      }),
    );

    const pkgJsonForMtime = path.join(pkgDir, "package.json");
    const old = Date.now() / 1000 - 60;
    await fs.utimes(pkgJsonForMtime, old, old);

    const validator = await import("../services/adapter-plugin-validator.js");
    const preflight = validator.validateExternalPluginLoad(pkgDir);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    const loader = await import("./plugin-loader.js");
    await expect(
      loader.loadExternalAdapterPackage(
        "escape-entry",
        pkgDir,
        preflight.canonicalDir,
      ),
    ).rejects.toThrow(/outside the canonical package dir/i);
  });

  it("accepts a normal relative entry point inside the package dir", async () => {
    // Sanity check: a benign package with a normal relative entry
    // point should still load. This guards against the entry-point
    // guard being overly aggressive.
    const pkgDir = path.join(pluginsDir, "good-entry");
    await fs.mkdir(path.join(pkgDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "good-entry",
        version: "1.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        main: "./src/index.js",
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "src", "index.js"),
      `export function createServerAdapter() { return { type: "good_entry_test", configSchema: {} }; }`,
    );
    const pkgJsonForMtime = path.join(pkgDir, "package.json");
    const old = Date.now() / 1000 - 60;
    await fs.utimes(pkgJsonForMtime, old, old);

    const validator = await import("../services/adapter-plugin-validator.js");
    const preflight = validator.validateExternalPluginLoad(pkgDir);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    const loader = await import("./plugin-loader.js");
    const mod = await loader.loadExternalAdapterPackage(
      "good-entry",
      pkgDir,
      preflight.canonicalDir,
    );
    expect(mod.type).toBe("good_entry_test");
  });
});