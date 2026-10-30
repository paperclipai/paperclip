import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
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
});
