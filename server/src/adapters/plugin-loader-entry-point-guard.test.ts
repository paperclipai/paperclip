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
    // — an absolute path. The validator now catches this BEFORE the
    // loader ever sees the package (round 5: the validator resolves
    // the entry file at validation time and rejects absolutes). The
    // old behavior — accepting the absolute at validate time and
    // rejecting at load time — is preserved as a defense-in-depth
    // check in the loader's `resolveCanonicalEntryPoint`, but the
    // primary rejection is at validate time.
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

    const pkgJsonForMtime = path.join(pkgDir, "package.json");
    const old = Date.now() / 1000 - 60;
    await fs.utimes(pkgJsonForMtime, old, old);

    // Validator now rejects the absolute entry point up front with
    // a dedicated reason — fail closed before any loader call.
    const validator = await import("../services/adapter-plugin-validator.js");
    const preflight = validator.validateExternalPluginLoad(pkgDir);
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.reason).toBe("absolute_entry_point");
  });

  it("rejects a `../`-escape entry point in package.json (main field)", async () => {
    // `main: "../evil-outside-XXXX/evil-index.js"` would, after
    // path.resolve(pkgDir, "../evil-outside-XXXX/evil-index.js"),
    // land inside the evilOutsideDir rather than inside pkgDir. The
    // validator's new entry-file containment check (round 5) catches
    // this at validate time — realpath the joined entry, check
    // containment, reject. The loader's `resolveCanonicalEntryPoint`
    // keeps the same check as defense-in-depth.
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
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.reason).toBe("entry_file_outside_dir");
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
      preflight.canonicalDirIdentity,
    );
    expect(mod.type).toBe("good_entry_test");
  });

  it("rejects when the canonical dir is replaced between validation and load (path-name TOCTOU)", async () => {
    // Repro for Greptile P1/Security "Canonical path remains replaceable"
    // finding on PR #10706. The agent:
    //   1. Writes a benign package to the plugins dir with the
    //      required keyword and a backdated mtime.
    //   2. Triggers validation — the validator captures
    //      canonicalDir + canonicalDirInode for the benign package.
    //   3. After validation returns, removes the benign package and
    //      recreates the same pathname as a malicious package.
    //   4. The loader is called with the original canonicalDir +
    //      canonicalDirInode. Without the inode check, the loader
    //      would happily import the malicious replacement. With the
    //      check, the inode mismatch fires first and we fail closed.
    const pkgDir = path.join(pluginsDir, "swap-attempt");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "swap-attempt",
        version: "1.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        main: "./index.js",
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "index.js"),
      `export function createServerAdapter() { return { type: "swap_attempt_benign", configSchema: {} }; }`,
    );
    const pkgJsonForMtime = path.join(pkgDir, "package.json");
    const old = Date.now() / 1000 - 60;
    await fs.utimes(pkgJsonForMtime, old, old);

    const validator = await import("../services/adapter-plugin-validator.js");
    const preflight = validator.validateExternalPluginLoad(pkgDir);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    // Swap: remove the benign package and recreate the same pathname
    // as a malicious one. The pathname is identical so canonicalDir
    // (a string) is unchanged — but the inode (st_ino) is different.
    await fs.rm(pkgDir, { recursive: true, force: true });
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "swap-attempt",
        version: "2.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        main: "./index.js",
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "index.js"),
      `export function createServerAdapter() { return { type: "swap_attempt_malicious", configSchema: {} }; }`,
    );

    const loader = await import("./plugin-loader.js");
    await expect(
      loader.loadExternalAdapterPackage(
        "swap-attempt",
        pkgDir,
        preflight.canonicalDir,
        preflight.canonicalDirIdentity,
        preflight.canonicalManifestIdentity,
        preflight.canonicalEntryIdentity,
        preflight.canonicalEntryPath,
      ),
    ).rejects.toThrow(/files were mutated between validation and load/i);
  });

  it("accepts when canonicalDirInode is omitted (legacy callers)", async () => {
    // Backward-compat: callers that pass only canonicalDir (no inode)
    // should still load successfully — the inode check is opt-in
    // via the 4th argument. The route handlers now always pass the
    // inode, but internal callers like the registry may not.
    const pkgDir = path.join(pluginsDir, "no-inode-arg");
    await fs.mkdir(path.join(pkgDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "no-inode-arg",
        version: "1.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        main: "./src/index.js",
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "src", "index.js"),
      `export function createServerAdapter() { return { type: "no_inode_arg_test", configSchema: {} }; }`,
    );
    const pkgJsonForMtime = path.join(pkgDir, "package.json");
    const old = Date.now() / 1000 - 60;
    await fs.utimes(pkgJsonForMtime, old, old);

    const loader = await import("./plugin-loader.js");
    const mod = await loader.loadExternalAdapterPackage(
      "no-inode-arg",
      pkgDir,
      // explicit canonicalDir, but no inode arg — falls through to
      // the legacy realpath path.
      await (await import("node:fs")).realpathSync(pkgDir),
    );
    expect(mod.type).toBe("no_inode_arg_test");
  });

  it("rejects when package.json is overwritten between validation and load (file-mutation bypass)", async () => {
    // Repro for Greptile P1/Security round-5 finding on PR #10706:
    // "File mutations bypass fingerprint". The directory-only
    // fingerprint from round 4 does NOT detect an overwrite of
    // package.json (or the entry file) inside the same directory —
    // the directory stat fields stay identical. The agent:
    //   1. Writes a benign package to the plugins dir with the
    //      required keyword and a backdated mtime.
    //   2. Triggers validation — the validator captures the manifest
    //      and entry fingerprints.
    //   3. After validation returns, overwrites package.json with a
    //      malicious one (still valid JSON + keyword, but the
    //      entry now points to a different file). The directory
    //      inode is unchanged but package.json's mtime / ctime /
    //      size change.
    //   4. The loader is called with the original canonicalDir +
    //      fingerprints. Without the manifest fingerprint, the loader
    //      would happily re-read the malicious package.json. With
    //      the fingerprint, the manifest stat mismatch fires first
    //      and we fail closed.
    const pkgDir = path.join(pluginsDir, "manifest-tamper");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "manifest-tamper",
        version: "1.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        main: "./benign.js",
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "benign.js"),
      `export function createServerAdapter() { return { type: "manifest_tamper_benign", configSchema: {} }; }`,
    );
    // Backdate both files so the mtime floor is satisfied regardless
    // of clock and the post-overwrite mutation is detectable via
    // mtime/ctime/size change.
    const old = Date.now() / 1000 - 60;
    await fs.utimes(path.join(pkgDir, "package.json"), old, old);
    await fs.utimes(path.join(pkgDir, "benign.js"), old, old);

    const validator = await import("../services/adapter-plugin-validator.js");
    const preflight = validator.validateExternalPluginLoad(pkgDir);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    // Tamper: overwrite package.json with a malicious manifest that
    // still satisfies the validator's static checks (keyword present,
    // mtime is "old enough" because we'll backdate after write) but
    // redirects `main` to a file we control. The directory's stat
    // fields do not change, so round 4's directory fingerprint alone
    // would miss this.
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "manifest-tamper",
        version: "2.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        main: "./malicious.js",
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "malicious.js"),
      `export function createServerAdapter() { return { type: "manifest_tamper_malicious", configSchema: {} }; }`,
    );
    // Backdate so the manifest_too_recent floor doesn't fire first;
    // we want the fingerprint mismatch to be the rejection reason.
    await fs.utimes(path.join(pkgDir, "package.json"), old, old);
    await fs.utimes(path.join(pkgDir, "malicious.js"), old, old);

    const loader = await import("./plugin-loader.js");
    await expect(
      loader.loadExternalAdapterPackage(
        "manifest-tamper",
        pkgDir,
        preflight.canonicalDir,
        preflight.canonicalDirIdentity,
        preflight.canonicalManifestIdentity,
        preflight.canonicalEntryIdentity,
        preflight.canonicalEntryPath,
      ),
    ).rejects.toThrow(/files were mutated between validation and load/i);
  });

  it("rejects when the entry file is overwritten between validation and load (file-mutation bypass)", async () => {
    // Round-5 second flavor: even with the manifest fingerprint,
    // overwriting the entry file (without touching package.json) is
    // a separate bypass. The loader re-stats the captured entry
    // file path and rejects on mtime/ctime/size mismatch.
    const pkgDir = path.join(pluginsDir, "entry-tamper");
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "entry-tamper",
        version: "1.0.0",
        keywords: [REQUIRED_PLUGIN_KEYWORD],
        main: "./index.js",
      }),
    );
    await fs.writeFile(
      path.join(pkgDir, "index.js"),
      `export function createServerAdapter() { return { type: "entry_tamper_benign", configSchema: {} }; }`,
    );
    const old = Date.now() / 1000 - 60;
    await fs.utimes(path.join(pkgDir, "package.json"), old, old);
    await fs.utimes(path.join(pkgDir, "index.js"), old, old);

    const validator = await import("../services/adapter-plugin-validator.js");
    const preflight = validator.validateExternalPluginLoad(pkgDir);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;

    // Tamper: overwrite ONLY the entry file. package.json is
    // untouched, so its fingerprint still matches. The entry file's
    // mtime / ctime / size change.
    await fs.writeFile(
      path.join(pkgDir, "index.js"),
      `export function createServerAdapter() { return { type: "entry_tamper_malicious", configSchema: {} }; }`,
    );
    await fs.utimes(path.join(pkgDir, "index.js"), old, old);

    const loader = await import("./plugin-loader.js");
    await expect(
      loader.loadExternalAdapterPackage(
        "entry-tamper",
        pkgDir,
        preflight.canonicalDir,
        preflight.canonicalDirIdentity,
        preflight.canonicalManifestIdentity,
        preflight.canonicalEntryIdentity,
        preflight.canonicalEntryPath,
      ),
    ).rejects.toThrow(/files were mutated between validation and load/i);
  });
});