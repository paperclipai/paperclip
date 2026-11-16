import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import * as objectCache from "../services/repository-object-cache.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execRepositoryGit, materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored, readManagedRepositoryPreparationFailure } from "../services/managed-repository-checkout.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
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
  it.each([{ cached: false, ignoresTermination: false }, { cached: true, ignoresTermination: false }, { cached: false, ignoresTermination: true }])("cancels a running clone and cleans staging (cached reference: $cached, ignores SIGTERM: $ignoresTermination)", async ({ cached, ignoresTermination }) => {
    const { root, target } = await fixture();
    const bin = path.join(root, "bin");
    const started = path.join(root, "clone-started.json");
    const stopped = path.join(root, "clone-stopped");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), `#!${process.execPath}\n`
      + `const fs = require('node:fs');\n`
      + `fs.appendFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\\n');\n`
      + `process.on('SIGTERM', () => { if (${ignoresTermination}) return; setTimeout(() => { const staging = process.argv.at(-1); fs.mkdirSync(staging, { recursive: true }); fs.writeFileSync(require('node:path').join(staging, 'late-write'), 'late'); fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); }, 200); });\n`
      + `setTimeout(() => process.exit(1), 5000);\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin);
    const controller = new AbortController();
    const reason = new Error("controller lease lost");
    const beforePublish = vi.fn();
    const resolveGitAuth = vi.fn(async () => null);
    if (cached) {
      vi.spyOn(objectCache, "resolveRepositoryObjectCache").mockResolvedValue({} as never);
      vi.spyOn(objectCache, "readRepositoryObjectCache").mockResolvedValue(path.join(root, "reference"));
    }
    const result = materializeManagedProjectWorkspace(target, {
      repoUrl: "https://example.test/source.git", signal: controller.signal,
      objectCacheCompanyDirectory: cached ? path.join(root, "cache") : undefined,
      resolveGitAuth, beforePublish,
    }).then(() => null, (error: unknown) => error);
    let pid: number | undefined;
    try {
      await vi.waitFor(async () => {
        const calls = (await readFile(started, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        pid = calls[0].pid;
        expect(calls).toHaveLength(1);
        expect(calls[0].args.includes("--reference-if-able")).toBe(cached);
      });
      controller.abort(reason);
      const abortedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve("abort deadline exceeded"), 1500); })])).resolves.toBe(reason);
      } finally { clearTimeout(timer); }
      expect(Date.now() - abortedAt).toBeLessThan(1500);
      if (!ignoresTermination) expect(await readFile(stopped, "utf8")).toBe("stopped");
      expect(() => process.kill(pid!, 0)).toThrow();
      expect((await readFile(started, "utf8")).trim().split("\n")).toHaveLength(1);
      expect(resolveGitAuth).toHaveBeenCalledTimes(1);
      expect(beforePublish).not.toHaveBeenCalled();
      expect(await stat(target).catch(() => null)).toBeNull();
      expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await result;
    }
  });
  it("waits for the publication Git child before cleaning staging after cancellation", async () => {
    const { root, source, target } = await fixture();
    const bin = path.join(root, "bin");
    const started = path.join(root, "publication-started");
    const stopped = path.join(root, "publication-stopped");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), `#!${process.execPath}\n`
      + `const fs = require('node:fs'); const path = require('node:path');\n`
      + `process.on('SIGTERM', () => setTimeout(() => { fs.mkdirSync(process.argv[3], { recursive: true }); fs.writeFileSync(path.join(process.argv[3], 'late-write'), 'late'); fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); }, 200));\n`
      + `fs.writeFileSync(${JSON.stringify(started)}, String(process.pid)); setTimeout(() => process.exit(1), 5000);\n`, { mode: 0o755 });
    const controller = new AbortController();
    const reason = new Error("lease lost during publication Git");
    const result = materializeManagedProjectWorkspace(target, {
      repoUrl: source, signal: controller.signal,
      beforePublish: async cloneCwd => {
        vi.stubEnv("PATH", bin);
        await execRepositoryGit("git", ["-C", cloneCwd, "rev-parse", "HEAD"], { signal: controller.signal });
      },
    }).then(() => null, (error: unknown) => error);
    let pid: number | undefined;
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(started, "utf8")); });
      controller.abort(reason);
      expect(await result).toBe(reason);
      await vi.waitFor(async () => expect(await readFile(stopped, "utf8")).toBe("stopped"));
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(await stat(target).catch(() => null)).toBeNull();
      expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await result;
    }
  });
  it("rejects a cancelled admission before creating staging or running Git", async () => {
    const { root, target } = await fixture();
    vi.stubEnv("PATH", path.join(root, "missing-git"));
    const reason = new Error("run stopped");
    const beforeCopy = vi.fn();
    await expect(materializeManagedProjectWorkspace(target, {
      repoUrl: "https://example.test/source.git", signal: AbortSignal.abort(reason), beforeCopy,
    })).rejects.toBe(reason);
    expect(beforeCopy).not.toHaveBeenCalled();
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
  });
  it("does not publish when cancellation arrives during the publication check", async () => {
    const { root, source, target } = await fixture();
    const controller = new AbortController();
    const reason = new Error("run stopped before publication");
    await expect(materializeManagedProjectWorkspace(target, {
      repoUrl: source, signal: controller.signal,
      beforePublish: async () => controller.abort(reason),
    })).rejects.toBe(reason);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
  });

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
  it("allows a declared plain task directory with inert Git metadata without changing its files", async () => {
    const { target } = await fixture();
    await mkdir(path.join(target, ".git", "info"), { recursive: true });
    const file = path.join(target, ".git", "info", "exclude");
    await writeFile(file, "/.paperclip-repositories/\n");
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).resolves.toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("/.paperclip-repositories/\n");
    await expect(ensureManagedRepositoriesIgnored(target)).rejects.toThrow("not a git repository");
  });
  it("still excludes managed repositories when a task directory contains a real checkout", async () => {
    const { source } = await fixture();
    await ensureManagedRepositoriesIgnored(source, { plainTaskDirectory: true });
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toContain("/.paperclip-repositories/");
  });
  it("retains unexpected Git errors for declared plain task directories", async () => {
    const { root, target } = await fixture();
    await mkdir(path.join(target, ".git"), { recursive: true });
    vi.stubEnv("PATH", path.join(root, "missing-git"));
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects linked Git metadata even for a declared plain task directory", async () => {
    const { source, target } = await fixture();
    await mkdir(target);
    await symlink(path.join(source, ".git"), path.join(target, ".git"), "dir");
    const original = await readFile(path.join(source, ".git", "info", "exclude"), "utf8");
    await expect(ensureManagedRepositoriesIgnored(target, { plainTaskDirectory: true })).rejects.toThrow("must not be a symlink");
    expect(await readFile(path.join(source, ".git", "info", "exclude"), "utf8")).toBe(original);
  });
  it.each([
    { label: "timeout", code: null, killed: true, timedOut: true },
    { label: "filesystem", code: "EACCES", killed: false, timedOut: false },
    { label: "output limit", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, timedOut: false },
  ])("retains safe $label metadata without adding raw command causes", async ({ code, killed, timedOut }) => {
    const { source, target } = await fixture();
    const original = Object.assign(new Error("Git failed for https://user:fixture-password@example.test/repo.git"), {
      code, killed, stderr: "private command output",
    });
    const failure = await materializeManagedProjectWorkspace(target, {
      repoUrl: "https://example.test/repo.git", localSource: source,
      beforePublish: async () => { throw original; },
    }).then(() => { throw new Error("Expected preparation to fail"); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(readManagedRepositoryPreparationFailure(failure)).toEqual({ code, timedOut });
    expect(failure).not.toHaveProperty("code");
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("stderr");
    expect(JSON.stringify(failure)).toBe("{}");
    expect((failure as Error).message).not.toContain("fixture-password");
    expect(await stat(target).catch(() => null)).toBeNull();
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
  it("authorizes the empty staging root before copying any source bytes", async () => {
    const { root, source, target } = await fixture();
    let stagingChecked = false;
    await expect(materializeManagedProjectWorkspace(target, {
      repoUrl: source,
      beforeCopy: async staging => {
        expect(await readdir(staging)).toEqual([]);
        expect(await stat(target).catch(() => null)).toBeNull();
        stagingChecked = true;
        throw new Error("Private staging source denied");
      },
    })).rejects.toThrow("Private staging source denied");
    expect(stagingChecked).toBe(true);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
  it("does not publish an incomplete checkout when its receipt cannot be committed", async () => {
    const { root, source, target } = await fixture();
    await expect(materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source, beforePublish: async () => { throw new Error("receipt failed"); } })).rejects.toThrow(/receipt failed/);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.startsWith("target.clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
});
