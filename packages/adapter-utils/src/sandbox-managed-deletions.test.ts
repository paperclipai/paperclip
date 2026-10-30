import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { prepareSandboxManagedRuntime, type SandboxManagedRuntimeClient } from "./sandbox-managed-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function deletedFixture(names: string[], beforeDelete?: (remote: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-deletions-"));
  roots.push(root);
  const source = path.join(root, "source"), remote = path.join(root, "remote");
  await fs.mkdir(source);
  const git = (...args: string[]) => exec("git", ["-C", source, ...args]);
  await git("init");
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), "tracked content");
  }
  await git("add", "--", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture");
  for (const name of names) await fs.rm(path.join(source, name));
  const client: SandboxManagedRuntimeClient = {
    makeDir: async directory => { await fs.mkdir(directory, { recursive: true }); },
    writeFile: async (file, bytes) => { await fs.writeFile(file, Buffer.from(bytes)); },
    readFile: file => fs.readFile(file),
    listFiles: directory => fs.readdir(directory),
    remove: file => fs.rm(file, { recursive: true, force: true }),
    run: async command => { await exec("sh", ["-c", command]); },
    syncIn: async operations => {
      for (const operation of operations) {
        for (const mapping of operation.files) {
          await fs.mkdir(path.dirname(mapping.targetPath), { recursive: true });
          await fs.copyFile(mapping.sourcePath, mapping.targetPath);
        }
        for (const { command } of operation.postUploadCommands ?? []) {
          if (command.includes("xargs -0")) await beforeDelete?.(remote);
          await exec("sh", ["-c", command]);
        }
      }
      return { operations: [] };
    },
  };
  return { root, remote, prepare: () => prepareSandboxManagedRuntime({
    spec: { transport: "sandbox", provider: "test", sandboxId: "test", remoteCwd: remote, timeoutMs: 30_000, apiKey: null },
    client, adapterKey: "test", workspaceLocalDir: source,
  }) };
}

it("deletes multiple bounded batches with newline, whitespace, Unicode and leading-dash filenames", async () => {
  const names = [" space ", "line\nbreak", "-option", "雪-💾", "wild[?]*",
    ...Array.from({ length: 130 }, (_, index) => `nested/file-${index}`)];
  const fixture = await deletedFixture(names);
  const runtime = await fixture.prepare();
  try {
    for (const name of names) await expect(fs.lstat(path.join(fixture.remote, name))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await runtime.cleanupWorkspaceSnapshot(); }
});

it.each(["symlink", "non_directory"] as const)("rejects a %s ancestor before deleting any entry in its batch", async kind => {
  let outside: string;
  const fixture = await deletedFixture(["a-valid", "z-parent/secret"], async remote => {
    outside = path.join(path.dirname(remote), "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret"), "private content");
    await fs.rm(path.join(remote, "z-parent"), { recursive: true });
    if (kind === "symlink") await fs.symlink(outside, path.join(remote, "z-parent"));
    else await fs.writeFile(path.join(remote, "z-parent"), "blocker");
  });
  await expect(fixture.prepare()).rejects.toThrow();
  expect(await fs.readFile(path.join(outside!, "secret"), "utf8")).toBe("private content");
  expect(await fs.readFile(path.join(fixture.remote, "a-valid"), "utf8")).toBe("tracked content");
});
