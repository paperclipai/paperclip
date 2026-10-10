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
  it("adopts an existing empty remote folder without reading or uploading the controller tree", async () => {
    const seedBytes = vi.fn();
    await seedPersistentAgentHome({ list: async () => [], seedBytes } as never, "/missing-controller-folder");
    expect(seedBytes).not.toHaveBeenCalled();
  });
  it("seeds absent personal storage once with exact binary bytes", async () => {
    const seedBytes = vi.fn(async () => ({ seeded: true }));
    await seedPersistentAgentHome({ list: async () => { throw { code: "not_found" }; }, seedBytes } as never, await local());
    expect(seedBytes).toHaveBeenCalledWith({ "AGENTS.md": Buffer.from("instructions"), "memory/binary.bin": Buffer.from([0, 255, 1]) });
  });
  it("does not interpret provider outages as an absent directory", async () => {
    const seedBytes = vi.fn();
    await expect(seedPersistentAgentHome({ list: async () => { throw new Error("offline"); }, seedBytes } as never, await local())).rejects.toThrow("offline");
    expect(seedBytes).not.toHaveBeenCalled();
  });
  it("rejects symlinked initial files before any upload", async () => {
    const root = await local();
    await fs.symlink(path.join(root, "AGENTS.md"), path.join(root, "alias.md"));
    const seedBytes = vi.fn();
    await expect(seedPersistentAgentHome({ list: async () => { throw { code: "not_found" }; }, seedBytes } as never, root)).rejects.toThrow("links or special files");
    expect(seedBytes).not.toHaveBeenCalled();
  });
});
