import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CursorCloudCheckpointStore } from "./checkpoint.js";
import { CURSOR_CLOUD_STAGING_MAX_ALLOCATIONS, CURSOR_CLOUD_STAGING_MAX_BYTES, reserveCursorCloudArtifactStaging } from "./artifact-staging-budget.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...children].map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => {
    child.once("exit", () => resolve()); child.kill("SIGKILL");
  })));
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const MiB = 1_048_576;
const schema = "paperclip.cursor-cloud.artifact-budget.v1";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = await mkdtemp("/tmp/cc-budget-"); roots.push(root);
  const runtimeDirectory = join(root, "runtime"); await mkdir(runtimeDirectory, { mode: 0o700 });
  const artifactRoot = join(root, "artifacts");
  const directory = join(runtimeDirectory, ".artifact-staging-budget");
  const usage = join(directory, "usage.json");
  const store = new CursorCloudCheckpointStore(directory, "budget");
  const reserve = (byteSize: number, signal = new AbortController().signal) => reserveCursorCloudArtifactStaging({ runtimeDirectory, artifactRoot, byteSize, signal });
  const budget = async () => JSON.parse(await readFile(usage, "utf8"));
  const seed = async (allocations: number, reservedBytes: number) => {
    await reserve(0); await writeFile(usage, JSON.stringify({ schema, allocations, reservedBytes }), { mode: 0o600 });
  };
  return { root, runtimeDirectory, artifactRoot, directory, usage, store, reserve, budget, seed };
}

async function worker(f: Awaited<ReturnType<typeof fixture>>, byteSize: number) {
  const workerRoot = await mkdtemp(join(f.root, "worker-"));
  const script = join(workerRoot, "reserve.mjs");
  const source = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "artifact-staging-budget.ts")).href;
  const input = JSON.stringify({ runtimeDirectory: f.runtimeDirectory, artifactRoot: f.artifactRoot, byteSize });
  await writeFile(script, `import { reserveCursorCloudArtifactStaging } from ${JSON.stringify(source)};
process.once('message', async () => {
  try { await reserveCursorCloudArtifactStaging({ ...${input}, signal: new AbortController().signal }); process.send({ ok: true }); }
  catch (error) { process.send({ ok: false, error: String(error) }); }
  finally { process.disconnect(); }
});
process.send({ ready: true });
`, { mode: 0o600 });
  const loader = createRequire(import.meta.url).resolve("tsx");
  const child = spawn(process.execPath, ["--import", loader, script], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child); let stderr = ""; child.stderr!.on("data", value => { stderr += value; });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.on("message", value => { if ((value as { ready?: boolean }).ready) resolve(); });
    child.once("exit", code => { if (code !== 0) reject(new Error(`Worker exited ${code}: ${stderr}`)); });
  });
  const result = new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    child.on("message", value => { if (typeof (value as { ok?: boolean }).ok === "boolean") resolve(value as { ok: boolean; error?: string }); });
    child.once("error", reject);
    child.once("exit", code => { if (code !== 0) reject(new Error(`Worker exited ${code}: ${stderr}`)); });
  });
  const exited = new Promise<void>((resolve, reject) => child.once("exit", (code, signal) => {
    children.delete(child);
    if (code === 0 && signal === null) resolve(); else reject(new Error(`Worker exited ${code}/${signal}: ${stderr}`));
  }));
  void result.catch(() => {}); void exited.catch(() => {});
  await ready;
  return { run: async () => { child.send("reserve"); const value = await result; await exited; return value; } };
}

