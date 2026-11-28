import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceManifest } from "./workspace-manifest.js";
import {
  captureDirectorySnapshot, captureDirectorySnapshotOffThread,
  directorySnapshotSha256, disposeDirectorySnapshot, mergeDirectoryWithBaseline,
  type DirectorySnapshot,
} from "./workspace-restore-merge.js";

const roots: string[] = [];
const snapshots: DirectorySnapshot[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-thread-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(snapshots.splice(0).map(disposeDirectorySnapshot));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("workspace snapshot threads", () => {
  it("preserves snapshot entries, digest, exclusions, modes and links across the thread boundary", async () => {
    const root = await fixture(), outside = await fixture();
    await fs.mkdir(path.join(root, "nested"));
    for (let index = 0; index < 39; index++) {
      const name = path.join(root, index < 20 ? "" : "nested", `name ${index}\nbytes`);
      await fs.writeFile(name, Buffer.from(`entry ${index}\0content`));
      await fs.chmod(name, index % 2 ? 0o600 : 0o755);
    }
    await fs.writeFile(path.join(outside, "private"), "outside");
    await fs.symlink(outside, path.join(root, "outside-link"));
    await fs.writeFile(path.join(root, "excluded"), "excluded");
    await fs.writeFile(path.join(root, "ignored"), "ignored");
    const options = { exclude: ["excluded"], ignoredPaths: ["ignored"], diskBacked: true };
    const original = await captureDirectorySnapshot(root, options);
    snapshots.push(original);
    const isolated = await captureDirectorySnapshotOffThread(root, options);
    snapshots.push(isolated);
    expect(new Map(isolated.entries)).toEqual(new Map(original.entries));
    expect(directorySnapshotSha256(isolated)).toBe(directorySnapshotSha256(original));
    expect(isolated.entries.has("outside-link/private")).toBe(false);
    expect(await fs.readFile(path.join(outside, "private"), "utf8")).toBe("outside");
  });

  it("reads an existing ignored-path manifest without taking its cleanup ownership", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "kept"), "kept");
    await fs.mkdir(path.join(root, "ignored"));
    await fs.writeFile(path.join(root, "ignored", "private"), "ignored");
    const writer = await createWorkspaceManifest();
    roots.push(path.dirname(writer.filePath));
    writer.add("ignored", "ignored");
    const ignoredPaths = writer.paths("ignored");
    writer.close();
    const isolated = await captureDirectorySnapshotOffThread(root, { ignoredPaths, diskBacked: true });
    expect([...new Map(isolated.entries).keys()]).toEqual(["kept"]);
    await disposeDirectorySnapshot(isolated);
    expect((await fs.stat(ignoredPaths.filePath)).isFile()).toBe(true);
  });

  it("removes the worker's complete temporary directory when its snapshot is disposed", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "file"), "bytes");
    const created: string[] = [];
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
      const result = await mkdtemp(...args);
      if (typeof result === "string" && path.basename(result).startsWith("paperclip-snapshot-thread-")) created.push(result);
      return result;
    });
    const isolated = await captureDirectorySnapshotOffThread(root, { diskBacked: true });
    expect(created).toHaveLength(1);
    expect((await fs.stat(created[0]!)).isDirectory()).toBe(true);
    await disposeDirectorySnapshot(isolated);
    await expect(fs.stat(created[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Multiple real TypeScript worker cold starts can exceed the default 5s on
  // CI (three queued workers use two slots). These cases verify cleanup and
  // error propagation, not a worker startup deadline. Keep completion bounded.
  it("preserves filesystem errors, cleans failed workers and releases queued jobs", async () => {
    const root = await fixture();
    const file = path.join(root, "file");
    await fs.writeFile(file, "bytes");
    const created: string[] = [];
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
      const result = await mkdtemp(...args);
      if (typeof result === "string" && path.basename(result).startsWith("paperclip-snapshot-thread-")) created.push(result);
      return result;
    });
    const results = await Promise.allSettled([
      captureDirectorySnapshotOffThread(path.join(root, "missing"), { diskBacked: true }),
      captureDirectorySnapshotOffThread(file, { diskBacked: true }),
      captureDirectorySnapshotOffThread(root, { diskBacked: true }),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "ENOENT" } });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "ENOTDIR" } });
    expect(results[2].status).toBe("fulfilled");
    if (results[2].status === "fulfilled") await disposeDirectorySnapshot(results[2].value);
    expect(created).toHaveLength(3);
    for (const directory of created) await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it.each(["unchanged", "changed", "sparse"] as const)("isolates restore captures and cleans their manifests: %s", async mode => {
    const target = await fixture(), source = await fixture();
    await fs.writeFile(path.join(target, "file"), "before");
    const baseline = await captureDirectorySnapshot(target, { diskBacked: true });
    snapshots.push(baseline);
    await fs.writeFile(path.join(target, "concurrent"), "host bytes");
    await fs.writeFile(path.join(source, "file"), mode === "unchanged" ? "before" : "after");
    const supplied = mode === "sparse" ? await captureDirectorySnapshot(source, { diskBacked: true }) : undefined;
    if (supplied) snapshots.push(supplied);
    const created: string[] = [];
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
      const result = await mkdtemp(...args);
      if (typeof result === "string" && path.basename(result).startsWith("paperclip-snapshot-thread-")) created.push(result);
      return result;
    });
    await mergeDirectoryWithBaseline({
      baseline, sourceDir: source, targetDir: target, workspaceSnapshotIsolation: "worker",
      ...(supplied ? { snapshots: { source: supplied } } : {}),
    });
    expect(created).toHaveLength(mode === "changed" ? 2 : 1);
    expect(await fs.readFile(path.join(target, "file"), "utf8")).toBe(mode === "unchanged" ? "before" : "after");
    expect(await fs.readFile(path.join(target, "concurrent"), "utf8")).toBe("host bytes");
    for (const directory of created) await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("retains the in-memory snapshot contract when disk backing is not requested", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "file"), "bytes");
    const isolated = await captureDirectorySnapshotOffThread(root);
    snapshots.push(isolated);
    expect(isolated.entries).toBeInstanceOf(Map);
    expect(isolated.entries.size).toBe(1);
  });
});
