import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ control: undefined as SharedArrayBuffer | undefined,
  mode: "" as "" | "cpu" | "abort" | "crash", spawned: 0, exited: 0, roots: [] as string[] }));
vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(source: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      if (state.control && typeof source === "string") {
        const setup = `const testControl=new Int32Array(workerData.testControl);`;
        source = source.replace("const archive=", `${setup}const archive=`);
        if (state.mode === "cpu") source = source.replace("const before = await walk(root, true);", `
          Atomics.add(testControl,0,1);
          while(!Atomics.load(testControl,1)) Atomics.add(testControl,2,1);
          const before = await walk(root, true);`);
        if (state.mode === "abort") {
          source = source.replace("const before = await walk(root, true);", `
            Atomics.store(testControl,0,1);
            await new Promise(resolve=>{input.signal.addEventListener('abort',resolve,{once:true});if(input.signal.aborted)resolve();});
            check();
            const before = await walk(root, true);`);
          source = source.replace(/await fs\.rm\(scratch,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\);?/, `
            Atomics.store(testControl,3,1);
            while(!Atomics.load(testControl,4)) await new Promise(resolve=>setTimeout(resolve,5));
            await fs.rm(scratch, { recursive: true, force: true });`);
        }
        if (state.mode === "crash") source = source.replace("const before = await walk(root, true);", `
          await fs.mkdir(path.join(scratch,'copied-repository'));
          await fs.writeFile(path.join(scratch,'copied-repository','retained'),'synthetic repository copy');
          process.exit(73);
          const before = await walk(root, true);`);
        options = { ...options, workerData: { ...options?.workerData, testControl: state.control } };
      }
      super(source, options);
      if (options?.env && typeof options.env === "object" && typeof options.env.TMPDIR === "string") state.roots.push(options.env.TMPDIR);
      state.spawned++;
      this.once("exit", () => { state.exited++; });
    }
  } };
});
import { captureRemoteWorkspaceDirectory, restoreRemoteWorkspaceArchive, workspaceArchive } from "./remote-workspace-snapshot-archive.js";

describe("workspace archive worker boundary", () => {
  let root: string, cwd: string;
  beforeEach(async () => {
    state.control = undefined; state.mode = ""; state.spawned = 0; state.exited = 0; state.roots = [];
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-archive-worker-test-"));
    cwd = path.join(root, "source"); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "saved.txt"), "retained work\n");
    await fs.mkdir(path.join(cwd, "nested"));
    await fs.writeFile(path.join(cwd, "nested", "bytes"), Buffer.alloc(1024 * 1024, 42));
    await fs.chmod(path.join(cwd, "saved.txt"), 0o751);
    await fs.symlink("saved.txt", path.join(cwd, "link"));
  });
  afterEach(async () => {
    if (state.control) { const control = new Int32Array(state.control); Atomics.store(control,1,1); Atomics.store(control,4,1); }
    await fs.rm(root, { recursive: true, force: true });
  });
  it("preserves exact archive bytes, manifest and restored files across real workers", async () => {
    const directPath = path.join(root, "direct.pcws"), archivePath = path.join(root, "worker.pcws");
    const direct = await workspaceArchive({ kind: "capture", cwd, archivePath: directPath });
    const captured = await captureRemoteWorkspaceDirectory({ cwd, archivePath });
    expect(captured).toEqual(direct);
    expect(await fs.readFile(archivePath)).toEqual(await fs.readFile(directPath));
    const targetDir = path.join(root, "restored");
    await expect(restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: direct.manifestDigest })).resolves.toEqual(direct);
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("retained work\n");
    expect((await fs.stat(path.join(targetDir, "saved.txt"))).mode & 0o777).toBe(0o751);
    expect(await fs.readlink(path.join(targetDir, "link"))).toBe("saved.txt");
    expect(createHash("sha256").update(await fs.readFile(path.join(targetDir, "nested", "bytes"))).digest("hex"))
      .toBe(createHash("sha256").update(await fs.readFile(path.join(cwd, "nested", "bytes"))).digest("hex"));
    expect(state.spawned).toBe(2); expect(state.exited).toBe(2);
  });
  it("runs CPU barriers on eight real workers while an aborted queued capture never spawns", async () => {
    state.control = new SharedArrayBuffer(5 * 4); state.mode = "cpu";
    const control = new Int32Array(state.control), controller = new AbortController(), reason = new Error("queued capture cancelled");
    const captures = Array.from({ length: 8 }, (_, i) => captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, `${i}.pcws`) }));
    const queued = captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "queued.pcws"), signal: controller.signal }).catch(error => error);
    try {
      await expect.poll(() => Atomics.load(control,0), { timeout: 10_000 }).toBe(8);
      expect(state.spawned).toBe(8); expect(state.exited).toBe(0);
      expect(Atomics.load(control,2)).toBeGreaterThan(0);
      controller.abort(reason);
      expect(await queued).toBe(reason); expect(state.spawned).toBe(8);
      Atomics.store(control,1,1);
      await Promise.all(captures);
      expect(state.exited).toBe(8);
      await expect(fs.access(path.join(root, "queued.pcws"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { Atomics.store(control,1,1); await Promise.allSettled(captures); }
  });
  it("removes parent-owned capture scratch after an abnormal worker exit", async () => {
    state.control = new SharedArrayBuffer(5 * 4); state.mode = "crash";
    await expect(captureRemoteWorkspaceDirectory({ cwd, archivePath: path.join(root, "crashed.pcws") }))
      .rejects.toThrow("remote_workspace_archive_worker_failed");
    expect(state.exited).toBe(1); expect(state.roots).toHaveLength(1);
    await expect(fs.access(state.roots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(cwd,"saved.txt"),"utf8")).toBe("retained work\n");
  });
  it("waits for abort cleanup and actual worker exit before rejecting or releasing its slot", async () => {
    state.control = new SharedArrayBuffer(5 * 4); state.mode = "abort";
    const control = new Int32Array(state.control), controller = new AbortController(), reason = new Error("owned capture cancelled");
    let settled = false;
    const archivePath = path.join(root, "cancelled.pcws");
    const capture = captureRemoteWorkspaceDirectory({ cwd, archivePath, signal: controller.signal }).then(
      () => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      await expect.poll(() => Atomics.load(control,0), { timeout: 10_000 }).toBe(1);
      controller.abort(reason);
      await expect.poll(() => Atomics.load(control,3), { timeout: 10_000 }).toBe(1);
      expect(settled).toBe(false); expect(state.exited).toBe(0);
      Atomics.store(control,4,1);
      expect(await capture).toBe(reason);
      expect(state.exited).toBe(1);
      await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { Atomics.store(control,4,1); controller.abort(reason); await capture; }
  });
});
