import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
// Resolve the script relative to THIS test file, not process.cwd(). Under vitest
// `projects`, cwd is the package directory (packages/adapters/claude-local), so a
// cwd-relative path silently misses the repo-root script and the whole conveyor
// test passes vacuously / fails to find the script. The script lives at the repo
// root (five levels up from src/server) in both the root repo and any synced
// worker checkout, so this resolution is stable across the conveyor.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(testDir, "../../../../../scripts/claude-local-workspace-sync.sh");

async function sh(command: string, args: string[], cwd?: string) {
  return execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function initRepo(dir: string) {
  await sh("git", ["init", "-q"], dir);
  await sh("git", ["config", "user.email", "paperclip-test@example.invalid"], dir);
  await sh("git", ["config", "user.name", "Paperclip Test"], dir);
}

describe("claude-local-workspace-sync.sh", () => {
  it("syncs only tracked source files, emits a patch, and leaves root unchanged until explicit apply", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-sync-"));
    const root = path.join(tmp, "root");
    const worker = path.join(tmp, "worker");
    const patch = path.join(tmp, "review.patch");
    await fs.mkdir(root);
    await fs.mkdir(worker);
    await initRepo(root);
    await initRepo(worker);

    await fs.writeFile(path.join(root, "README.md"), "root v1\n");
    await fs.writeFile(path.join(root, ".env"), "SECRET=do-not-copy\n");
    await sh("git", ["add", "README.md"], root);
    await sh("git", ["commit", "-qm", "initial"], root);

    await fs.writeFile(path.join(worker, "README.md"), "root v1\n");
    await sh("git", ["add", "README.md"], worker);
    await sh("git", ["commit", "-qm", "initial"], worker);

    await fs.writeFile(path.join(root, "README.md"), "root v2\n");
    await sh("bash", [scriptPath, "sync", "--root", root, "--worker", worker]);
    await expect(fs.readFile(path.join(worker, "README.md"), "utf8")).resolves.toBe("root v2\n");
    await expect(fs.access(path.join(worker, ".env"))).rejects.toThrow();

    await fs.writeFile(path.join(worker, "README.md"), "worker edit\n");
    await fs.writeFile(path.join(worker, "NEW.md"), "new worker file\n");
    await sh("bash", [scriptPath, "diff", "--root", root, "--worker", worker, "--patch", patch]);
    const patchText = await fs.readFile(patch, "utf8");
    expect(patchText).toContain("worker edit");
    expect(patchText).toContain("NEW.md");
    await expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("root v2\n");
    await expect(fs.access(path.join(root, "NEW.md"))).rejects.toThrow();

    await sh("bash", [scriptPath, "apply", "--root", root, "--worker", worker, "--patch", patch]);
    await expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("worker edit\n");
    await expect(fs.readFile(path.join(root, "NEW.md"), "utf8")).resolves.toBe("new worker file\n");
  });

  it("apply --dry-run validates the patch against root but leaves root unchanged", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-sync-dry-"));
    const root = path.join(tmp, "root");
    const worker = path.join(tmp, "worker");
    const patch = path.join(tmp, "review.patch");
    await fs.mkdir(root);
    await fs.mkdir(worker);
    await initRepo(root);
    await initRepo(worker);

    await fs.writeFile(path.join(root, "README.md"), "root v1\n");
    await sh("git", ["add", "README.md"], root);
    await sh("git", ["commit", "-qm", "initial"], root);

    await fs.writeFile(path.join(worker, "README.md"), "root v1\n");
    await sh("git", ["add", "README.md"], worker);
    await sh("git", ["commit", "-qm", "initial"], worker);

    await fs.writeFile(path.join(worker, "README.md"), "worker edit\n");
    await sh("bash", [scriptPath, "diff", "--root", root, "--worker", worker, "--patch", patch]);

    // dry-run reports a clean apply but must NOT mutate root.
    const dry = await sh("bash", [scriptPath, "apply", "--root", root, "--worker", worker, "--patch", patch, "--dry-run"]);
    expect(dry.stdout).toContain("dry-run OK");
    await expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("root v1\n");

    // a real apply after the dry-run does mutate root.
    await sh("bash", [scriptPath, "apply", "--root", root, "--worker", worker, "--patch", patch]);
    await expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("worker edit\n");
  });

  it("apply --dry-run fails (and never mutates root) when the patch does not apply", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-sync-dry-bad-"));
    const root = path.join(tmp, "root");
    const patch = path.join(tmp, "bad.patch");
    await fs.mkdir(root);
    await initRepo(root);
    await fs.writeFile(path.join(root, "README.md"), "root v1\n");
    await sh("git", ["add", "README.md"], root);
    await sh("git", ["commit", "-qm", "initial"], root);

    // A patch that targets a file/context that does not exist in root.
    await fs.writeFile(
      patch,
      "diff --git a/MISSING.md b/MISSING.md\nindex 1111111..2222222 100644\n--- a/MISSING.md\n+++ b/MISSING.md\n@@ -1 +1 @@\n-not here\n+changed\n",
    );
    await expect(
      sh("bash", [scriptPath, "apply", "--root", root, "--worker", root, "--patch", patch, "--dry-run"]),
    ).rejects.toBeTruthy();
    await expect(fs.access(path.join(root, "MISSING.md"))).rejects.toThrow();
    await expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("root v1\n");
  });

  it("refuses a worker checkout under /root", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-sync-refuse-"));
    const root = path.join(tmp, "root");
    await fs.mkdir(root);
    await initRepo(root);
    await expect(
      sh("bash", [scriptPath, "check", "--root", root, "--worker", "/root/paperclip"]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("worker checkout must not be under /root") });
  });
});
