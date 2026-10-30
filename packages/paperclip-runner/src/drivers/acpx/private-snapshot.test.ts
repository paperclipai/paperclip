import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  access,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAcpxPrivateSnapshot,
  MAX_ACPX_RUNTIME_EXECUTABLE_BYTES,
  type AcpxPrivateSnapshot,
} from "./private-snapshot.js";
import { dshSnapshotPathSkipped } from "./dsh-installation.js";
const roots: string[] = [];
const snapshots: AcpxPrivateSnapshot[] = [];
afterEach(async () => {
  await Promise.all(snapshots.splice(0).map((s) => s.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acpx-snapshot-test-"));
  roots.push(root);
  const source = join(root, "provider");
  await mkdir(source);
  await writeFile(join(source, "main.js"), "export const value = 1;");
  return { root, source };
}
describe("private ACPX package snapshots", () => {
  it("keeps admitted source immutable after the installation changes and cleans up", async () => {
    const { source } = await fixture();
    const snapshot = await createAcpxPrivateSnapshot([source], null);
    snapshots.push(snapshot);
    await writeFile(join(source, "main.js"), "throw new Error('replaced')");
    expect(await readFile(join(snapshot.roots[0]!, "main.js"), "utf8")).toBe(
      "export const value = 1;",
    );
    expect(snapshot.digests[join(snapshot.roots[0]!, "main.js")]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    await snapshot.close();
    await expect(access(snapshot.handoff.path)).rejects.toThrow();
  });
  it("does not grant access through links outside admitted package roots", async () => {
    const { root, source } = await fixture();
    const external = join(root, "outside.js");
    await writeFile(external, "secret");
    await symlink(external, join(source, "escape.js"));
    const snapshot = await createAcpxPrivateSnapshot([source], null);
    snapshots.push(snapshot);
    await expect(
      access(join(snapshot.roots[0]!, "escape.js")),
    ).rejects.toThrow();
  });
  it("rejects an oversized executable before allocating or reading it", async () => {
    const { root, source } = await fixture();
    const handle = await open(join(root, "oversized-runtime"), "w+");
    await handle.truncate(MAX_ACPX_RUNTIME_EXECUTABLE_BYTES + 1);
    const allocate = vi.spyOn(Buffer, "alloc");
    const read = vi.spyOn(handle, "read");
    try {
      await expect(createAcpxPrivateSnapshot([source], handle)).rejects.toThrow(
        "ACPX runtime executable must be a bounded executable file",
      );
      expect(allocate.mock.calls.every(([size]) => size <= MAX_ACPX_RUNTIME_EXECUTABLE_BYTES)).toBe(true);
      expect(read).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
      read.mockRestore();
      await handle.close();
    }
  });
  it("copies the executable from its verified open handle", async () => {
    const { root, source } = await fixture();
    const exe = join(root, "runtime");
    await writeFile(exe, "verified executable");
    const handle = await open(exe);
    try {
      const snapshot = await createAcpxPrivateSnapshot([source], handle);
      snapshots.push(snapshot);
      expect(await readFile(snapshot.executable!, "utf8")).toBe(
        "verified executable",
      );
    } finally {
      await handle.close();
    }
  });

  it("streams admitted bytes and links every admitted package root", async () => {
    const { root, source } = await fixture();
    const second = join(root, "second");
    await mkdir(second);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", type: "commonjs" }));
    await writeFile(join(second, "package.json"), JSON.stringify({ name: "second", type: "commonjs" }));
    await writeFile(join(source, "index.js"), "verified");
    await writeFile(join(source, "index.js.map"), "not-runtime-input");
    const snapshot = await createAcpxPrivateSnapshot([source, second], null, {
      streamingCopy: true,
      skipPath: path => path.endsWith(".map"),
    });
    snapshots.push(snapshot);
    expect(await readFile(join(snapshot.roots[0]!, "index.js"), "utf8")).toBe("verified");
    await expect(access(join(snapshot.roots[0]!, "index.js.map"))).rejects.toThrow();
    expect(await readFile(join(snapshot.roots[0]!, "node_modules", "second", "package.json"), "utf8")).toContain("second");
    expect(await readFile(join(snapshot.roots[1]!, "node_modules", "second", "package.json"), "utf8")).toContain("second");
    expect(snapshot.digests[join(snapshot.roots[0]!, "index.js")]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("recreates only the admitted package links instead of a full matrix", async () => {
    const { root, source } = await fixture();
    const second = join(root, "second");
    await mkdir(second);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", type: "commonjs" }));
    await writeFile(join(second, "package.json"), JSON.stringify({ name: "second", type: "commonjs" }));
    const snapshot = await createAcpxPrivateSnapshot([source, second], null, {
      streamingCopy: true,
      packageLinks: new Map([[await realpath(source), new Map([["second", await realpath(second)]])], [await realpath(second), new Map()]]),
    });
    snapshots.push(snapshot);
    expect(await readFile(join(snapshot.roots[0]!, "node_modules", "second", "package.json"), "utf8")).toContain("second");
    await expect(access(join(snapshot.roots[1]!, "node_modules", "second", "package.json"))).rejects.toThrow();
  });

  it("retries short writes until the admitted chunk is complete", async () => {
    const { source } = await fixture();
    await writeFile(join(source, "index.js"), "verified");
    const probe = await open(join(source, "index.js"));
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalWrite = prototype.write;
    const write = vi.spyOn(prototype, "write").mockImplementation(async function (this: any, ...args: any[]) {
      if (write.mock.calls.length === 1) return originalWrite.call(this, args[0], args[1], 1);
      return originalWrite.apply(this, args);
    });
    try {
      const snapshot = await createAcpxPrivateSnapshot([source], null, { streamingCopy: true });
      snapshots.push(snapshot);
      expect(await readFile(join(snapshot.roots[0]!, "index.js"), "utf8")).toBe("verified");
      expect(write.mock.calls.length).toBeGreaterThan(1);
    } finally { write.mockRestore(); }
  });

  it("aborts the read stream and cleans the partial snapshot", async () => {
    const before = (await readdir(tmpdir())).filter(name => name.startsWith("paperclip-acpx-")).sort();
    const { source } = await fixture();
    const controller = new AbortController();
    const probe = await open(join(source, "main.js"));
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const original = prototype.createReadStream;
    const createReadStream = vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: any, ...args: any[]) {
      controller.abort(new Error("admission deadline"));
      return original.apply(this, args);
    });
    try {
      await expect(createAcpxPrivateSnapshot([source], null, { streamingCopy: true, signal: controller.signal })).rejects.toThrow("admission deadline");
    } finally { createReadStream.mockRestore(); }
    const after = (await readdir(tmpdir())).filter(name => name.startsWith("paperclip-acpx-")).sort();
    expect(after).toEqual(before);
  });

  it("rejects file growth before writing beyond the admitted size", async () => {
    const before = (await readdir(tmpdir())).filter(name => name.startsWith("paperclip-acpx-")).sort();
    const { source } = await fixture();
    const probe = await open(join(source, "main.js"));
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const original = prototype.createReadStream;
    const createReadStream = vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: any, ...args: any[]) {
      appendFileSync(join(source, "main.js"), "growth");
      return original.apply(this, args);
    });
    try {
      await expect(createAcpxPrivateSnapshot([source], null, { streamingCopy: true })).rejects.toThrow("exceeded its admitted size");
    } finally { createReadStream.mockRestore(); }
    const after = (await readdir(tmpdir())).filter(name => name.startsWith("paperclip-acpx-")).sort();
    expect(after).toEqual(before);
  });

  it("applies DSH exclusions only within each package", async () => {
    const testParent = join(tmpdir(), "tests");
    await mkdir(testParent, { recursive: true });
    const parent = await mkdtemp(join(testParent, "dsh-provider-"));
    roots.push(parent);
    const source = join(parent, "provider");
    await mkdir(source);
    await mkdir(join(source, "__tests__"));
    await writeFile(join(source, "main.js"), "export const value = 1;");
    await writeFile(join(source, "__tests__", "fixture.js"), "export const fixture = true;");
    const snapshot = await createAcpxPrivateSnapshot([source], null, { skipPath: dshSnapshotPathSkipped });
    snapshots.push(snapshot);
    expect(await readFile(join(snapshot.roots[0]!, "main.js"), "utf8")).toBe("export const value = 1;");
    await expect(access(join(snapshot.roots[0]!, "__tests__", "fixture.js"))).rejects.toThrow();
    await writeFile(join(parent, "unrelated.txt"), "keep");
    await snapshot.close();
    expect(await readFile(join(parent, "unrelated.txt"), "utf8")).toBe("keep");
  });

  it("rejects an oversized module and cleans the partial snapshot", async () => {
    const before = (await readdir(tmpdir())).filter(name => name.startsWith("paperclip-acpx-")).sort();
    const { source } = await fixture();
    await writeFile(join(source, "index.js"), "too-large");
    await expect(createAcpxPrivateSnapshot([source], null, { streamingCopy: true, maxModuleBytes: 4 }))
      .rejects.toThrow("bounded regular file");
    const after = (await readdir(tmpdir())).filter(name => name.startsWith("paperclip-acpx-")).sort();
    expect(after).toEqual(before);
  });
});