describe("Cursor Cloud persistent artifact staging budget", () => {
  it("charges each allocation including zero bytes and releases ownership before returning", async () => {
    expect(CURSOR_CLOUD_STAGING_MAX_BYTES).toBe(256 * MiB);
    expect(CURSOR_CLOUD_STAGING_MAX_ALLOCATIONS).toBe(256);
    const f = await fixture(); await f.reserve(0); await f.reserve(7);
    expect(await f.budget()).toEqual({ schema, allocations: 2, reservedBytes: 7 });
    expect((await lstat(f.usage)).mode & 0o077).toBe(0);
    await expect(lstat(`${f.store.path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${f.store.path}.lock.acquire`)).rejects.toMatchObject({ code: "ENOENT" });
    await f.store.acquire(); await f.store.release();
  });

  it("serializes concurrent byte reservations at the exact aggregate limit", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 19 }, () => f.reserve(16 * MiB)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(16);
    expect(await f.budget()).toEqual({ schema, allocations: 16, reservedBytes: 256 * MiB });
    await expect(f.reserve(1)).rejects.toThrow();
    await f.reserve(0);
    expect(await f.budget()).toEqual({ schema, allocations: 17, reservedBytes: 256 * MiB });
  });

  it("bounds concurrent zero-byte import attempts by allocation count", async () => {
    const f = await fixture(); await f.seed(254, 9);
    const results = await Promise.allSettled(Array.from({ length: 7 }, () => f.reserve(0)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(await f.budget()).toEqual({ schema, allocations: 256, reservedBytes: 9 });
    const before = await readFile(f.usage, "utf8"); await expect(f.reserve(0)).rejects.toThrow();
    expect(await readFile(f.usage, "utf8")).toBe(before);
  });

  it.each(["allocation", "byte"])("prevents independent processes from reserving the last %s twice", async limit => {
    const f = await fixture(); await f.seed(limit === "allocation" ? 255 : 0, limit === "allocation" ? 4 : 256 * MiB - 1);
    const workers = await Promise.all(Array.from({ length: 4 }, () => worker(f, 1)));
    const results = await Promise.all(workers.map(value => value.run()));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(await f.budget()).toEqual({ schema, allocations: limit === "allocation" ? 256 : 1, reservedBytes: limit === "allocation" ? 5 : 256 * MiB });
    await expect(f.reserve(limit === "allocation" ? 0 : 1)).rejects.toThrow();
  }, 10_000);

  it("retains charged reservations across independent process restarts", async () => {
    const f = await fixture(); await f.reserve(3);
    expect(await (await worker(f, 5)).run()).toEqual({ ok: true });
    expect(await (await worker(f, 7)).run()).toEqual({ ok: true });
    expect(await f.budget()).toEqual({ schema, allocations: 3, reservedBytes: 15 });
  }, 10_000);

  it("seeds existing private files and empty digest directories exactly once", async () => {
    const f = await fixture(); await mkdir(f.artifactRoot, { mode: 0o700 });
    const populated = join(f.artifactRoot, "a".repeat(64)); const empty = join(f.artifactRoot, "b".repeat(64));
    await mkdir(populated, { mode: 0o700 }); await mkdir(empty, { mode: 0o700 });
    await writeFile(join(populated, "one.txt"), "123", { mode: 0o600 });
    await writeFile(join(populated, "empty.txt"), "", { mode: 0o600 });
    await f.reserve(4); expect(await f.budget()).toEqual({ schema, allocations: 4, reservedBytes: 7 });
    await f.reserve(2); expect(await f.budget()).toEqual({ schema, allocations: 5, reservedBytes: 9 });
  });

  it("retains an abandoned staging reservation and refuses further imports", async () => {
    const f = await fixture(); await f.reserve(0); const before = await readFile(f.usage, "utf8");
    const path = join(f.directory, "usage.pending.tmp"); const bytes = "ambiguous reservation";
    await writeFile(path, bytes, { mode: 0o600 }); const identity = await lstat(path);
    await expect(f.reserve(1)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(bytes); expect(await readFile(f.usage, "utf8")).toBe(before);
    const after = await lstat(path); expect([after.dev, after.ino, after.mode]).toEqual([identity.dev, identity.ino, identity.mode]);
  });

  it.each([-1, 0.5, NaN, Infinity, 16 * MiB + 1])("rejects invalid reservation size %s without changing the ledger", async byteSize => {
    const f = await fixture(); await f.reserve(0); const before = await readFile(f.usage, "utf8");
    await expect(f.reserve(byteSize)).rejects.toThrow(); expect(await readFile(f.usage, "utf8")).toBe(before);
  });

  it.each(["{", JSON.stringify({ schema, allocations: -1, reservedBytes: 0 }), JSON.stringify({ schema, allocations: 257, reservedBytes: 0 }), JSON.stringify({ schema, allocations: 1, reservedBytes: 256 * MiB + 1 }), JSON.stringify({ schema, allocations: 0.5, reservedBytes: 0 }), JSON.stringify({ schema, allocations: 1, reservedBytes: 0, extra: true }), JSON.stringify({ schema: "foreign", allocations: 1, reservedBytes: 0 })])("preserves an unverifiable ledger (%s)", async bytes => {
    const f = await fixture(); await f.reserve(0); await writeFile(f.usage, bytes); const before = await lstat(f.usage);
    await expect(f.reserve(1)).rejects.toThrow(); expect(await readFile(f.usage, "utf8")).toBe(bytes);
    const after = await lstat(f.usage); expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  });

  it.each(["public", "symlink", "hardlink"])("preserves a %s ledger and its target", async mode => {
    const f = await fixture(); await f.reserve(0); const before = await readFile(f.usage, "utf8"); const target = join(f.root, "foreign-ledger");
    if (mode === "public") await chmod(f.usage, 0o644);
    if (mode === "symlink") { await rename(f.usage, target); await symlink(target, f.usage); }
    if (mode === "hardlink") await link(f.usage, target);
    const identity = await lstat(f.usage); await expect(f.reserve(1)).rejects.toThrow();
    expect(await readFile(f.usage, "utf8")).toBe(before);
    const after = await lstat(f.usage); expect([after.dev, after.ino, after.mode, after.nlink]).toEqual([identity.dev, identity.ino, identity.mode, identity.nlink]);
    if (mode !== "public") expect(await readFile(target, "utf8")).toBe(before);
  });

  it.each(["live-lock", "ambiguous-guard", "symlink-guard"])("refuses and preserves a foreign %s", async mode => {
    const f = await fixture(); await f.reserve(0); const before = await readFile(f.usage, "utf8");
    const path = `${f.store.path}.lock${mode === "live-lock" ? "" : ".acquire"}`;
    const bytes = mode === "ambiguous-guard" ? "{" : JSON.stringify({ pid: process.pid, token: "foreign-owner" });
    if (mode === "symlink-guard") { const target = join(f.root, "foreign-guard"); await writeFile(target, bytes, { mode: 0o600 }); await symlink(target, path); }
    else await writeFile(path, bytes, { mode: 0o600 });
    const identity = await lstat(path); await expect(f.reserve(1)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(bytes); expect(await readFile(f.usage, "utf8")).toBe(before);
    const after = await lstat(path); expect([after.dev, after.ino, after.mode]).toEqual([identity.dev, identity.ino, identity.mode]);
  });

  it.each(["write", "file-sync", "directory-sync", "parent-sync"])("cannot escape quota after a %s failure", async failure => {
    const f = await fixture(); await f.seed(255, 256 * MiB - 1); const before = await readFile(f.usage, "utf8");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); let openedTemporary = false; let injected = false;
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode); const temporary = String(path) === join(f.directory, "usage.pending.tmp");
      if (temporary) openedTemporary = true;
      const targetDirectory = failure === "directory-sync" ? f.directory : f.runtimeDirectory;
      return new Proxy(handle, { get(target, key) {
        if (!injected && temporary && key === (failure === "write" ? "writeFile" : failure === "file-sync" ? "sync" : "unused")) return async () => {
          injected = true; if (failure === "write") await target.writeFile("{"); throw new Error(`fixture ${failure} failure`);
        };
        if (!injected && openedTemporary && String(path) === targetDirectory && key === "sync" && ["directory-sync", "parent-sync"].includes(failure)) return async () => { injected = true; throw new Error(`fixture ${failure} failure`); };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof open);
    await expect(f.reserve(1)).rejects.toThrow(`fixture ${failure} failure`); expect(injected).toBe(true);
    vi.mocked(open).mockImplementation(original.open);
    if (["write", "file-sync"].includes(failure)) {
      expect(await readFile(f.usage, "utf8")).toBe(before); await f.reserve(1);
    }
    expect(await f.budget()).toEqual({ schema, allocations: 256, reservedBytes: 256 * MiB });
    await expect(f.reserve(0)).rejects.toThrow();
    expect((await readdir(f.directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("cancels a queued reservation without admitting it or releasing the active owner's quota", async () => {
    const f = await fixture(); const entered = deferred(); const resume = deferred();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); let held = false;
    vi.mocked(open).mockImplementation((async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode);
      return new Proxy(handle, { get(target, key) {
        if (!held && String(path) === join(f.directory, "usage.pending.tmp") && key === "writeFile") return async (...args: Parameters<typeof handle.writeFile>) => {
          held = true; entered.resolve(); await resume.promise; return target.writeFile(...args);
        };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof open);
    const active = f.reserve(1); const abort = new AbortController();
    try {
      await entered.promise; const cancelled = f.reserve(2, abort.signal); abort.abort(new Error("fixture queued cancellation"));
      await expect(cancelled).rejects.toThrow("fixture queued cancellation"); resume.resolve(); await active;
      await f.reserve(3); expect(await f.budget()).toEqual({ schema, allocations: 2, reservedBytes: 4 });
    } finally { resume.resolve(); await active.catch(() => {}); }
  });
});
