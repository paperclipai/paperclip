import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeFreshWorkspaceSeed } from "./fresh-workspace-seed.js";

const execFile = promisify(execFileCallback);
const git = async (cwd: string, ...args: string[]) =>
  (await execFile("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args])).stdout.trim();

describe("materializeFreshWorkspaceSeed", () => {
  let scratch: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it("seeds from a base ref commit that only a remote-tracking branch contains", async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "fresh-seed-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(scratch, "home"));
    const remote = path.join(scratch, "remote.git");
    const upstream = path.join(scratch, "upstream");
    const project = path.join(scratch, "project");
    await execFile("git", ["init", "--bare", "--initial-branch=main", remote]);
    await execFile("git", ["clone", remote, upstream]);
    await writeFile(path.join(upstream, "file.txt"), "one\n");
    await git(upstream, "add", "file.txt");
    await git(upstream, "commit", "-m", "one");
    await git(upstream, "push", "origin", "HEAD:main");
    await execFile("git", ["clone", remote, project]);
    await writeFile(path.join(upstream, "file.txt"), "two\n");
    await git(upstream, "commit", "-am", "two");
    await git(upstream, "push", "origin", "HEAD:main");
    await git(project, "fetch", "origin");
    const remoteCommit = await git(project, "rev-parse", "origin/main");
    expect(await git(project, "rev-parse", "main")).not.toBe(remoteCommit);

    const destination = await materializeFreshWorkspaceSeed({
      companyId: "company-1", issueId: "issue-1", runId: "run-1", sourceCwd: project, baseRef: "origin/main",
    });

    expect(await git(destination, "rev-parse", "HEAD")).toBe(remoteCommit);
    expect(await readFile(path.join(destination, "file.txt"), "utf8")).toBe("two\n");
  });
});
