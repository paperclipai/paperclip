import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRunnerApiWorkspaceFile } from "./runner-api-files.js";

describe.skipIf(!["linux", "darwin"].includes(process.platform))("runner API confined workspace uploads", () => {
  it("reads regular files but rejects a substituted file or ancestor symlink", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "api-file-open-")));
    try {
      await mkdir(join(root, "allowed"));
      await mkdir(join(root, "outside"));
      await writeFile(join(root, "allowed", "file.txt"), "allowed");
      await writeFile(join(root, "outside", "file.txt"), "outside");
      const handle = await openRunnerApiWorkspaceFile(join(root, "allowed", "file.txt"));
      try { expect(await handle.readFile("utf8")).toBe("allowed"); } finally { await handle.close(); }
      await rm(join(root, "allowed", "file.txt"));
      await symlink(join(root, "outside", "file.txt"), join(root, "allowed", "file.txt"));
      await expect(openRunnerApiWorkspaceFile(join(root, "allowed", "file.txt"))).rejects.toThrow();
      await rm(join(root, "allowed"), { recursive: true });
      await symlink(join(root, "outside"), join(root, "allowed"));
      await expect(openRunnerApiWorkspaceFile(join(root, "allowed", "file.txt"))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
