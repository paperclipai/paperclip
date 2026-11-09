import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertReproducibleGitFiles,
  assertReproducibleManagedCheckout,
  type ManagedCheckoutProver,
} from "../services/git-workspace-restoration.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFile("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args]);
  return stdout;
}

async function write(file: string, content = "x\n") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function commit(cwd: string, file: string, message: string) {
  await write(path.join(cwd, file), `${message}\n`);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-q", "-m", message);
  await fs.rm(path.join(cwd, ".git", "COMMIT_EDITMSG"), { force: true });
  return (await git(cwd, "rev-parse", "HEAD")).trim();
}

describe("assertReproducibleGitFiles with Paperclip-managed files", () => {
  let root: string;
  let work: string;
  let projectSeed: string;
  let projectRemote: string;
  let prove: ManagedCheckoutProver;

  async function upstream(name: string, files: Record<string, string>) {
    const seed = path.join(root, `${name}-seed`);
    await fs.mkdir(seed, { recursive: true });
    await git(seed, "init", "-q");
    for (const [file, content] of Object.entries(files)) await write(path.join(seed, file), content);
    await git(seed, "add", "-A");
    await git(seed, "commit", "-q", "-m", "seed");
    const bare = path.join(root, `${name}.git`);
    await execFile("git", ["clone", "-q", "--bare", seed, bare]);
    await git(seed, "remote", "add", "origin", bare);
    return { seed, bare };
  }

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reproducible-")));
    const main = await upstream("main", {
      "README.md": "main\n",
      ".gitignore": "node_modules/\n.claude/settings.local.json\nsecret.txt\n",
    });
    ({ seed: projectSeed, bare: projectRemote } = await upstream("project", { "README.md": "project\n", ".gitignore": "node_modules/\n" }));
    work = path.join(root, "work");
    await execFile("git", ["clone", "-q", main.bare, work]);
    await fs.appendFile(path.join(work, ".git", "info", "exclude"), "\n/.paperclip-repositories/\n");
    prove = (checkout, _name, signal) => assertReproducibleManagedCheckout(checkout, {
      repoUrl: projectRemote, resolveGitAuth: async () => null, signal,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function managedCheckout(name = "project-d051a9c4e671") {
    const checkout = path.join(work, ".paperclip-repositories", name);
    await fs.mkdir(path.dirname(checkout), { recursive: true });
    await execFile("git", ["clone", "-q", projectRemote, checkout]);
    return checkout;
  }

  const check = () => assertReproducibleGitFiles(work, undefined, { proveManagedCheckout: prove });
  const expectAccepted = () => expect(check()).resolves.toBeDefined();
  const expectRejected = (reason: string | RegExp) => expect(check()).rejects.toThrow(reason);

  it("preserves Claude settings without a restoration capture", async () => {
    await write(path.join(work, ".claude", "settings.local.json"), "{}\n");
    await expectRejected("unique_ignored_files");
  });

  it("accepts a clean managed checkout, including its regenerable directories", async () => {
    const checkout = await managedCheckout();
    await write(path.join(checkout, "node_modules", "pkg", "index.js"));
    await write(path.join(work, "node_modules", "pkg", "index.js"));
    await expectAccepted();
  });

  it("rejects managed checkouts unless the caller can prove them", async () => {
    await managedCheckout();
    await expect(assertReproducibleGitFiles(work)).rejects.toThrow("unique_ignored_files");
  });

  it("still rejects unknown ignored files", async () => {
    await write(path.join(work, "secret.txt"));
    await expectRejected("unique_ignored_files");
  });

  it("rejects changed, untracked, and flag-hidden edits", async () => {
    const checkout = await managedCheckout();
    await write(path.join(checkout, "README.md"), "edited\n");
    await expectRejected("dirty_or_untracked_files");
    await git(checkout, "checkout", "-q", "--", "README.md");
    await write(path.join(checkout, "notes.txt"));
    await expectRejected("dirty_or_untracked_files");
    await fs.rm(path.join(checkout, "notes.txt"));
    await git(checkout, "update-index", "--skip-worktree", "README.md");
    await write(path.join(checkout, "README.md"), "hidden edit\n");
    await expectRejected("unsupported_index_flags");
  });

  it("rejects commits kept by a branch, a tag, or only the reflog", async () => {
    const checkout = await managedCheckout();
    await commit(checkout, "branch.txt", "branch work");
    await expectRejected("unpushed_managed_checkout");
    await git(checkout, "tag", "kept");
    await git(checkout, "pack-refs", "--all");
    await git(checkout, "reset", "-q", "--hard", "origin/main");
    await fs.rm(path.join(checkout, ".git", "ORIG_HEAD"), { force: true });
    await git(checkout, "reflog", "expire", "--expire=now", "--all");
    await expectRejected("unpushed_managed_checkout");
    await git(checkout, "tag", "-d", "kept");
    await commit(checkout, "amended.txt", "amended work");
    await git(checkout, "reset", "-q", "--hard", "origin/main");
    await fs.rm(path.join(checkout, ".git", "ORIG_HEAD"), { force: true });
    await expectRejected(/unique_reflog_commits|unpushed_managed_checkout/);
  });

  it("rejects a detached HEAD commit after its reflog expires", async () => {
    const checkout = await managedCheckout();
    await git(checkout, "checkout", "-q", "--detach");
    await commit(checkout, "detached.txt", "detached work");
    await git(checkout, "reflog", "expire", "--expire=now", "--all");
    await expectRejected("unpushed_managed_checkout");
  });

  it("accepts pushed history after upstream advances", async () => {
    await managedCheckout();
    await commit(projectSeed, "later.txt", "later upstream work");
    await git(projectSeed, "push", "-q", "origin", "main");
    await expectAccepted();
  });

  it("keeps a checkout whose upstream cannot be reached or authenticated", async () => {
    await managedCheckout();
    prove = (checkout, _name, signal) => assertReproducibleManagedCheckout(checkout, {
      repoUrl: path.join(root, "missing.git"), resolveGitAuth: async () => null, signal,
    });
    await expectRejected("managed_checkout_upstream_unavailable");
    prove = (checkout, _name, signal) => assertReproducibleManagedCheckout(checkout, {
      repoUrl: projectRemote, resolveGitAuth: async () => { throw new Error("credentials refused"); }, signal,
    });
    await expectRejected("managed_checkout_upstream_unavailable");
  });

  it("reports a local proof failure as local, not as an upstream problem", async () => {
    await managedCheckout();
    const writeFile = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith(path.join("objects", "info", "alternates"))) throw new Error("ENOSPC: no space left on device");
      return writeFile(file, ...(rest as [never]));
    });
    try {
      await expectRejected("ENOSPC");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not trust a stale remote-tracking ref", async () => {
    await git(projectSeed, "checkout", "-q", "-b", "feature");
    await commit(projectSeed, "feature.txt", "feature work");
    await git(projectSeed, "push", "-q", "origin", "feature");
    await managedCheckout();
    await git(projectRemote, "branch", "-q", "-D", "feature");
    await expectRejected("unpushed_managed_checkout");
  });

  it("rejects custom hooks, linked worktrees, stashes, and unreachable objects", async () => {
    const checkout = await managedCheckout();
    await write(path.join(checkout, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    await expectRejected("custom_git_metadata");
    await fs.rm(path.join(checkout, ".git", "hooks", "pre-commit"));

    const linked = path.join(root, "linked");
    await git(checkout, "worktree", "add", "-q", "--detach", linked);
    await expectRejected("managed_checkout_has_worktrees");
    await git(checkout, "worktree", "remove", "--force", linked);

    await write(path.join(checkout, "README.md"), "stashed\n");
    await git(checkout, "stash", "-q");
    await expectRejected(/unsupported_local_git_state|unsupported_managed_checkout_refs/);
    await git(checkout, "stash", "clear");

    await write(path.join(root, "orphan.txt"), "only copy\n");
    await git(checkout, "hash-object", "-w", path.join(root, "orphan.txt"));
    await expectRejected("unreachable_managed_checkout_objects");
  });

  it("never runs a configured fsmonitor command while inspecting", async () => {
    const checkout = await managedCheckout();
    const marker = path.join(root, "fsmonitor-ran");
    const hook = path.join(root, "fsmonitor.sh");
    await write(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await fs.chmod(hook, 0o755);
    for (const repository of [checkout, work]) {
      await git(repository, "config", "core.fsmonitor", hook);
      await check().catch(() => undefined);
      await git(repository, "config", "--unset", "core.fsmonitor");
    }
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("never treats task repositories or plain directories as reproducible", async () => {
    await managedCheckout("task-repo-0123456789abcdef01234567");
    await expectRejected("unique_ignored_files");
    await fs.rm(path.join(work, ".paperclip-repositories"), { recursive: true });
    await write(path.join(work, ".paperclip-repositories", "project-d051a9c4e671", "README.md"));
    await expectRejected("unproven_managed_checkout");
  });
});
