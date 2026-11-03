import fs from "node:fs/promises";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceManifest, readManifestRecords, WorkspaceNulParser, WORKSPACE_PATH_MAX_BYTES, workspacePaths } from "./workspace-manifest.js";
import { readGitWorkspaceSnapshot, disposeGitWorkspaceSnapshot, runLocalGit, setExpensiveWorkspaceGitExecutor } from "./git-workspace-sync.js";

const cleanup: string[] = [];
afterEach(async () => {
  setExpensiveWorkspaceGitExecutor(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

it("parses split UTF-8 and NUL records while rejecting truncation and oversized records", () => {
  const names: string[] = [];
  const parser = new WorkspaceNulParser((value) => names.push(value));
  const bytes = Buffer.from(" 雪\n\t \0-option\0");
  for (const byte of bytes) parser.write(Buffer.from([byte]));
  parser.finish();
  expect(names).toEqual([" 雪\n\t ", "-option"]);
  parser.write(Buffer.from("unfinished"));
  expect(() => parser.finish()).toThrow("Incomplete");
  expect(() => parser.write(Buffer.alloc(WORKSPACE_PATH_MAX_BYTES, 97))).toThrow("per-record");
  expect(() => new WorkspaceNulParser(() => {}).write(Buffer.from([255, 0]))).toThrow();
});

it("deduplicates paths on disk and rejects incomplete manifest metadata", async () => {
  const writer = await createWorkspaceManifest();
  cleanup.push(path.dirname(writer.filePath));
  writer.batch(() => { writer.add("overlay", "b"); writer.add("overlay", "a"); writer.add("overlay", "b"); });
  const manifest = writer.paths("overlay");
  writer.close();
  expect([...workspacePaths(manifest)]).toEqual(["a", "b"]);
  expect(() => [...readManifestRecords({ ...manifest, count: 3 })]).toThrow("Incomplete");
  expect(() => [...workspacePaths(["../escape"])]).toThrow("Invalid");
});

it("refuses new manifests and fails ongoing writes when the disk reserve is exhausted", async () => {
  const writer = await createWorkspaceManifest();
  cleanup.push(path.dirname(writer.filePath));
  const available = nodeFs.statfsSync(os.tmpdir(), { bigint: true });
  vi.spyOn(nodeFs, "statfsSync").mockReturnValue({ ...available, bavail: 0n } as never);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(createWorkspaceManifest()).rejects.toMatchObject({ code: "workspace_git_scan_failed" });
    }
    expect(() => {
      for (let index = 0; index < 1024; index++) writer.add("overlay", `${index}-${"x".repeat(2048)}`);
    }).toThrow("free-space reserve");
  } finally { writer.close(false); }
});

it("admits each snapshot against current disk capacity and rejects growth at its page allowance", async () => {
  const available = nodeFs.statfsSync(os.tmpdir(), { bigint: true });
  const reserve = 256 * 1024 * 1024;
  vi.stubEnv("PAPERCLIP_WORKSPACE_MANIFEST_MIN_FREE_BYTES", String(reserve));
  const capacity = reserve + 128 * 1024;
  vi.spyOn(nodeFs, "statfsSync").mockReturnValue({ ...available, bsize: 1n, bavail: BigInt(capacity) } as never);
  for (let attempt = 0; attempt < 3; attempt++) {
    const writer = await createWorkspaceManifest();
    cleanup.push(path.dirname(writer.filePath));
    try {
      expect(() => writer.batch(() => {
        for (let index = 0; index < 100; index++) writer.add("overlay", `${index}-${"x".repeat(2048)}`);
      })).toThrow(/full/i);
      expect((await fs.stat(writer.filePath)).size).toBeLessThanOrEqual(32 * 1024);
    } finally { writer.close(false); }
  }
});

it("fails a real Git scan at its disk allowance and removes the incomplete manifest", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-scan-quota-"));
  cleanup.push(repo);
  await runLocalGit(repo, ["init"]);
  await runLocalGit(repo, ["commit", "--allow-empty", "-qm", "fixture"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_EMAIL: "test@example.test" },
  });
  for (let index = 0; index < 500; index++) await fs.writeFile(path.join(repo, `${index}-${"x".repeat(200)}`), "");
  const available = nodeFs.statfsSync(os.tmpdir(), { bigint: true });
  const reserve = 256 * 1024 * 1024;
  vi.stubEnv("PAPERCLIP_WORKSPACE_MANIFEST_MIN_FREE_BYTES", String(reserve));
  vi.spyOn(nodeFs, "statfsSync").mockReturnValue({ ...available, bsize: 1n, bavail: BigInt(reserve + 128 * 1024) } as never);
  const temporary: string[] = [];
  const mkdtemp = fs.mkdtemp.bind(fs);
  vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
    const directory = await mkdtemp(prefix, options);
    temporary.push(String(directory));
    return directory;
  });
  await expect(readGitWorkspaceSnapshot(repo)).rejects.toMatchObject({ code: "workspace_git_scan_failed" });
  expect(temporary).toHaveLength(1);
  await expect(fs.stat(temporary[0]!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("settles a late producer before removing shared storage after another scan fails", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-scan-barrier-"));
  cleanup.push(repo);
  await runLocalGit(repo, ["init"]);
  await runLocalGit(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "fixture"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_EMAIL: "test@example.test" },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let lateFinished = false;
  let settled = false;
  const removed: string[] = [];
  const originalRm = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (String(target).includes("paperclip-workspace-manifest-")) {
      expect(lateFinished).toBe(true);
      removed.push(String(target));
    }
    return originalRm(target, options);
  });
  const failure = Object.assign(new Error("scan failed"), { code: "workspace_git_scan_failed" });
  setExpensiveWorkspaceGitExecutor(async (input) => {
    if (input.operation.endsWith("ignored_files")) throw failure;
    if (input.operation.endsWith("untracked_files")) {
      await gate;
      await input.onStdout!(Buffer.from("late-producer\0"));
      lateFinished = true;
    }
    return { stdout: "", stderr: "" };
  });
  const result = readGitWorkspaceSnapshot(repo).catch((error) => { settled = true; return error; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(settled).toBe(false);
  expect(removed).toEqual([]);
  release();
  expect(await result).toBe(failure);
  expect(removed).toHaveLength(1);
  await expect(fs.stat(removed[0]!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails a malformed completed scan instead of publishing a partial snapshot", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-truncated-scan-"));
  cleanup.push(repo);
  await runLocalGit(repo, ["init"]);
  await runLocalGit(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "fixture"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_EMAIL: "test@example.test" },
  });
  setExpensiveWorkspaceGitExecutor(async (input) => {
    if (input.operation.endsWith("untracked_files")) await input.onStdout!(Buffer.from("complete\0partial"));
    return { stdout: "", stderr: "" };
  });
  await expect(readGitWorkspaceSnapshot(repo)).rejects.toThrow("Incomplete NUL");
  setExpensiveWorkspaceGitExecutor(null);
  const recovered = await readGitWorkspaceSnapshot(repo);
  expect(recovered).not.toBeNull();
  await disposeGitWorkspaceSnapshot(recovered);
});
