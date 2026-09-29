import { link, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryPiRuntimeFiles, PI_RUNTIME_MANIFEST_SCHEMA, verifyPiRuntimeManifest, type PiRuntimeManifest } from "./pi-verified-runtime.js";

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
