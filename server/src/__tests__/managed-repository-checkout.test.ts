import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored, readManagedRepositoryPreparationFailure } from "../services/managed-repository-checkout.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
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
  it.skipIf(process.platform !== "win32")("clones and fetches HTTP repositories at deeply nested Windows paths", async () => {
    const { root, source } = await fixture();
    await execFile("git", ["-C", source, "update-server-info"]);
    const gitRoot = path.join(source, ".git");
    const server = createServer(async (req, res) => {
      const file = path.resolve(gitRoot, `.${new URL(req.url!, "http://localhost").pathname}`);
      if (!file.startsWith(`${gitRoot}${path.sep}`)) { res.writeHead(403).end(); return; }
      try { res.end(await readFile(file)); } catch { res.writeHead(404).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const canonicalRoot = await realpath(root);
      const nameLength = 244 - canonicalRoot.length - 1;
      const target = path.join(root, "nested-workspace-".repeat(16).slice(0, nameLength));
      expect(path.join(canonicalRoot, `${path.basename(target)}.clone-123456`, ".git").length).toBeGreaterThan(260);
      const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
      await materializeManagedProjectWorkspace(target, {
        repoUrl: `http://127.0.0.1:${port}`,
        resolveGitAuth: async () => ({ configArgs: [], env, source: "managed_connection", secretName: null }),
      });
      await execFile("git", ["-C", target, "fetch", "--no-tags", "origin"], { env: { ...process.env, ...env } });
      expect(await readFile(path.join(target, "source.txt"), "utf8")).toBe("initial\n");
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it.skipIf(process.platform !== "win32")("initializes Git templates beyond MAX_PATH before repository config exists", async () => {
    const { root, source } = await fixture();
    const template = path.join(root, "template");
    await mkdir(path.join(template, "hooks"), { recursive: true });
    await writeFile(path.join(template, "hooks", "fsmonitor-watchman.sample"), "inert template fixture\n");
    const target = path.join(root, "nested-workspace-".repeat(9));
    expect(path.join(`${target}.clone-123456`, ".git", "hooks", "fsmonitor-watchman.sample").length).toBeGreaterThan(260);
    await materializeManagedProjectWorkspace(target, {
      repoUrl: source,
      resolveGitAuth: async () => ({
        configArgs: [], source: "managed_connection", secretName: null,
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: template,
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "false" },
      }),
    });
    expect(await readFile(path.join(target, ".git", "hooks", "fsmonitor-watchman.sample"), "utf8")).toBe("inert template fixture\n");
    expect(await readFile(path.join(target, "source.txt"), "utf8")).toBe("initial\n");
    expect((await execFile("git", ["-C", target, "config", "--local", "--get", "core.longpaths"])).stdout.trim()).toBe("true");
  });
  it.skipIf(process.platform !== "win32")("checks out long Windows paths with isolated Git config and retains support for later checkouts", async () => {
    const { root, source } = await fixture();
    const relative = path.join("long-directory-name-".repeat(2), "nested-directory-name-".repeat(2), "LongProject.Components.DistributedCaching.Redis.csproj");
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await writeFile(path.join(source, relative), "main\n");
    const git = (args: string[]) => execFile("git", ["-c", "core.longpaths=true", "-C", source, ...args]);
    await git(["add", "."]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "long path"]);
    await git(["checkout", "-b", "alternate"]);
    await writeFile(path.join(source, relative), "alternate\n");
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-am", "alternate"]);
    await git(["checkout", "main"]);
    const target = path.join(root, "managed-workspace-".repeat(5));
    expect(path.join(target, relative).length).toBeGreaterThan(260);
    await materializeManagedProjectWorkspace(target, {
      repoUrl: source,
      repoRef: "alternate",
      resolveGitAuth: async () => ({ configArgs: [], env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, source: "managed_connection", secretName: null }),
    });
    expect(await readFile(path.join(target, relative), "utf8")).toBe("alternate\n");
    expect((await execFile("git", ["-C", target, "config", "--local", "--get", "core.longpaths"])).stdout.trim()).toBe("true");
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
    expect((await readdir(root)).filter(name => name.includes(".clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
  it("does not publish an incomplete checkout when its receipt cannot be committed", async () => {
    const { root, source, target } = await fixture();
    await expect(materializeManagedProjectWorkspace(target, { repoUrl: "https://github.com/test/source", localSource: source, beforePublish: async () => { throw new Error("receipt failed"); } })).rejects.toThrow(/receipt failed/);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect((await readdir(root)).filter(name => name.includes(".clone-"))).toEqual([]);
    expect(await readFile(path.join(source, "source.txt"), "utf8")).toBe("initial\n");
  });
});
