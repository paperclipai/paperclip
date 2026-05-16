import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  assertConfiguredLocalFolder,
  assertWritableConfiguredLocalFolder,
  inspectPluginLocalFolder,
  listPluginLocalFolderEntries,
  preparePluginLocalFolder,
  readPluginLocalFolderText,
  resolvePluginLocalFolderPath,
  deletePluginLocalFolderFile,
  writePluginLocalFolderTextAtomic,
} from "../services/plugin-local-folders.js";

describe("plugin local folders", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-folder-"));
    tempRoots.push(root);
    return root;
  }

  it("reports a healthy generic folder when required paths exist", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "sources"));
    await fs.writeFile(path.join(root, "schema.md"), "schema", "utf8");

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredDirectories: ["sources"],
        requiredFiles: ["schema.md"],
      },
    });

    expect(status.healthy).toBe(true);
    expect(status.problems).toEqual([]);
    expect(status.requiredDirectories).toEqual(["sources"]);
    expect(status.requiredFiles).toEqual(["schema.md"]);
  });

  it("reports missing required folders and files without using product-specific branches", async () => {
    const root = await makeRoot();

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        requiredDirectories: ["sources"],
        requiredFiles: ["schema.md"],
      },
    });

    expect(status.healthy).toBe(false);
    expect(status.missingDirectories).toEqual(["sources"]);
    expect(status.missingFiles).toEqual(["schema.md"]);
    expect(status.problems.map((item) => item.code)).toEqual(
      expect.arrayContaining(["missing_directory", "missing_file"]),
    );
  });

  it("reports all required paths as missing when the configured root does not exist", async () => {
    const root = await makeRoot();
    const missingRoot = path.join(root, "missing-root");

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: missingRoot,
        requiredDirectories: ["sources"],
        requiredFiles: ["schema.md"],
      },
    });

    expect(status.healthy).toBe(false);
    expect(status.configured).toBe(true);
    expect(status.readable).toBe(false);
    expect(status.missingDirectories).toEqual(["sources"]);
    expect(status.missingFiles).toEqual(["schema.md"]);
    expect(status.problems.map((item) => item.code)).toContain("missing");
  });

  it("uses manifest declaration access and required paths over stored or caller overrides", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "manifest-dir"));
    await fs.writeFile(path.join(root, "manifest.md"), "schema", "utf8");

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      declaration: {
        folderKey: "content-root",
        displayName: "Content root",
        access: "read",
        requiredDirectories: ["manifest-dir"],
        requiredFiles: ["manifest.md"],
      },
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredDirectories: ["stored-dir"],
        requiredFiles: ["stored.md"],
      },
      overrideConfig: {
        access: "readWrite",
        requiredDirectories: ["override-dir"],
        requiredFiles: ["override.md"],
      },
    });

    expect(status.access).toBe("read");
    expect(status.writable).toBe(false);
    expect(status.requiredDirectories).toEqual(["manifest-dir"]);
    expect(status.requiredFiles).toEqual(["manifest.md"]);
    expect(status.healthy).toBe(true);
  });

  it("prepares required directories for a read-write folder without creating required files", async () => {
    const root = await makeRoot();

    await preparePluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredDirectories: ["sources", "wiki/concepts"],
        requiredFiles: ["schema.md"],
      },
    });

    await expect(fs.stat(path.join(root, "sources"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(root, "wiki/concepts"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(root, "schema.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredDirectories: ["sources", "wiki/concepts"],
        requiredFiles: ["schema.md"],
      },
    });
    expect(status.missingDirectories).toEqual([]);
    expect(status.missingFiles).toEqual(["schema.md"]);
  });

  it("allows write access to repair folders that are only missing required paths", async () => {
    const root = await makeRoot();
    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredFiles: ["schema.md"],
      },
    });

    expect(status.healthy).toBe(false);
    expect(() => assertConfiguredLocalFolder(status)).toThrow("Local folder is not healthy");
    expect(() => assertWritableConfiguredLocalFolder(status)).not.toThrow();

    await writePluginLocalFolderTextAtomic(root, "schema.md", "schema");
    const repaired = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        access: "readWrite",
        requiredFiles: ["schema.md"],
      },
    });
    expect(repaired.healthy).toBe(true);
  });

  it("rejects traversal outside the configured folder", async () => {
    const root = await makeRoot();

    await expect(resolvePluginLocalFolderPath(root, "../outside.txt")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("detects required symlinks that escape the configured folder", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fs.writeFile(path.join(outside, "secret.txt"), "nope", "utf8");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));

    const status = await inspectPluginLocalFolder({
      folderKey: "content-root",
      storedConfig: {
        path: root,
        requiredFiles: ["linked.txt"],
      },
    });

    expect(status.healthy).toBe(false);
    expect(status.problems.some((item) => item.code === "symlink_escape")).toBe(true);
  });

  it("writes files atomically under the root and can read them back", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "nested"));

    await writePluginLocalFolderTextAtomic(root, "nested/page.md", "hello");
    await writePluginLocalFolderTextAtomic(root, "nested/page.md", "updated");

    await expect(readPluginLocalFolderText(root, "nested/page.md")).resolves.toBe("updated");
    const leftovers = await fs.readdir(path.join(root, "nested"));
    expect(leftovers.filter((name) => name.includes(".paperclip-"))).toEqual([]);
  });

  it("returns the real folder key after deleting a file", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "stale.md"), "delete me", "utf8");

    const status = await deletePluginLocalFolderFile(root, "stale.md", "content-root");

    expect(status.folderKey).toBe("content-root");
    await expect(fs.stat(path.join(root, "stale.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists nested local folder entries without following symlink escapes", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fs.mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await fs.writeFile(path.join(root, "wiki/concepts/live.md"), "# Live\n", "utf8");
    await fs.writeFile(path.join(outside, "secret.md"), "# Secret\n", "utf8");
    await fs.symlink(outside, path.join(root, "wiki/outside"));

    const listing = await listPluginLocalFolderEntries(root, {
      relativePath: "wiki",
      recursive: true,
      maxEntries: 20,
    });

    expect(listing.entries.map((entry) => entry.path)).toContain("wiki/concepts/live.md");
    expect(listing.entries.map((entry) => entry.path)).not.toContain("wiki/outside/secret.md");
    expect(listing.truncated).toBe(false);
  });

  it("revalidates temp-file containment before writing atomic contents", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open");
    openSpy.mockImplementationOnce(async (file, flags, mode) => {
      await fs.rm(nested, { recursive: true, force: true });
      await fs.symlink(outside, nested);
      return originalOpen(file, flags, mode);
    });

    try {
      await expect(writePluginLocalFolderTextAtomic(root, "nested/page.md", "secret")).rejects.toMatchObject({
        status: 403,
      });
      await expect(fs.readFile(path.join(outside, "page.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      openSpy.mockRestore();
    }
  });
});
