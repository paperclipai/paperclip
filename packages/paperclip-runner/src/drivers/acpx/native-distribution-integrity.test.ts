import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitVerifiedAcpxProviderExit, awaitVerifiedAcpxProviderOwnership, verifyNativeAcpxInstallation } from "./installation-integrity.js";
import { createNativeAcpxDistributionSnapshot, readNativeAcpxDistributionEntries, parseNativeAcpxDistributionEntries, type NativeAcpxDistributionInput, type NativeAcpxDistributionEntry } from "./native-distribution-integrity.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open), rm: vi.fn(original.rm), mkdir: vi.fn(original.mkdir), chmod: vi.fn(original.chmod) };
});

const roots: string[] = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { node?: boolean; script?: string } = {}): Promise<NativeAcpxDistributionInput> {
  const root = await mkdtemp(join(tmpdir(), "native-acpx-test-")); roots.push(root);
  const entries: NativeAcpxDistributionEntry[] = [];
  if (options.node) {
    await copyFile(process.execPath, join(root, "runtime")); await chmod(join(root, "runtime"), 0o700);
    const bytes = await readFile(join(root, "runtime")); entries.push({ path: "runtime", sha256: hash(bytes), size: bytes.length, executable: true });
    // Homebrew's test-host Node uses an @rpath libnode dylib. Include that
    // dependency in this fixture's closure instead of relying on its old path.
    const libraryRoot = join(dirname(process.execPath), "..", "lib");
    for (const name of (await readdir(libraryRoot).catch(() => [] as string[])).filter(name => /^libnode\..*\.dylib$/.test(name))) {
      await copyFile(join(libraryRoot, name), join(root, name)); await chmod(join(root, name), 0o600);
      const library = await readFile(join(root, name)); entries.push({ path: name, sha256: hash(library), size: library.length, executable: false });
    }
    const script = options.script ?? 'console.log("qualified-entry");';
    await writeFile(join(root, "entry.cjs"), script, { mode: 0o600 });
    entries.push({ path: "entry.cjs", sha256: hash(script), size: Buffer.byteLength(script), executable: false });
  } else {
    const script = options.script ?? '#!/bin/sh\nprintf "native:%s:%s" "$1" "${COPILOT_PKG_CACHE_HOME:-none}"\n';
    await writeFile(join(root, "runtime"), script, { mode: 0o700 });
    entries.push({ path: "runtime", sha256: hash(script), size: Buffer.byteLength(script), executable: true });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifestPath = join(root, "closure.json");
  await writeFile(manifestPath, JSON.stringify({ entries }));
  return { distributionRoot: root, manifestPath, expectedClosureSha256: hash(JSON.stringify(entries)), executable: "runtime", ...(options.node ? { entrypoint: "entry.cjs" } : {}), fixedArguments: options.node ? [] : ["fixed"] };
}
async function manyFileFixture(sizes: number[]) {
  const declaration = await fixture();
  const entries = await readNativeAcpxDistributionEntries(declaration);
  for (let index = 0; index < sizes.length; index++) {
    const path = `file-${String(index).padStart(2, "0")}`;
    const bytes = Buffer.alloc(sizes[index]!, index + 1);
    await writeFile(join(declaration.distributionRoot, path), bytes, { mode: 0o600 });
    entries.push({ path, sha256: hash(bytes), size: bytes.length, executable: false });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  await writeFile(declaration.manifestPath, JSON.stringify({ entries }));
  return { declaration: { ...declaration, expectedClosureSha256: hash(JSON.stringify(entries)) }, entries };
}
async function directoryFixture() {
  const declaration = await fixture();
  const entries = await readNativeAcpxDistributionEntries(declaration);
  for (let index = 0; index < 40; index++) {
    const parent = `dir-${String(index).padStart(2, "0")}/nested`;
    await mkdir(join(declaration.distributionRoot, parent), { recursive: true });
    for (const name of ["a", "b"]) {
      const path = `${parent}/${name}`; const bytes = Buffer.from(path);
      await writeFile(join(declaration.distributionRoot, path), bytes, { mode: 0o600 });
      entries.push({ path, sha256: hash(bytes), size: bytes.length, executable: false });
    }
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  await writeFile(declaration.manifestPath, JSON.stringify({ entries }));
  return { declaration: { ...declaration, expectedClosureSha256: hash(JSON.stringify(entries)) }, entries };
}
async function filePrototype(path: string): Promise<FileHandle> {
  const probe = await open(path, "r"); const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close(); return prototype;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function output(child: ChildProcess): Promise<{ text: string; error: string; code: number | null }> {
  let text = ""; let error = "";
  child.stdout!.on("data", value => { text += String(value); });
  child.stderr!.on("data", value => { error += String(value); });
  const [code] = await once(child, "close") as [number | null];
  return { text, error, code };
}

describe("native ACPX execution closure", () => {
  it("rejects paths, ordering, oversized files and altered manifest pins", () => {
    const entry = { path: "runtime", sha256: "a".repeat(64), size: 10, executable: true };
    for (const entries of [[{ ...entry, path: "../escape" }], [{ ...entry, path: "/absolute" }], [entry, entry], [{ ...entry, size: 2 ** 40 }], [{ ...entry, unknown: 1 }]]) {
      expect(() => parseNativeAcpxDistributionEntries({ entries }, hash(JSON.stringify(entries)))).toThrow();
    }
    expect(() => parseNativeAcpxDistributionEntries({ entries: [entry] }, "b".repeat(64))).toThrow("manifest digest mismatch");
  });
  it("checks every file digest and refuses links at admission", async () => {
    const declaration = await fixture(); const installation = await verifyNativeAcpxInstallation(declaration);
    await writeFile(join(declaration.distributionRoot, "runtime"), "altered");
    await expect(installation.openCommand()).rejects.toThrow();
    await rm(join(declaration.distributionRoot, "runtime"));
    await symlink("closure.json", join(declaration.distributionRoot, "runtime"));
    await expect(installation.openCommand()).rejects.toThrow("symbolic link");
  });
  it.each(["fifo", "directory", "hardlink", "symlink", "size", "mode"] as const)(
    "rejects a %s swapped in immediately before open without reading it or leaking its descriptor", async kind => {
      const declaration = await fixture();
      const entries = await readNativeAcpxDistributionEntries(declaration);
      const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const source = await realpath(declaration.distributionRoot);
      const path = join(source, "runtime");
      const originalPath = join(source, "original");
      const prototype = await filePrototype(path);
      const read = vi.spyOn(prototype, "read");
      let opened: FileHandle | undefined; let closed = false;
      vi.mocked(open).mockImplementation(async (selected: any, flags: any, ...rest: any[]): Promise<any> => {
        if (String(selected) !== path) return original.open(selected, flags, rest[0]);
        expect(flags & constants.O_NOFOLLOW).not.toBe(0);
        expect(flags & constants.O_NONBLOCK).not.toBe(0);
        await rename(path, originalPath);
        if (kind === "fifo") execFileSync("mkfifo", [path], { timeout: 2_000 });
        else if (kind === "directory") await mkdir(path);
        else if (kind === "hardlink") await link(originalPath, path);
        else if (kind === "symlink") await symlink(originalPath, path);
        else {
          await copyFile(originalPath, path);
          if (kind === "size") await writeFile(path, "short");
          else await chmod(path, 0o600);
        }
        opened = await original.open(selected, flags, rest[0]);
        const close = opened.close.bind(opened);
        opened.close = async () => { await close(); closed = true; };
        return opened;
      });
      let unexpected: Awaited<ReturnType<typeof createNativeAcpxDistributionSnapshot>> | undefined;
      try {
        const error = await createNativeAcpxDistributionSnapshot(declaration, entries).then(
          value => { unexpected = value; return undefined; }, error => error);
        expect(error).toBeInstanceOf(Error);
        expect(read).not.toHaveBeenCalled();
        if (kind === "symlink") expect(opened).toBeUndefined();
        else { expect(opened).toBeDefined(); expect(closed).toBe(true); }
      } finally {
        vi.mocked(open).mockImplementation(original.open);
        if (unexpected) { await unexpected.commandDirectory.close(); await unexpected.snapshot.close(); }
      }
    });
  it("rejects a same-byte pathname replacement after reading the held descriptor", async () => {
    const declaration = await fixture(); const entries = await readNativeAcpxDistributionEntries(declaration);
    const path = join(declaration.distributionRoot, "runtime");
    const prototype = await filePrototype(path); const originalRead = prototype.read;
    let replaced = false;
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      const result = await originalRead.apply(this, args as never);
      if (!replaced) {
        replaced = true;
        await rename(path, path + ".original");
        await copyFile(path + ".original", path);
      }
      return result;
    });
    await expect(createNativeAcpxDistributionSnapshot(declaration, entries)).rejects.toThrow("changed while read");
    expect(replaced).toBe(true);
  });
  it("launches only fixed arguments from a frozen snapshot after installed files change", async () => {
    const declaration = await fixture(); const lease = await (await verifyNativeAcpxInstallation(declaration)).openCommand();
    expect(() => lease.spawn(["--untrusted-override"])).toThrow("fixed profile arguments");
    await writeFile(join(declaration.distributionRoot, "runtime"), "changed after lease");
    const result = await output(lease.spawn());
    expect(result).toEqual({ text: "native:fixed:none", error: "", code: 0 });
    expect(() => lease.spawn()).toThrow("closed");
    await lease.close();
  });
  it("gives packaged executables a fresh private extraction cache each launch", async () => {
    const declaration = { ...await fixture(), isolatedCacheEnvironmentName: "COPILOT_PKG_CACHE_HOME" as const };
    const install = await verifyNativeAcpxInstallation(declaration);
    const first = await output((await install.openCommand()).spawn([], { env: { COPILOT_PKG_CACHE_HOME: "/ambient/cache" } }));
    const second = await output((await install.openCommand()).spawn());
    expect(first.text).toMatch(/^native:fixed:.*paperclip-acpx-native-.*\/state$/);
    expect(first.text).not.toBe(second.text);
  });
  // Copy/hash the real Node closure and start its bootstrap + owned shim. These
  // operations share the adjacent native-closure test's bounded allowance;
  // Vitest's 5s default is not a provider startup or permission deadline.
  it("loads the owned Copilot distribution through a guarded private shim and ignores ambient overrides", async () => {
    const declaration = await fixture({ node: true });
    const entries = await readNativeAcpxDistributionEntries(declaration);
    await mkdir(join(declaration.distributionRoot, "distribution"));
    const source = 'console.log(JSON.stringify({owned:__dirname,dist:process.env.COPILOT_CLI_DIST_DIR,version:process.env.COPILOT_CLI_VERSION??null,options:process.env.NODE_OPTIONS??null}));';
    await writeFile(join(declaration.distributionRoot, "distribution/index.js"), source, { mode: 0o600 });
    entries.push({ path: "distribution/index.js", sha256: hash(source), size: Buffer.byteLength(source), executable: false });
    entries.sort((a, b) => a.path < b.path ? -1 : 1);
    await writeFile(declaration.manifestPath, JSON.stringify({ entries }));
    const owned = { ...declaration, entrypoint: undefined, expectedClosureSha256: hash(JSON.stringify(entries)), copilotDistributionDirectory: "distribution", fixedArguments: ["-e", 'require(process.env.COPILOT_CLI_DIST_DIR+"/index.js")'] };
    const installation = await verifyNativeAcpxInstallation(owned);
    const lease = await installation.openCommand();
    const result = await output(lease.spawn([], { env: { COPILOT_CLI_DIST_DIR: "/ambient/evil", COPILOT_CLI_VERSION: "99.0.0", NODE_OPTIONS: "--untrusted-option" } }));
    expect(result.code, result.error).toBe(0);
    const observed = JSON.parse(result.text);
    expect(observed.owned).toMatch(/paperclip-acpx-native-.*\/distribution\/distribution$/);
    expect(observed.dist).toBe(join(dirname(observed.owned), ".paperclip-copilot-entry"));
    expect(observed.version).toBeNull(); expect(observed.options).toBeNull();
    await lease.close();
    await expect(readNativeAcpxDistributionEntries({ ...owned, copilotDistributionDirectory: "../ambient" })).rejects.toThrow("launch declaration");
    await expect(readNativeAcpxDistributionEntries({ ...owned, copilotDistributionDirectory: "missing" })).rejects.toThrow("owned entrypoint");
    await expect(readNativeAcpxDistributionEntries({ ...owned, entrypoint: "entry.cjs" })).rejects.toThrow("launch declaration");
  }, 30_000);
  it("loads a pinned Node entrypoint while rejecting unqualified external modules", async () => {
    const declaration = await fixture({ node: true });
    const result = await output((await (await verifyNativeAcpxInstallation(declaration)).openCommand()).spawn());
    expect(result.code, result.error).toBe(0); expect(result.text).toBe("qualified-entry\n");
    const outside = join(declaration.distributionRoot, "outside.cjs"); await writeFile(outside, "module.exports='ambient';");
    const evil = await fixture({ node: true, script: `require(${JSON.stringify(outside)});` });
    const denied = await output((await (await verifyNativeAcpxInstallation(evil)).openCommand()).spawn());
    expect(denied.code).not.toBe(0); expect(denied.error).toContain("escaped its closed distribution");
  }, 30_000);
  it("creates each private parent once and seals every directory before returning", async () => {
    const { declaration, entries } = await directoryFixture();
    const creatingStart = vi.mocked(mkdir).mock.calls.length;
    const created = await createNativeAcpxDistributionSnapshot(declaration, entries);
    try {
      const root = created.snapshot.roots[0]!;
      const calls = vi.mocked(mkdir).mock.calls.slice(creatingStart).map(([path]) => String(path)).filter(path => path.startsWith(root));
      expect(calls).toHaveLength(81); expect(new Set(calls).size).toBe(81);
      for (const path of calls) expect((await stat(path)).mode & 0o777).toBe(0o500);
      for (const entry of entries) {
        const path = join(root, entry.path);
        expect(hash(await readFile(path))).toBe(entry.sha256);
        expect((await stat(path)).mode & 0o777).toBe(entry.executable ? 0o500 : 0o400);
      }
    } finally { await created.commandDirectory.close(); await created.snapshot.close(); }
  });
  it.each(["create", "seal"] as const)("bounds %s batches and drains failures before cleanup or further scheduling", async stage => {
    const { declaration, entries } = await directoryFixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const hold = gate(); let started = 0; let active = 0; let peak = 0; let settled = false;
    const removalStart = vi.mocked(rm).mock.calls.length;
    const operation = async (path: any, mode: any) => {
      const selected = stage === "create"
        ? /paperclip-acpx-native-.*\/distribution\/dir-\d+$/.test(String(path))
        : mode === 0o500;
      if (!selected) return stage === "create" ? original.mkdir(path, mode) : original.chmod(path, mode);
      const index = started++; active++; peak = Math.max(peak, active);
      try {
        if (index === 0) throw new Error(`fixture ${stage} failure`);
        await hold.promise;
        return stage === "create" ? await original.mkdir(path, mode) : await original.chmod(path, mode);
      } finally { active--; }
    };
    if (stage === "create") vi.mocked(mkdir).mockImplementation(operation as typeof mkdir);
    else vi.mocked(chmod).mockImplementation(operation as typeof chmod);
    const creating = createNativeAcpxDistributionSnapshot(declaration, entries);
    void creating.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(started).toBe(32));
      expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(32); expect(settled).toBe(false);
      expect(vi.mocked(rm).mock.calls.slice(removalStart).filter(([path]) => String(path).includes("paperclip-acpx-native-"))).toHaveLength(0);
    } finally { hold.release(); }
    try {
      await expect(creating).rejects.toThrow(`fixture ${stage} failure`);
      expect(active).toBe(0); expect(started).toBe(32);
      const removed = vi.mocked(rm).mock.calls.slice(removalStart).map(([path]) => String(path)).filter(path => path.includes("paperclip-acpx-native-"));
      expect(removed).toHaveLength(1);
      await expect(stat(removed[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.mocked(mkdir).mockImplementation(original.mkdir); vi.mocked(chmod).mockImplementation(original.chmod); }
  });
  it("copies concurrently within its descriptor bound and retains canonical manifest order", async () => {
    const { declaration, entries } = await manyFileFixture(Array.from({ length: 40 }, (_, index) => 100 + index));
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read;
    const hold = gate(); const sizes: number[] = []; let active = 0; let peak = 0;
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      sizes.push(args[0].length); active++; peak = Math.max(peak, active);
      try { await hold.promise; return await originalRead.apply(this, args as never); }
      finally { active--; }
    });
    const creating = createNativeAcpxDistributionSnapshot(declaration, entries);
    try {
      await vi.waitFor(() => expect(sizes).toHaveLength(32));
      expect(sizes.toSorted()).toEqual(Array.from({ length: 32 }, (_, index) => 100 + index));
    } finally { hold.release(); }
    const created = await creating;
    try {
      expect(peak).toBe(32);
      expect(Object.keys(created.snapshot.digests).slice(0, entries.length)).toEqual(entries.map(entry => join(created.snapshot.roots[0]!, entry.path)));
      for (const entry of entries) expect(hash(await readFile(join(created.snapshot.roots[0]!, entry.path)))).toBe(entry.sha256);
    } finally { await created.commandDirectory.close(); await created.snapshot.close(); }
  });
  it("uses released capacity while an earlier copy is still pending", async () => {
    const { declaration, entries } = await manyFileFixture(Array.from({ length: 40 }, (_, index) => 100 + index));
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read; const hold = gate(); let laterReached = false;
    let active = 0; let peak = 0;
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      active++; peak = Math.max(peak, active);
      try {
        if (args[0].length === 100) await hold.promise;
        if (args[0].length === 139) laterReached = true;
        return await originalRead.apply(this, args as never);
      } finally { active--; }
    });
    const creating = createNativeAcpxDistributionSnapshot(declaration, entries);
    let created: Awaited<typeof creating> | undefined;
    try {
      try { await vi.waitFor(() => expect(laterReached).toBe(true)); expect(active).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(32); }
      finally { hold.release(); created = await creating; }
      expect(Object.keys(created.snapshot.digests).slice(0, entries.length)).toEqual(entries.map(entry => join(created!.snapshot.roots[0]!, entry.path)));
    } finally { if (created) { await created.commandDirectory.close(); await created.snapshot.close(); } }
  });
  it("bounds simultaneous buffers and gives an oversized admitted file exclusive capacity", async () => {
    const mib = 1024 * 1024;
    const { declaration, entries } = await manyFileFixture([17 * mib, 17 * mib, 33 * mib]);
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read;
    const retained = new Map<FileHandle, number>(); const observed: number[] = [];
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      if (!retained.has(this)) {
        const file = this; const originalClose = file.close.bind(file);
        file.close = async () => { try { await originalClose(); } finally { retained.delete(file); } };
      }
      retained.set(this, args[0].length);
      const total = [...retained.values()].reduce((sum, size) => sum + size, 0); observed.push(total);
      expect(total).toBeLessThanOrEqual(Math.max(32 * mib, args[0].length));
      if (args[0].length > 32 * mib) expect(retained.size).toBe(1);
      return originalRead.apply(this, args as never);
    });
    const created = await createNativeAcpxDistributionSnapshot(declaration, entries);
    try { expect(Math.max(...observed)).toBe(33 * mib); }
    finally { await created.commandDirectory.close(); await created.snapshot.close(); }
  });
  it("drains every admitted copy before failed-snapshot cleanup and schedules no later batch", async () => {
    const { declaration, entries } = await manyFileFixture(Array.from({ length: 40 }, (_, index) => 91 + index));
    await writeFile(join(declaration.distributionRoot, "file-00"), Buffer.alloc(91, 99));
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read;
    const hold = gate(); const entered = gate(); const invalidClosed = gate();
    const readSizes: number[] = []; const removalStart = vi.mocked(rm).mock.calls.length;
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      const size = args[0].length; readSizes.push(size);
      if (size === 91) {
        const originalClose = this.close.bind(this);
        this.close = async () => { await originalClose(); invalidClosed.release(); };
        await entered.promise;
      }
      if (size !== 91) { entered.release(); await hold.promise; }
      return originalRead.apply(this, args as never);
    });
    const creating = createNativeAcpxDistributionSnapshot(declaration, entries);
    let settled = false;
    void creating.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered.promise; await invalidClosed.promise;
      expect(settled).toBe(false);
    } finally { hold.release(); }
    await expect(creating).rejects.toThrow("digest mismatch: file-00");
    expect(readSizes).not.toContain(123);
    const removals = vi.mocked(rm).mock.calls.slice(removalStart).map(([path]) => String(path)).filter(path => /paperclip-acpx-native-/.test(path));
    expect(removals).toHaveLength(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(stat(removals[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a source mutation while another file is being copied", async () => {
    const { declaration, entries } = await manyFileFixture([101, 102]);
    const prototype = await filePrototype(join(declaration.distributionRoot, "runtime"));
    const originalRead = prototype.read; const entered = gate(); const hold = gate();
    vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, ...args: any[]): Promise<any> {
      if (args[0].length === 101) { entered.release(); await hold.promise; }
      return originalRead.apply(this, args as never);
    });
    const creating = createNativeAcpxDistributionSnapshot(declaration, entries);
    const rejected = expect(creating).rejects.toThrow("changed while read");
    try {
      await entered.promise;
      await writeFile(join(declaration.distributionRoot, "file-00"), Buffer.alloc(101, 7));
    } finally { hold.release(); }
    await rejected;
  });
  it("uses the existing guardian ownership and provider-exit proof for native children", async () => {
    const declaration = await fixture({ script: '#!/bin/sh\nprintf "ready"\nwhile :; do sleep 1; done\n' });
    const fences = await Promise.all([listen(), listen()]);
    const fds = fences.map(server => (server as Server & { _handle?: { fd?: number } })._handle!.fd!);
    const owners: number[] = [];
    const child = (await (await verifyNativeAcpxInstallation(declaration)).openCommand()).spawn([], {}, {
      credentialFenceFds: [fds[0]!, fds[1]!], activateCredentialFenceOwner: async pid => { owners.push(pid); },
    });
    let stderr = ""; child.stderr!.on("data", value => { stderr += String(value); });
    try {
      await awaitVerifiedAcpxProviderOwnership(child);
      expect(owners).toEqual([child.pid]);
      const [chunk] = await once(child.stdout!, "data"); expect(String(chunk), stderr).toBe("ready");
      const exited = once(child, "exit"); child.kill(); await exited;
      await awaitVerifiedAcpxProviderExit(child);
    } finally {
      child.kill(); await Promise.all(fences.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    }
  }, 15_000);
});

async function listen(): Promise<Server> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); return server;
}
