import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedPersistentAgentHome } from "./persistent-agent-files.js";

describe("persistent home initialization", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
  async function local() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "boat-agent-seed-")); roots.push(root);
    await fs.mkdir(path.join(root, "memory"));
    await fs.writeFile(path.join(root, "AGENTS.md"), "instructions");
    await fs.writeFile(path.join(root, "memory", "binary.bin"), Buffer.from([0, 255, 1]));
    return root;
  }
  it.each([false, true])("adopts existing remote storage without reading the controller tree (truncated: %s)", async truncated => {
    const seedFiles = vi.fn();
    await seedPersistentAgentHome({ listPage: async () => ({ entries: [], truncated }), seedFiles } as never, "/missing-controller-folder");
    expect(seedFiles).not.toHaveBeenCalled();
  });
  it("seeds absent personal storage once with exact binary bytes", async () => {
    const received: Record<string, Buffer> = {};
    const seedFiles = vi.fn(async (chunks: AsyncIterable<{ path: string; offset: number; bytes: Buffer }>) => {
      for await (const chunk of chunks) received[chunk.path] = Buffer.concat([received[chunk.path] ?? Buffer.alloc(0), chunk.bytes]);
      return { seeded: true };
    });
    await seedPersistentAgentHome({ listPage: async () => { throw { code: "not_found" }; }, seedFiles } as never, await local());
    expect(received).toEqual({ "AGENTS.md": Buffer.from("instructions"), "memory/binary.bin": Buffer.from([0, 255, 1]) });
  });
  it("streams large files in bounded chunks without importing runtime-owned files", async () => {
    const root = await local();
    const expected = Buffer.alloc(2 * 1024 * 1024 + 17, 93);
    await fs.writeFile(path.join(root, "large.bin"), expected);
    await fs.mkdir(path.join(root, ".paperclip-runtime"));
    await fs.writeFile(path.join(root, ".paperclip-runtime", "private"), "runtime material");
    await fs.mkdir(path.join(root, "memory", ".paperclip-runtime"));
    await fs.writeFile(path.join(root, "memory", ".paperclip-runtime", "user.txt"), "user content");
    const chunks: Buffer[] = [];
    const paths: string[] = [];
    let maxChunk = 0;
    await seedPersistentAgentHome({ listPage: async () => { throw { code: "not_found" }; }, seedFiles: async (stream: AsyncIterable<{ path: string; offset: number; bytes: Buffer }>) => {
      for await (const chunk of stream) {
        maxChunk = Math.max(maxChunk, chunk.bytes.length); paths.push(chunk.path);
        if (chunk.path === "large.bin") {
          expect(chunk.offset).toBe(chunks.reduce((total, b) => total + b.length, 0));
          chunks.push(Buffer.from(chunk.bytes));
        }
      }
    } } as never, root);
    expect(maxChunk).toBe(1024 * 1024);
    expect(chunks).toHaveLength(3);
    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(paths).not.toContain(".paperclip-runtime/private");
    expect(paths).toContain("memory/.paperclip-runtime/user.txt");
  });
  it("does not interpret provider outages as an absent directory", async () => {
    const seedFiles = vi.fn();
    await expect(seedPersistentAgentHome({ listPage: async () => { throw new Error("offline"); }, seedFiles } as never, await local())).rejects.toThrow("offline");
    expect(seedFiles).not.toHaveBeenCalled();
  });
  it("rejects symlinked initial files before any upload", async () => {
    const root = await local();
    await fs.symlink(path.join(root, "AGENTS.md"), path.join(root, "alias.md"));
    const seedFiles = vi.fn();
    await expect(seedPersistentAgentHome({ listPage: async () => { throw { code: "not_found" }; }, seedFiles } as never, root)).rejects.toThrow("links or special files");
    expect(seedFiles).not.toHaveBeenCalled();
  });
});
