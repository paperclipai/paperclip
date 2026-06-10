import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PERSISTENCE_ARTIFACT_DIR_MODE,
  PERSISTENCE_ARTIFACT_FILE_MODE,
  SHELL_SNAPSHOT_DIR_NAME,
  redactShellSnapshotPersistenceArtifacts,
  walkShellSnapshotFiles,
  writeOwnerOnlyPersistenceArtifact,
} from "./persistence-redaction.js";

const GITHUB_CLASSIC_TOKEN_FIXTURE = "ghp_" + "fixture".repeat(4);

describe("walkShellSnapshotFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-shell-snap-walk-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns an empty array when the shell_snapshots directory does not exist", async () => {
    const files = await walkShellSnapshotFiles(root);
    expect(files).toEqual([]);
  });

  it("enumerates every .sh file under shell_snapshots", async () => {
    const dir = path.join(root, SHELL_SNAPSHOT_DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "alpha.sh"), "echo alpha\n", "utf8");
    await fs.writeFile(path.join(dir, "beta.sh"), "echo beta\n", "utf8");
    await fs.writeFile(path.join(dir, "ignore.txt"), "echo no\n", "utf8");
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, "nested", "gamma.sh"), "echo gamma\n", "utf8");

    const files = (await walkShellSnapshotFiles(root)).sort();
    expect(files).toEqual(
      [
        path.join(dir, "alpha.sh"),
        path.join(dir, "beta.sh"),
        path.join(dir, "nested", "gamma.sh"),
      ].sort(),
    );
  });
});

describe("redactShellSnapshotPersistenceArtifacts", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-shell-snap-redact-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns a zero summary when the shell_snapshots directory does not exist", async () => {
    const result = await redactShellSnapshotPersistenceArtifacts({ root });
    expect(result).toEqual({
      filesChecked: 0,
      filesChanged: 0,
      redactionCount: 0,
      dirModeCorrected: false,
    });
  });

  it("scrubs a raw GitHub classic token, sets 0o700 on the directory and 0o600 on each .sh file", async () => {
    const dir = path.join(root, SHELL_SNAPSHOT_DIR_NAME);
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    const filePath = path.join(dir, "snapshot-a.sh");
    const original = [
      "#!/usr/bin/env bash",
      "export GITHUB_TOKEN=" + GITHUB_CLASSIC_TOKEN_FIXTURE,
      "echo hello",
      "",
    ].join("\n");
    await fs.writeFile(filePath, original, { encoding: "utf8", mode: 0o644 });

    const result = await redactShellSnapshotPersistenceArtifacts({ root });

    expect(result.dirModeCorrected).toBe(true);
    expect(result.filesChecked).toBe(1);
    expect(result.filesChanged).toBeGreaterThanOrEqual(1);
    expect(result.redactionCount).toBeGreaterThanOrEqual(1);

    const dirStat = await fs.stat(dir);
    expect(dirStat.mode & 0o777).toBe(PERSISTENCE_ARTIFACT_DIR_MODE);

    const fileStat = await fs.stat(filePath);
    expect(fileStat.mode & 0o777).toBe(PERSISTENCE_ARTIFACT_FILE_MODE);

    const persisted = await fs.readFile(filePath, "utf8");
    expect(persisted).toContain("[REDACTED:");
    expect(persisted).not.toContain(GITHUB_CLASSIC_TOKEN_FIXTURE);
  });

  it("leaves files whose contents have no redactable substrings at 0o600 without rewriting them", async () => {
    const dir = path.join(root, SHELL_SNAPSHOT_DIR_NAME);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, "benign.sh");
    const original = "#!/usr/bin/env bash\necho hello world\n";
    await fs.writeFile(filePath, original, { encoding: "utf8", mode: 0o644 });

    const result = await redactShellSnapshotPersistenceArtifacts({ root });

    expect(result.dirModeCorrected).toBe(false);
    expect(result.filesChecked).toBe(1);
    expect(result.filesChanged).toBe(0);
    expect(result.redactionCount).toBe(0);

    const fileStat = await fs.stat(filePath);
    expect(fileStat.mode & 0o777).toBe(PERSISTENCE_ARTIFACT_FILE_MODE);
    const persisted = await fs.readFile(filePath, "utf8");
    expect(persisted).toBe(original);
  });

  it("idempotently reports dirModeCorrected=false once the directory is already 0o700", async () => {
    const dir = path.join(root, SHELL_SNAPSHOT_DIR_NAME);
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    const filePath = path.join(dir, "snapshot-c.sh");
    await fs.writeFile(
      filePath,
      "export GITHUB_TOKEN=" + GITHUB_CLASSIC_TOKEN_FIXTURE + "\n",
      "utf8",
    );

    const first = await redactShellSnapshotPersistenceArtifacts({ root });
    const second = await redactShellSnapshotPersistenceArtifacts({ root });

    expect(first.dirModeCorrected).toBe(true);
    expect(first.redactionCount).toBeGreaterThanOrEqual(1);

    expect(second.dirModeCorrected).toBe(false);
    expect(second.redactionCount).toBe(first.redactionCount);
  });
});

describe("writeOwnerOnlyPersistenceArtifact", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-write-owner-only-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates the target file with 0o600 mode and does not leave a temp file behind", async () => {
    const filePath = path.join(root, "artifact.txt");
    await writeOwnerOnlyPersistenceArtifact(filePath, "hello world\n");

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(PERSISTENCE_ARTIFACT_FILE_MODE);
    expect(await fs.readFile(filePath, "utf8")).toBe("hello world\n");

    const dirEntries = await fs.readdir(root);
    expect(dirEntries).toEqual(["artifact.txt"]);
  });

  it("overwrites an existing owner-only file without leaving temp files", async () => {
    const filePath = path.join(root, "artifact.bin");
    await writeOwnerOnlyPersistenceArtifact(filePath, "first\n");
    await writeOwnerOnlyPersistenceArtifact(filePath, "second\n");

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(PERSISTENCE_ARTIFACT_FILE_MODE);
    expect(await fs.readFile(filePath, "utf8")).toBe("second\n");
    const dirEntries = await fs.readdir(root);
    expect(dirEntries).toEqual(["artifact.bin"]);
  });
});
