import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryPiRuntimeFiles, PI_RUNTIME_MANIFEST_SCHEMA, verifyPiRuntimeManifest, verifyPiRuntimeLayoutForNativeSnapshot, type PiRuntimeManifest } from "./pi-verified-runtime.js";

import { verifyNativeAcpxInstallation } from "./installation-integrity.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open), lstat: vi.fn(original.lstat), readdir: vi.fn(original.readdir) };
});

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-verified-")); temporary.push(root);
  await mkdir(join(root, "assets"));
  for (const name of ["node", "pi.js", "extension.js", "wrapper.js", "assets/native.node", "assets/image.wasm"]) await writeFile(join(root, name), `pinned:${name}`);
  const manifest: PiRuntimeManifest = { schema: PI_RUNTIME_MANIFEST_SCHEMA, node: "node", piEntrypoint: "pi.js", extension: "extension.js", wrapperEntrypoint: "wrapper.js", files: await inventoryPiRuntimeFiles(root) };
  return { root, manifest };
}

describe("Pi complete runtime manifest", () => {
  it("binds interpreter, Pi, extension, wrapper, native modules and resources", async () => {
    const { root, manifest } = await fixture();
    const result = await verifyPiRuntimeManifest(root, manifest);
    expect(result.environment.PAPERCLIP_PI_EXTENSION_PATH).toBe(await realpath(join(root, "extension.js")));
    expect(result.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await writeFile(join(root, "assets/image.wasm"), "replacement");
    await expect(verifyPiRuntimeManifest(root, manifest)).rejects.toThrow("package graph");
  });

  it("keeps exact traversal order and all file digests across concurrent hash batches", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a/large"), Buffer.alloc(2 * 1024 * 1024, 7));
    await writeFile(join(root, "a-after"), "after directory");
    const expected = new Map<string, string>();
    for (let index = 0; index < 33; index++) {
      const path = `batch-${String(index).padStart(2, "0")}`;
      const bytes = Buffer.alloc(index % 3 === 0 ? 512 * 1024 : index + 1, index);
      await writeFile(join(root, path), bytes);
      expected.set(path, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    }
    const first = await inventoryPiRuntimeFiles(root);
    expect(first.slice(0, 2).map(entry => entry.path)).toEqual(["a/large", "a-after"]);
    for (const [path, digest] of expected) expect(first.find(entry => entry.path === path)?.sha256).toBe(digest);
    expect(await inventoryPiRuntimeFiles(root)).toEqual(first);
    const manifest: PiRuntimeManifest = { schema: PI_RUNTIME_MANIFEST_SCHEMA, node: "node", piEntrypoint: "pi.js", extension: "extension.js", wrapperEntrypoint: "wrapper.js", files: first };
    await writeFile(join(root, "batch-32"), "changed");
    await expect(verifyPiRuntimeManifest(root, manifest)).rejects.toThrow("package graph");
  });

  it("bounds live hash descriptors and drains a failed batch before rejecting", async () => {
    const { root } = await fixture();
    for (let index = 0; index < 40; index++) await writeFile(join(root, `batch-${index}`), "checked bytes");
    const probe = await open(join(root, "node"), "r"); const prototype = Object.getPrototypeOf(probe) as FileHandle; await probe.close();
    const originalStream = prototype.createReadStream;
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let started = 0; let active = 0; let peak = 0; let settled = false;
    vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: FileHandle, options): any {
      const file = this; const index = started++; const originalClose = file.close.bind(file); let closed = false;
      active++; peak = Math.max(peak, active);
      file.close = async () => { try { await originalClose(); } finally { if (!closed) { closed = true; active--; } } };
      return (async function* () {
        if (index === 0) throw new Error("fixture hash read failure");
        await hold; yield* originalStream.call(file, options);
      })();
    });
    const inventory = inventoryPiRuntimeFiles(root);
    void inventory.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(started).toBe(32));
      expect(settled).toBe(false); expect(peak).toBeLessThanOrEqual(32);
    } finally { release(); }
    await expect(inventory).rejects.toThrow("fixture hash read failure");
    expect(active).toBe(0); expect(started).toBe(32);
  });

  it("bounds discovery and drains a failed batch before descent or later scheduling", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-pi-discovery-")); temporary.push(root);
    for (let index = 0; index < 40; index++) await writeFile(join(root, `file-${String(index).padStart(2, "0")}`), "data");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let active = 0; let peak = 0; let started = 0; let settled = false;
    vi.mocked(lstat).mockImplementation((async (path: any, options: any) => {
      if (String(path) === root) return original.lstat(path, options);
      const index = started++; active++; peak = Math.max(peak, active);
      try {
        if (index === 0) throw new Error("fixture discovery failure");
        await hold; return await original.lstat(path, options);
      } finally { active--; }
    }) as typeof lstat);
    const inventory = inventoryPiRuntimeFiles(root);
    void inventory.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(started).toBe(32));
      expect(peak).toBeLessThanOrEqual(32); expect(peak).toBeGreaterThan(1); expect(settled).toBe(false);
    } finally { release(); }
    try {
      await expect(inventory).rejects.toThrow("fixture discovery failure");
      expect(active).toBe(0); expect(started).toBe(32);
    } finally { vi.mocked(lstat).mockImplementation(original.lstat); }
  });

  it("rechecks queued directories after earlier subtrees and never descends into a replacement symlink", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-discovery-race-"))); temporary.push(root);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "paperclip-pi-outside-"))); temporary.push(outside);
    await mkdir(join(root, "a")); await mkdir(join(root, "b"));
    await writeFile(join(root, "a/trigger"), "inside"); await writeFile(join(outside, "private"), "must not read");
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let replaced = false;
    const readsStart = vi.mocked(readdir).mock.calls.length;
    vi.mocked(lstat).mockImplementation((async (path: any, options: any) => {
      if (String(path) === join(root, "a/trigger") && !replaced) {
        replaced = true;
        await rename(join(root, "b"), join(root, "b-retired"));
        await symlink(outside, join(root, "b"));
      }
      return original.lstat(path, options);
    }) as typeof lstat);
    try {
      await expect(inventoryPiRuntimeFiles(root)).rejects.toThrow("directory changed before traversal");
      expect(replaced).toBe(true);
      const visited = vi.mocked(readdir).mock.calls.slice(readsStart).map(([path]) => String(path));
      expect(visited).not.toContain(join(root, "b")); expect(visited).not.toContain(outside);
    } finally { vi.mocked(lstat).mockImplementation(original.lstat); }
  });

  it("refuses unrecorded resources and duplicate manifest entries", async () => {
    const { root, manifest } = await fixture();
    await writeFile(join(root, "extra.js"), "untrusted");
    await expect(verifyPiRuntimeManifest(root, manifest)).rejects.toThrow("package graph");
    manifest.files.push(manifest.files[0]!);
    await expect(verifyPiRuntimeManifest(root, manifest)).rejects.toThrow("entry");
  });

  it("allows only in-pack relative links and rejects hardlinked mutable files", async () => {
    const { root, manifest } = await fixture();
    await symlink("assets", join(root, "resources"));
    manifest.files = await inventoryPiRuntimeFiles(root);
    await expect(verifyPiRuntimeManifest(root, manifest)).resolves.toHaveProperty("manifestDigest");
    await symlink(tmpdir(), join(root, "escape"));
    await expect(inventoryPiRuntimeFiles(root)).rejects.toThrow("escapes");
    await rm(join(root, "escape"));
    await link(join(root, "pi.js"), join(root, "hardlink.js"));
    await expect(inventoryPiRuntimeFiles(root)).rejects.toThrow("writable name");
  });
});

