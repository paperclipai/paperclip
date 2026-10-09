import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyHermesRuntimeFiles } from "./hermes-setup-integrity.js";

async function distribution(run: (root: string, pin: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-hermes-setup-test-")));
  try {
    await mkdir(join(root, "python/bin"), { recursive: true });
    const files = ["bridge.py", "entry.py", "python/bin/python3.12"];
    for (const path of files) {
      await writeFile(join(root, path), path.endsWith("python3.12") ? '#!/bin/sh\ntouch "$PWD/unexpected-spawn"\n' : "# verified\n");
      await chmod(join(root, path), path.endsWith("python3.12") ? 0o700 : 0o600);
    }
    const entries = await Promise.all(files.map(async path => ({
      path, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
      size: (await lstat(join(root, path))).size, executable: path.endsWith("python3.12"),
    })));
    await writeFile(join(root, "manifest.json"), JSON.stringify({ entries }));
    await run(root, createHash("sha256").update(JSON.stringify(entries)).digest("hex"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

it("checks intact runtime files without executing the interpreter", async () => {
  await distribution(async (root, pin) => {
    await verifyHermesRuntimeFiles(root, pin);
    await expect(lstat(join(root, "unexpected-spawn"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("rejects modified runtime bytes even with an unchanged valid manifest", async () => {
  await distribution(async (root, pin) => {
    await writeFile(join(root, "bridge.py"), "# modified\n");
    await expect(verifyHermesRuntimeFiles(root, pin)).rejects.toThrow("file digest mismatch");
  });
});

it("rejects a missing interpreter even with an unchanged valid manifest", async () => {
  await distribution(async (root, pin) => {
    await rm(join(root, "python/bin/python3.12"));
    await expect(verifyHermesRuntimeFiles(root, pin)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("rejects a symbolic link substituted for the native entrypoint", async () => {
  await distribution(async (root, pin) => {
    await rm(join(root, "entry.py"));
    await symlink("bridge.py", join(root, "entry.py"));
    await expect(verifyHermesRuntimeFiles(root, pin)).rejects.toThrow("symbolic link");
  });
});
