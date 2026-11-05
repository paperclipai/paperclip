import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEnvironmentTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import plugin from "./plugin.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rm: vi.fn(original.rm) };
});

async function createLease() {
  const definition = plugin.definition;
  const harness = createEnvironmentTestHarness({
    manifest,
    environmentDriver: {
      driverKey: "fake-plugin",
      onAcquireLease: definition.onEnvironmentAcquireLease,
      onReleaseLease: definition.onEnvironmentReleaseLease,
      onInspectLease: definition.onEnvironmentInspectLease,
      onDestroyLease: definition.onEnvironmentDestroyLease,
    },
  });
  const base = {
    driverKey: "fake-plugin",
    companyId: "company-cleanup",
    environmentId: randomUUID(),
    config: { image: "fake:cleanup", reuseLease: false },
  };
  const lease = await harness.acquireLease({ ...base, runId: randomUUID() });
  const root = lease.metadata?.fakeRootDir;
  const providerLeaseId = lease.providerLeaseId;
  if (typeof root !== "string") throw new Error("Fake lease did not identify its owned root");
  if (typeof providerLeaseId !== "string") throw new Error("Fake lease did not identify its provider lease");
  return { harness, root, params: { ...base, providerLeaseId } };
}

describe("fake sandbox lease cleanup", () => {
  it.each(["destroy", "release"] as const)("%s removes an empty unreadable directory", async (operation) => {
    const { harness, root, params } = await createLease();
    const unreadable = path.join(root, "workspace/unreadable");
    await mkdir(unreadable);
    await chmod(unreadable, 0o000);
    try {
      const result = operation === "destroy"
        ? await harness.destroyLease(params)
        : await harness.releaseLease(params);
      expect(result).toBeUndefined();
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await harness.inspectLease(params)).toMatchObject({ state: "destroyed" });
    } finally {
      await chmod(unreadable, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["destroy", "release"] as const)("%s removes sealed native runtime context", async (operation) => {
    const { harness, root, params } = await createLease();
    const instructions = path.join(root, "workspace/.paperclip-runtime/paperclip-runner/sessions/session/filesystem/context/instructions");
    const nested = path.join(instructions, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "AGENTS.md"), "Assigned immutable instructions", { mode: 0o444 });
    await chmod(nested, 0o555);
    await chmod(instructions, 0o555);
    try {
      const result = operation === "destroy"
        ? await harness.destroyLease(params)
        : await harness.releaseLease(params);
      expect(result).toBeUndefined();
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await harness.inspectLease(params)).toMatchObject({ state: "destroyed" });
    } finally {
      await chmod(instructions, 0o700).catch(() => undefined);
      await chmod(nested, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not change a symlink target outside the lease tree", async () => {
    const { harness, root, params } = await createLease();
    const outside = await mkdtemp(path.join(os.tmpdir(), "paperclip-fake-cleanup-outside-"));
    const target = path.join(outside, "sealed");
    const file = path.join(target, "instructions.md");
    await mkdir(target);
    await writeFile(file, "Unrelated instructions", { mode: 0o444 });
    await chmod(target, 0o500);
    await symlink(target, path.join(root, "workspace/outside-context"), "dir");
    const mode = (await stat(target)).mode;
    try {
      await harness.destroyLease(params);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(target)).mode).toBe(mode);
      expect(await readFile(file, "utf8")).toBe("Unrelated instructions");
      expect((await stat(file)).mode & 0o777).toBe(0o444);
    } finally {
      await chmod(target, 0o700);
      await rm(outside, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a failed cleanup for inspection and retry", async () => {
    const { harness, root, params } = await createLease();
    const failure = Object.assign(new Error("Injected removal failure"), { code: "EACCES" });
    vi.mocked(rm).mockRejectedValueOnce(failure);
    try {
      await expect(harness.destroyLease(params)).rejects.toBe(failure);
      expect(await harness.inspectLease(params)).toMatchObject({ state: "active" });
      expect((await stat(root)).isDirectory()).toBe(true);

      await expect(harness.destroyLease(params)).resolves.toBeUndefined();
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await harness.inspectLease(params)).toMatchObject({ state: "destroyed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a replaced root without changing it or forgetting the lease", async () => {
    const { harness, root, params } = await createLease();
    const retained = `${root}-retained`;
    await rename(root, retained);
    await mkdir(root);
    const file = path.join(root, "unrelated.txt");
    await writeFile(file, "Unrelated replacement");
    await chmod(root, 0o500);
    const mode = (await stat(root)).mode;
    try {
      await expect(harness.destroyLease(params)).rejects.toThrow("replaced fake sandbox lease root");
      expect(await harness.inspectLease(params)).toMatchObject({ state: "active" });
      expect((await stat(root)).mode).toBe(mode);
      expect(await readFile(file, "utf8")).toBe("Unrelated replacement");
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
      await rename(retained, root);
      await harness.destroyLease(params);
    }
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await harness.inspectLease(params)).toMatchObject({ state: "destroyed" });
  });
});
