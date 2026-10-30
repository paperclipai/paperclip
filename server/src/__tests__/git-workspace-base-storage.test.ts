import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertReproducibleBaseGitStorage } from "../services/git-workspace-restoration.js";
import { ensureManagedRepositoriesIgnored } from "../services/managed-repository-checkout.js";

describe("reconstructable base Git metadata", () => {
  let root: string;
  let checkout: string;
  let exclude: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-base-storage-"));
    const source = path.join(root, "source");
    checkout = path.join(root, "checkout");
    await fs.mkdir(source);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false", ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
    git(source, "init", "--initial-branch=main");
    await fs.writeFile(path.join(source, "marker.txt"), "fixture\n");
    git(source, "add", "."); git(source, "commit", "-m", "Fixture");
    git(root, "clone", source, checkout);
    exclude = path.join(checkout, ".git", "info", "exclude");
    await ensureManagedRepositoriesIgnored(checkout);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("accepts the ignore entry produced by normal repository preparation", async () => {
    await expect(assertReproducibleBaseGitStorage(checkout)).resolves.toBeUndefined();
  });

  it.each([
    ["custom pattern", Buffer.from("private-output/\n")],
    ["custom comment", Buffer.from("# Retain my local metadata\n")],
    ["nonstandard bytes", Buffer.from([0xff, 0x00])],
    ["duplicate generated entry", Buffer.from("\n/.paperclip-repositories/\n")],
  ])("preserves a %s beyond the generated ignore entry", async (_name, bytes) => {
    await fs.appendFile(exclude, bytes);
    const original = await fs.readFile(exclude);
    await expect(assertReproducibleBaseGitStorage(checkout)).rejects.toThrow("custom_git_metadata");
    expect(await fs.readFile(exclude)).toEqual(original);
  });

  it("preserves a symlink even when its target contains the generated ignore entry", async () => {
    const target = path.join(root, "original-exclude");
    await fs.rename(exclude, target);
    await fs.symlink(target, exclude);
    const original = await fs.readFile(target);
    await expect(assertReproducibleBaseGitStorage(checkout)).rejects.toThrow("custom_git_metadata");
    expect((await fs.lstat(exclude)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target)).toEqual(original);
  });
});
