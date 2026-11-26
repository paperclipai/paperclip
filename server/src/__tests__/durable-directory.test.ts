import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDurableDirectory } from "../lib/durable-directory.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("durable directory creation", () => {
  async function fixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-durable-directory-")));
    roots.push(root);
    return { root, directory: path.join(root, "instance", "recovery", "company") };
  }

  function observeSyncs(failOn?: string) {
    const synced: string[] = [];
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (args[0] === failOn) throw new Error("Injected directory fsync failure");
        await sync();
        synced.push(String(args[0]));
      });
      return handle;
    });
    return synced;
  }

  it.each([false, true])("flushes symlink targets and the directories containing each link (chained: %s)", async (chained) => {
    const { root } = await fixture();
    const targetParent = path.join(root, "storage");
    const target = path.join(targetParent, "new-home");
    const writtenParent = path.join(root, "configured");
    const links = path.join(root, "links");
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(writtenParent);
    await fs.mkdir(links);
    await fs.symlink("../storage/new-home", path.join(links, "middle"));
    const alias = path.join(writtenParent, "home");
    await fs.symlink(chained ? "../links/middle" : target, alias);
    const directory = path.join(alias, "recovery");
    const synced = observeSyncs();
    await ensureDurableDirectory(directory);
    expect(synced).toContain(targetParent);
    expect(synced).toContain(writtenParent);
    if (chained) expect(synced).toContain(links);
    expect(synced).toContain(path.join(target, "recovery"));
    synced.length = 0;
    await ensureDurableDirectory(directory);
    expect(synced).toEqual([]);
  });

  it("resolves parent components after following a symlink target", async () => {
    const { root } = await fixture();
    const storage = path.join(root, "storage");
    await fs.mkdir(path.join(storage, "nested"), { recursive: true });
    await fs.mkdir(path.join(storage, "home"));
    await fs.symlink(path.join(storage, "nested"), path.join(root, "through"));
    await fs.symlink("through/../home", path.join(root, "alias"));
    const synced = observeSyncs();
    await ensureDurableDirectory(path.join(root, "alias", "recovery"));
    expect(synced).toContain(storage);
    expect(synced).toContain(path.join(storage, "home", "recovery"));
  });

  it("invalidates the proof when a symlink moves the same leaf under a new parent", async () => {
    const { root } = await fixture();
    const original = path.join(root, "original");
    const parent = path.join(root, "new-parent");
    const alias = path.join(root, "alias");
    await fs.mkdir(original);
    await fs.symlink(original, alias);
    const directory = path.join(alias, "recovery");
    await ensureDurableDirectory(directory);
    const inode = (await fs.stat(directory)).ino;
    await fs.mkdir(parent);
    await fs.rename(original, path.join(parent, "moved"));
    await fs.unlink(alias);
    await fs.symlink(path.join(parent, "moved"), alias);
    expect((await fs.stat(directory)).ino).toBe(inode);
    const synced = observeSyncs();
    await ensureDurableDirectory(directory);
    expect(synced).toContain(parent);
  });

  it("retries failed real-parent flushes through a symlink", async () => {
    const { root } = await fixture();
    const parent = path.join(root, "storage");
    await fs.mkdir(path.join(parent, "home"), { recursive: true });
    const alias = path.join(root, "alias");
    await fs.symlink(path.join(parent, "home"), alias);
    const directory = path.join(alias, "recovery");
    observeSyncs(parent);
    await expect(ensureDurableDirectory(directory)).rejects.toThrow("Injected directory fsync failure");
    await expect(ensureDurableDirectory(directory)).rejects.toThrow("Injected directory fsync failure");
    vi.restoreAllMocks();
    const synced = observeSyncs();
    await ensureDurableDirectory(directory);
    expect(synced).toContain(parent);
  });

  it("flushes every created path entry and avoids ancestor fsyncs on subsequent writes", async () => {
    const { root, directory } = await fixture();
    const synced = observeSyncs();
    await ensureDurableDirectory(directory);
    expect(synced.slice(0, 4)).toEqual([directory, path.dirname(directory), path.join(root, "instance"), root]);
    synced.length = 0;
    await ensureDurableDirectory(directory);
    expect(synced).toEqual([]);
    await fs.rm(directory, { recursive: true });
    await ensureDurableDirectory(directory);
    expect(synced.slice(0, 4)).toEqual([directory, path.dirname(directory), path.join(root, "instance"), root]);
  });

  it("fails closed for existing storage beneath an unflushable ancestor", async () => {
    const { root, directory } = await fixture();
    const storage = path.join(root, "instance");
    await fs.mkdir(storage);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === root) throw Object.assign(new Error("execute-only ancestor"), { code: "EACCES" });
      return open(...args);
    });
    await expect(ensureDurableDirectory(directory)).rejects.toMatchObject({ code: "EACCES" });
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
  });

  it("requires permission to flush a newly created entry's parent, including on retry", async () => {
    const { root, directory } = await fixture();
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === root) throw Object.assign(new Error("write-only creation parent"), { code: "EACCES" });
      return open(...args);
    });
    await expect(ensureDurableDirectory(directory)).rejects.toMatchObject({ code: "EACCES" });
    // mkdir now succeeds without creating anything. Its first attempt still
    // owes a parent flush, so a retry cannot silently acknowledge that path.
    await expect(ensureDurableDirectory(directory)).rejects.toMatchObject({ code: "EACCES" });
    vi.restoreAllMocks();
    const synced = observeSyncs();
    await ensureDurableDirectory(directory);
    expect(synced).toContain(root);
  });

  it.each([
    { sibling: false, symlink: false }, { sibling: true, symlink: false },
    { sibling: false, symlink: true }, { sibling: true, symlink: true },
  ])("retains a failed parent flush across fresh processes ($sibling, symlink: $symlink)", async ({ sibling, symlink }) => {
    const { root, directory: original } = await fixture();
    let directory = original;
    let parent = root;
    if (symlink) {
      parent = path.join(root, "storage");
      await fs.mkdir(path.join(parent, "home"), { recursive: true });
      await fs.symlink(path.join(parent, "home"), path.join(root, "alias"));
      directory = path.join(root, "alias", "recovery", "company");
    }
    const source = new URL("../lib/durable-directory.ts", import.meta.url).href;
    const child = (target: string, fail: boolean) => spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", `
      import { promises as fs } from "node:fs";
      import { ensureDurableDirectory } from ${JSON.stringify(source)};
      const [directory, parent, fail] = process.argv.slice(1);
      const open = fs.open.bind(fs);
      fs.open = async (...args) => {
        if (fail === "true" && args[0] === parent) throw Object.assign(new Error("unflushed parent"), { code: "EACCES" });
        return open(...args);
      };
      try { await ensureDurableDirectory(directory); }
      catch (error) { console.error(error.code); process.exitCode = error.code === "EACCES" ? 23 : 1; }
    `, target, parent, String(fail)], { encoding: "utf8", timeout: 10000 });
    const first = child(directory, true);
    expect(first.stderr).toContain("EACCES");
    expect(first.status).toBe(23);
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
    const retryTarget = sibling ? path.join(path.dirname(directory), "other-company") : directory;
    const retry = child(retryTarget, true);
    expect(retry.status, retry.stderr).toBe(23);
    expect(retry.stderr).toContain("EACCES");
    const recovered = child(retryTarget, false);
    expect(recovered.status, recovered.stderr).toBe(0);
  });

  it("retries all ancestors after a failed flush even though mkdir already succeeded", async () => {
    const { root, directory } = await fixture();
    observeSyncs(root);
    await expect(ensureDurableDirectory(directory)).rejects.toThrow("Injected directory fsync failure");
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
    vi.restoreAllMocks();
    const synced = observeSyncs();
    await ensureDurableDirectory(directory);
    expect(synced).toContain(root);
    expect(synced).toContain(path.dirname(root));
  });

  it.each([false, true])("keeps a shared parent flush required for sibling writes (first call pending: %s)", async (concurrent) => {
    const { root, directory } = await fixture();
    const sibling = path.join(path.dirname(directory), "other-company");
    const open = fs.open.bind(fs);
    let releaseFirst!: () => void;
    let reachedParent!: () => void;
    const held = new Promise<void>(resolve => { releaseFirst = resolve; });
    const reached = new Promise<void>(resolve => { reachedParent = resolve; });
    let firstParent = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === root) {
        if (firstParent) {
          firstParent = false;
          reachedParent();
          if (concurrent) await held;
        }
        throw Object.assign(new Error("unflushed shared parent"), { code: "EACCES" });
      }
      return open(...args);
    });
    const first = ensureDurableDirectory(directory).then(() => null, error => error);
    try {
      await reached;
      if (!concurrent) expect(await first).toMatchObject({ code: "EACCES" });
      await expect(ensureDurableDirectory(sibling)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      releaseFirst();
      await first;
    }
    vi.restoreAllMocks();
    const synced = observeSyncs();
    await ensureDurableDirectory(sibling);
    expect(synced).toContain(root);
    await ensureDurableDirectory(directory);
    synced.length = 0;
    await ensureDurableDirectory(sibling);
    await ensureDurableDirectory(directory);
    expect(synced).toEqual([]);
  });
});