async function nativeFixture() {
  const { root, manifest } = await fixture();
  await chmod(join(root, "node"), 0o500);
  const entries = await Promise.all(manifest.files.map(async entry => ({
    path: entry.path, sha256: entry.sha256.slice(7), size: (await lstat(join(root, entry.path))).size,
    executable: entry.path === "node",
  })));
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const closure = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const manifestPath = root + "-native.json"; temporary.push(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ entries }));
  const input = { distributionRoot: root, manifestPath, expectedClosureSha256: closure, executable: "node", entrypoint: "wrapper.js", fixedArguments: [] };
  return { root, manifest, entries, closure, input };
}

describe("Pi native launch layout admission", () => {
  it("cross-binds declarations without opening content, then freshly hashes every command snapshot", async () => {
    const f = await nativeFixture();
    const expected = await verifyPiRuntimeManifest(f.root, f.manifest);
    vi.mocked(open).mockClear();
    expect(await verifyPiRuntimeLayoutForNativeSnapshot(f.root, f.manifest, { entries: f.entries }, f.closure)).toEqual({ manifestDigest: expected.manifestDigest });
    expect(open).not.toHaveBeenCalled();
    const installation = await verifyNativeAcpxInstallation(f.input);
    const lease = await installation.openCommand(); await lease.close();
    const opened = vi.mocked(open).mock.calls.map(([path]) => String(path));
    for (const entry of f.entries) expect(opened).toContain(join(await realpath(f.root), entry.path));
    // No cached installation verdict may authorize a later mutable source.
    await writeFile(join(f.root, "wrapper.js"), "x".repeat(f.entries.find(e => e.path === "wrapper.js")!.size));
    await expect(installation.openCommand()).rejects.toThrow("digest mismatch");
  });

  it("rejects a substituted native pin and any Pi/native declaration disagreement", async () => {
    const f = await nativeFixture();
    await expect(verifyPiRuntimeLayoutForNativeSnapshot(f.root, f.manifest, { entries: f.entries }, "0".repeat(64))).rejects.toThrow("manifest digest mismatch");
    const altered = structuredClone(f.manifest); altered.files[0]!.sha256 = `sha256:${"0".repeat(64)}`;
    await expect(verifyPiRuntimeLayoutForNativeSnapshot(f.root, altered, { entries: f.entries }, f.closure)).rejects.toThrow("pinned native closure");
    altered.files.shift();
    await expect(verifyPiRuntimeLayoutForNativeSnapshot(f.root, altered, { entries: f.entries }, f.closure)).rejects.toThrow("pinned native closure");
  });

  it("rejects extra or missing files during complete structural discovery", async () => {
    const f = await nativeFixture();
    await writeFile(join(f.root, "extra"), "not admitted");
    await expect(verifyPiRuntimeLayoutForNativeSnapshot(f.root, f.manifest, { entries: f.entries }, f.closure)).rejects.toThrow("package graph");
    await rm(join(f.root, "extra")); await rm(join(f.root, "assets/image.wasm"));
    await expect(verifyPiRuntimeLayoutForNativeSnapshot(f.root, f.manifest, { entries: f.entries }, f.closure)).rejects.toThrow("package graph");
  });

  it("rejects links even when their names appear in the pinned closure", async () => {
    const f = await nativeFixture();
    await rm(join(f.root, "pi.js")); await symlink("wrapper.js", join(f.root, "pi.js"));
    await expect(verifyPiRuntimeLayoutForNativeSnapshot(f.root, f.manifest, { entries: f.entries }, f.closure)).rejects.toThrow("package graph");
    await rm(join(f.root, "pi.js")); await link(join(f.root, "wrapper.js"), join(f.root, "pi.js"));
    await expect(verifyPiRuntimeLayoutForNativeSnapshot(f.root, f.manifest, { entries: f.entries }, f.closure)).rejects.toThrow("writable name");
  });

  it("never treats layout success as byte admission for same-size corruption", async () => {
    const f = await nativeFixture();
    await writeFile(join(f.root, "wrapper.js"), "x".repeat(f.entries.find(e => e.path === "wrapper.js")!.size));
    await expect(verifyPiRuntimeLayoutForNativeSnapshot(f.root, f.manifest, { entries: f.entries }, f.closure)).resolves.toHaveProperty("manifestDigest");
    // The independent generic verifier retains its original full-byte guarantee.
    await expect(verifyPiRuntimeManifest(f.root, f.manifest)).rejects.toThrow("package graph");
    const installation = await verifyNativeAcpxInstallation(f.input);
    await expect(installation.openCommand()).rejects.toThrow("digest mismatch");
  });

  it("rechecks source identities after layout, before granting any command lease", async () => {
    const f = await nativeFixture();
    await verifyPiRuntimeLayoutForNativeSnapshot(f.root, f.manifest, { entries: f.entries }, f.closure);
    const installation = await verifyNativeAcpxInstallation(f.input);
    await rm(join(f.root, "wrapper.js")); await symlink("pi.js", join(f.root, "wrapper.js"));
    await expect(installation.openCommand()).rejects.toThrow("symbolic link");
  });
});
