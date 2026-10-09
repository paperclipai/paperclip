import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "../services/managed-repository-checkout.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-repository-publication-"));
  directories.push(root);
  const source = path.join(root, "source");
  await mkdir(source);
  await execFile("git", ["init", "--initial-branch=main", source]);
  await writeFile(path.join(source, "source.txt"), "initial\n");
  await execFile("git", ["-C", source, "add", "."]);
  await execFile("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
  return { root, source, target: path.join(root, "target") };
}
describe("atomic managed repository publication", () => {
  it("keeps managed repositories separate without requiring Git or touching an ancestor", async () => {
    const { source, target } = await fixture();
    await mkdir(target);
    await expect(ensureManagedRepositoriesIgnored(target)).resolves.toBeUndefined();
    const nestedPlainRoot = path.join(source, "plain-task");
    await mkdir(nestedPlainRoot);
    const original = await readFile(path.join(source, ".git", "info", "exclude"), "utf8");
    await ensureManagedRepositoriesIgnored(nestedPlainRoot);
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toBe(original);
    await ensureManagedRepositoriesIgnored(source);
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toContain("/.paperclip-repositories/");
  });
  it("writes the pinned receipt inside the clone before making it visible", async () => {
    const { source, target } = await fixture();
    const result = await materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source, beforePublish: async clone => {
      expect(await stat(target).catch(() => null)).toBeNull();
      const commit = (await execFile("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(clone, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ repositoryId: "receipt", pinnedCommit: commit }));
    } });
    expect(result.warning).toBeNull();
    expect(JSON.parse(await readFile(path.join(target, ".git", "paperclip-workspace-owner.json"), "utf8"))).toMatchObject({ repositoryId: "receipt", pinnedCommit: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(await readFile(path.join(target, "source.txt"), "utf8")).toBe("initial\n");
  });
  it("does not publish an incomplete checkout when its receipt cannot be committed", async () => {
    const { root, source, target } = await fixture();
    await expect(materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source, beforePublish: async () => { throw new Error("receipt failed"); } })).rejects.toThrow(/receipt failed/);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
});
