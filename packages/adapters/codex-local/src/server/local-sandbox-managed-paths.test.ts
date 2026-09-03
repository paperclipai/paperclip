import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCodexLocalSandboxManagedPaths } from "./local-sandbox-managed-paths.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

async function makeHomes() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-sandbox-paths-"));
  cleanup.push(root);
  const effectiveCodexHome = path.join(root, "managed-home");
  const sharedCodexHome = path.join(root, "shared-home");
  await fs.mkdir(effectiveCodexHome);
  await fs.mkdir(sharedCodexHome);
  return { root, effectiveCodexHome, sharedCodexHome };
}

describe("Codex local sandbox managed paths", () => {
  it("mounts the shared target of the managed auth symlink as read-only", async () => {
    const { effectiveCodexHome, sharedCodexHome } = await makeHomes();
    const sharedAuthPath = path.join(sharedCodexHome, "auth.json");
    await fs.writeFile(sharedAuthPath, "{}\n", { mode: 0o600 });
    await fs.symlink(sharedAuthPath, path.join(effectiveCodexHome, "auth.json"));

    await expect(resolveCodexLocalSandboxManagedPaths({
      effectiveCodexHome,
      sharedCodexHome,
      filesystemScope: "workspace",
    })).resolves.toEqual([
      { path: effectiveCodexHome, access: "rw" },
      { path: sharedAuthPath, access: "ro" },
    ]);
  });

  it("does not add a host path for a regular managed auth file", async () => {
    const { effectiveCodexHome, sharedCodexHome } = await makeHomes();
    await fs.writeFile(path.join(effectiveCodexHome, "auth.json"), "{}\n", { mode: 0o600 });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), "{}\n", { mode: 0o600 });

    await expect(resolveCodexLocalSandboxManagedPaths({
      effectiveCodexHome,
      sharedCodexHome,
      filesystemScope: "workspace",
    })).resolves.toEqual([
      { path: effectiveCodexHome, access: "rw" },
    ]);
  });

  it("does not expose an unrelated symlink target", async () => {
    const { root, effectiveCodexHome, sharedCodexHome } = await makeHomes();
    const unrelatedAuthPath = path.join(root, "unrelated-auth.json");
    await fs.writeFile(unrelatedAuthPath, "{}\n", { mode: 0o600 });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), "{}\n", { mode: 0o600 });
    await fs.symlink(unrelatedAuthPath, path.join(effectiveCodexHome, "auth.json"));

    await expect(resolveCodexLocalSandboxManagedPaths({
      effectiveCodexHome,
      sharedCodexHome,
      filesystemScope: "workspace",
    })).resolves.toEqual([
      { path: effectiveCodexHome, access: "rw" },
    ]);
  });

  it("keeps network-only launches on the existing managed-home mount", async () => {
    const { effectiveCodexHome, sharedCodexHome } = await makeHomes();
    const sharedAuthPath = path.join(sharedCodexHome, "auth.json");
    await fs.writeFile(sharedAuthPath, "{}\n", { mode: 0o600 });
    await fs.symlink(sharedAuthPath, path.join(effectiveCodexHome, "auth.json"));

    await expect(resolveCodexLocalSandboxManagedPaths({
      effectiveCodexHome,
      sharedCodexHome,
      filesystemScope: null,
    })).resolves.toEqual([
      { path: effectiveCodexHome, access: "rw" },
    ]);
  });
});
