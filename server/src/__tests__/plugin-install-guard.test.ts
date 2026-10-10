import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeLocalPluginPath,
  isCloudManagedInstance,
  isWithinBundledPluginRoot,
} from "../services/plugin-install-guard.js";

describe("isCloudManagedInstance", () => {
  it("returns false when PAPERCLIP_MANAGED_CONFIG is absent", () => {
    expect(isCloudManagedInstance({})).toBe(false);
    expect(isCloudManagedInstance({ OTHER_VAR: "x" })).toBe(false);
  });

  it("returns true when PAPERCLIP_MANAGED_CONFIG is set to a cloud document", () => {
    const doc = JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "1", features: {}, plugins: { autoInstall: [] } });
    expect(isCloudManagedInstance({ PAPERCLIP_MANAGED_CONFIG: doc })).toBe(true);
  });

  it("fails closed: blank or corrupted documents still count as cloud-managed", () => {
    expect(isCloudManagedInstance({ PAPERCLIP_MANAGED_CONFIG: "" })).toBe(true);
    expect(isCloudManagedInstance({ PAPERCLIP_MANAGED_CONFIG: "   " })).toBe(true);
    expect(isCloudManagedInstance({ PAPERCLIP_MANAGED_CONFIG: "{not json" })).toBe(true);
    expect(isCloudManagedInstance({ PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ mode: "self-hosted" }) })).toBe(true);
  });
});

describe("canonicalizeLocalPluginPath", () => {
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupPaths.add(dir);
    return dir;
  }

  it("accepts an existing absolute directory path", async () => {
    const dir = await makeTempDir("guard-abs-");
    const result = await canonicalizeLocalPluginPath(dir);
    expect(result).toEqual({ ok: true, canonicalPath: await realCanonical(dir) });
  });

  it("collapses traversal segments to the canonical path", async () => {
    const dir = await makeTempDir("guard-traversal-");
    const nested = path.join(dir, "a", "b");
    await mkdir(nested, { recursive: true });
    const traversal = path.join(dir, "a", "..", "a", "b", "..", "b");
    const result = await canonicalizeLocalPluginPath(traversal);
    expect(result).toEqual({ ok: true, canonicalPath: await realCanonical(nested) });
  });

  it("resolves symlinks to their target", async () => {
    const dir = await makeTempDir("guard-symlink-");
    const target = path.join(dir, "target");
    await mkdir(target, { recursive: true });
    const link = path.join(dir, "link");
    await symlink(target, link, "dir");
    const result = await canonicalizeLocalPluginPath(link);
    expect(result).toEqual({ ok: true, canonicalPath: await realCanonical(target) });
  });

  it("rejects paths containing a null byte", async () => {
    const result = await canonicalizeLocalPluginPath("/tmp/foo\0bar");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("null byte");
  });

  it("rejects nonexistent paths", async () => {
    const dir = await makeTempDir("guard-missing-");
    const result = await canonicalizeLocalPluginPath(path.join(dir, "does-not-exist"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("does not exist");
  });

  it("rejects paths that resolve to a file rather than a directory", async () => {
    const dir = await makeTempDir("guard-file-");
    const file = path.join(dir, "plugin.txt");
    await writeFile(file, "not a directory", "utf8");
    const result = await canonicalizeLocalPluginPath(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a directory");
  });
});

describe("isWithinBundledPluginRoot", () => {
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  async function makeCatalogFixture(): Promise<{ root: string; inside: string; outside: string }> {
    const base = await mkdtemp(path.join(os.tmpdir(), "guard-catalog-"));
    cleanupPaths.add(base);
    const root = path.join(base, "packages", "plugins");
    const inside = path.join(root, "plugin-good");
    const outside = path.join(base, "elsewhere");
    await mkdir(inside, { recursive: true });
    await mkdir(outside, { recursive: true });
    return { root, inside, outside };
  }

  it("accepts a directory inside the catalog root", async () => {
    const { root, inside } = await makeCatalogFixture();
    expect(await isWithinBundledPluginRoot(await realCanonical(inside), root)).toBe(true);
  });

  it("rejects a directory outside the catalog root", async () => {
    const { root, outside } = await makeCatalogFixture();
    expect(await isWithinBundledPluginRoot(await realCanonical(outside), root)).toBe(false);
  });

  it("rejects the catalog root itself", async () => {
    const { root } = await makeCatalogFixture();
    expect(await isWithinBundledPluginRoot(await realCanonical(root), root)).toBe(false);
  });

  it("rejects a sibling directory whose name shares the root as a string prefix", async () => {
    const { root } = await makeCatalogFixture();
    const sibling = `${root}-evil`;
    await mkdir(sibling, { recursive: true });
    expect(await isWithinBundledPluginRoot(await realCanonical(sibling), root)).toBe(false);
  });

  it("rejects a symlink target that escapes the catalog root once canonicalized", async () => {
    const { root, outside } = await makeCatalogFixture();
    const link = path.join(root, "sneaky");
    await symlink(outside, link, "dir");
    // The guard contract is that callers canonicalize first; the symlink's
    // real path lands outside the root and must be rejected.
    const canonical = await canonicalizeLocalPluginPath(link);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(await isWithinBundledPluginRoot(canonical.canonicalPath, root)).toBe(false);
    }
  });

  it("fails closed when the catalog root does not exist", async () => {
    const { inside } = await makeCatalogFixture();
    expect(await isWithinBundledPluginRoot(await realCanonical(inside), "/nonexistent/catalog/root")).toBe(false);
  });
});

/** realpath through the same lens the guard uses (macOS /tmp is a symlink). */
async function realCanonical(target: string): Promise<string> {
  const result = await canonicalizeLocalPluginPath(target);
  if (!result.ok) throw new Error(`fixture path did not canonicalize: ${result.reason}`);
  return result.canonicalPath;
}
