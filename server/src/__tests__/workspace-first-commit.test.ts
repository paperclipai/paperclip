import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// TSMC-21586. `git init` alone leaves HEAD at refs/heads/main with ZERO commits, so
// `git rev-parse HEAD` never resolves. That unborn state is a DEADLOCK: the thing that
// would create the first commit is an agent run, and a run cannot start against a checkout
// whose HEAD does not resolve. It needed a fleet-wide hand repair on 2026-08-25 and TSR
// still needed one on 08-26.
//
// This pins the provisioning contract directly against git, so it holds regardless of how
// realizeExecutionWorkspace is wired.

async function git(args: string[], cwd: string) {
  return execFile("git", args, { cwd });
}

async function headResolves(cwd: string) {
  return git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd)
    .then((r) => Boolean(r.stdout.trim()))
    .catch(() => false);
}

describe("project-primary workspace provisioning", () => {
  it("git init ALONE leaves an unborn checkout — the defect", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws-unborn-"));
    await git(["init"], dir);
    expect(await headResolves(dir)).toBe(false);
  });

  it("init + empty first commit resolves HEAD — the fix", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws-born-"));
    await git(["init"], dir);
    await git(["config", "user.email", "workspace@paperclip.local"], dir);
    await git(["config", "user.name", "Paperclip Workspace"], dir);
    await git(["commit", "--allow-empty", "-m", "initialise workspace"], dir);
    expect(await headResolves(dir)).toBe(true);
  });

  it("the first commit stages NOTHING — pre-existing untracked content survives", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws-content-"));
    mkdirSync(path.join(dir, "work-products"));
    writeFileSync(path.join(dir, "work-products", "evidence.txt"), "must survive");
    writeFileSync(path.join(dir, "manifest.json"), "{}");

    await git(["init"], dir);
    await git(["config", "user.email", "workspace@paperclip.local"], dir);
    await git(["config", "user.name", "Paperclip Workspace"], dir);
    await git(["commit", "--allow-empty", "-m", "initialise workspace"], dir);

    expect(await headResolves(dir)).toBe(true);
    // Nothing committed...
    const tracked = await git(["ls-tree", "-r", "--name-only", "HEAD"], dir);
    expect(tracked.stdout.trim()).toBe("");
    // ...and the content is still there, still untracked.
    const status = await git(["status", "--porcelain"], dir);
    expect(status.stdout).toContain("work-products/");
    expect(status.stdout).toContain("manifest.json");
  });
});
