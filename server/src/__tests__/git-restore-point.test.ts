import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRestorePoint,
  captureRestorePoint,
  currentRestorePointSnapshot,
  decodeRestorePointPayload,
  importRestorePoint,
  openRestorePoint,
  RestorePointRestoreFailure,
  RestorePointSkip,
  sealRestorePoint,
} from "../services/git-restore-point.ts";

const identity = { companyId: "company-1", workspaceId: "workspace-1", restorePointId: "restore-1", generation: 1 };

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();
}

async function write(root: string, relative: string, contents: string, mode?: number) {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), contents);
  if (mode !== undefined) await fs.chmod(path.join(root, relative), mode);
}

async function read(root: string, relative: string) {
  return fs.readFile(path.join(root, relative), "utf8");
}

describe("git restore points", () => {
  let root: string;
  let remote: string;
  let work: string;

  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-restore-point-test-"));
    remote = path.join(root, "remote.git");
    work = path.join(root, "work");
    git(root, "init", "-q", "--bare", "-b", "master", remote);
    git(root, "clone", "-q", remote, work);
    await write(work, ".gitignore", "node_modules/\n.env\n");
    await write(work, "src/app.ts", "export const value = 1;\n");
    await write(work, "src/remove-me.ts", "export const gone = true;\n");
    await write(work, "README.md", "hello\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "initial");
    git(work, "push", "-q", "origin", "HEAD:master");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  const upstream = () => [git(work, "rev-parse", "origin/master")];

  async function freshClone(name: string) {
    const target = path.join(root, name);
    git(root, "clone", "-q", remote, target);
    return target;
  }

  it("returns nothing when the workspace is fully reproducible from the remote", async () => {
    await write(work, "node_modules/pkg/index.js", "ignored\n");
    expect(await captureRestorePoint({ cwd: work, upstreamCommits: upstream() })).toBeNull();
  });

  it("round-trips unpushed commits, staged and unstaged edits, untracked files, deletions and modes", async () => {
    git(work, "checkout", "-q", "-b", "feature");
    await write(work, "src/app.ts", "export const value = 2;\n");
    git(work, "commit", "-q", "-am", "unpushed one");
    await write(work, "src/feature.ts", "export const feature = true;\n");
    git(work, "add", "src/feature.ts");
    git(work, "commit", "-q", "-m", "unpushed two");
    await write(work, "src/app.ts", "export const value = 3;\n");
    git(work, "add", "src/app.ts");
    await write(work, "src/app.ts", "export const value = 4;\n");
    await fs.rm(path.join(work, "src/remove-me.ts"));
    await write(work, "notes/todo.md", "untracked work\n");
    await write(work, "scripts/run.sh", "#!/bin/sh\necho hi\n", 0o755);
    await write(work, "private/key.txt", "secret-ish\n", 0o600);
    await fs.symlink("../README.md", path.join(work, "notes/readme-link"));
    await write(work, "node_modules/pkg/index.js", "ignored\n");
    await write(work, ".env", "TOKEN=ignored\n");
    await write(work, "config/.env.local", "TOKEN=untracked-env\n");

    const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
    expect(captured).not.toBeNull();
    const { payload, manifest } = captured!;
    expect(manifest.head).toBe(git(work, "rev-parse", "HEAD"));
    expect(manifest.prerequisites).toEqual(upstream());
    expect(await currentRestorePointSnapshot(work)).toEqual({ head: manifest.head, index: manifest.index, worktree: manifest.worktree, ignored: null, modes: manifest.modes });
    expect(manifest.schema).toBe("paperclip.git-restore-point-payload.v1");

    const restored = await freshClone("restored");
    expect(() => git(restored, "cat-file", "-e", `${manifest.head}^{commit}`)).toThrow();
    const imported = await importRestorePoint({ repositoryCwd: restored, payload });
    git(restored, "checkout", "-q", "-b", "feature", imported.head);
    await applyRestorePoint({ cwd: restored, manifest: imported });

    expect(await read(restored, "src/app.ts")).toBe("export const value = 4;\n");
    expect(git(restored, "show", ":src/app.ts")).toBe("export const value = 3;");
    expect(await read(restored, "src/feature.ts")).toBe("export const feature = true;\n");
    await expect(fs.access(path.join(restored, "src/remove-me.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await read(restored, "notes/todo.md")).toBe("untracked work\n");
    expect(git(restored, "status", "--porcelain", "--", "notes/todo.md")).toBe("?? notes/todo.md");
    expect((await fs.stat(path.join(restored, "scripts/run.sh"))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(path.join(restored, "private/key.txt"))).mode & 0o777).toBe(0o600);
    expect(await fs.readlink(path.join(restored, "notes/readme-link"))).toBe("../README.md");
    await expect(fs.access(path.join(restored, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(restored, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(restored, "config/.env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures edits to tracked environment files", async () => {
    await write(work, ".env.example", "TOKEN=\n");
    git(work, "add", ".env.example");
    git(work, "commit", "-q", "-m", "example env");
    git(work, "push", "-q", "origin", "HEAD:master");
    git(work, "fetch", "-q");
    await write(work, ".env.example", "TOKEN=\nOTHER=\n");
    const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
    expect(captured).not.toBeNull();
    const restored = await freshClone("restored");
    await importRestorePoint({ repositoryCwd: restored, payload: captured!.payload });
    await applyRestorePoint({ cwd: restored, manifest: captured!.manifest });
    expect(await read(restored, ".env.example")).toBe("TOKEN=\nOTHER=\n");
  });

  it("applies safeguards and modes to staged files whose contents match the index", async () => {
    await write(work, "private/staged.txt", "staged secret\n", 0o600);
    git(work, "add", "private/staged.txt");
    await expect(captureRestorePoint({ cwd: work, upstreamCommits: upstream(), limits: { maxFiles: 0 } }))
      .rejects.toMatchObject({ reason: "restore_point_too_large" });
    const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
    expect(captured!.manifest.modes).toEqual([{ path: "private/staged.txt", mode: 0o600 }]);
    const restored = await freshClone("restored");
    await importRestorePoint({ repositoryCwd: restored, payload: captured!.payload });
    await applyRestorePoint({ cwd: restored, manifest: captured!.manifest });
    expect((await fs.stat(path.join(restored, "private/staged.txt"))).mode & 0o777).toBe(0o600);
    expect(git(restored, "status", "--porcelain", "--", "private/staged.txt")).toBe("A  private/staged.txt");
  });

  it("detects permission-only changes after capture", async () => {
    await write(work, "private/key.txt", "secret\n", 0o600);
    const before = await currentRestorePointSnapshot(work);
    await fs.chmod(path.join(work, "private/key.txt"), 0o644);
    expect(await currentRestorePointSnapshot(work)).not.toEqual(before);
  });

  it("restores exact bytes when the repository configures a diff text conversion", async () => {
    await write(work, ".gitattributes", "*.txt diff=upper\n");
    await write(work, "notes.txt", "original\n");
    git(work, "add", ".gitattributes", "notes.txt");
    git(work, "commit", "-q", "-m", "textconv");
    git(work, "push", "-q", "origin", "HEAD:master");
    git(work, "fetch", "-q");
    await write(work, "notes.txt", "changed contents\n");
    const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
    const restored = await freshClone("restored");
    git(restored, "config", "diff.upper.textconv", "tr a-z A-Z <");
    await importRestorePoint({ repositoryCwd: restored, payload: captured!.payload });
    await applyRestorePoint({ cwd: restored, manifest: captured!.manifest });
    expect(await read(restored, "notes.txt")).toBe("changed contents\n");
  });

  it("captures a small edit despite a long ordinary history", async () => {
    for (let index = 0; index < 60; index += 1) {
      await write(work, "log.txt", `${index}\n`);
      git(work, "commit", "-q", "-am", `history ${index}`, "--allow-empty");
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "tracked log", "--allow-empty");
    git(work, "push", "-q", "origin", "HEAD:master");
    git(work, "fetch", "-q");
    await write(work, "notes/todo.md", "small edit\n");
    const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
    expect(captured!.manifest.preserved).toEqual([]);
    expect(captured!.manifest.worktree).not.toBeNull();
  });

  it("refuses to capture when history-only commits exceed the supported limit", async () => {
    git(work, "checkout", "-q", "-b", "feature");
    for (let index = 0; index < 51; index += 1) {
      await write(work, `scratch/${index}.txt`, `${index}\n`);
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", `scratch ${index}`);
      git(work, "reset", "-q", "--hard", "origin/master");
    }
    await expect(captureRestorePoint({ cwd: work, upstreamCommits: upstream() }))
      .rejects.toMatchObject({ reason: "restore_point_history_too_large" });
  });

  it("refuses more preserved commits than the limit before checking each one", async () => {
    const extra = Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(40, "0"));
    await expect(captureRestorePoint({ cwd: work, upstreamCommits: upstream(), preserveCommits: extra }))
      .rejects.toMatchObject({ reason: "restore_point_history_too_large" });
  });

  it("saves preserved commits that exist and ignores ones that do not", async () => {
    await write(work, "orphan.txt", "only reachable from a preserved commit\n");
    git(work, "add", "orphan.txt"); git(work, "commit", "-q", "-m", "orphan");
    const orphan = git(work, "rev-parse", "HEAD");
    git(work, "reset", "-q", "--hard", "HEAD~1");
    git(work, "reflog", "expire", "--expire=now", "--all");
    const { manifest } = (await captureRestorePoint({ cwd: work, upstreamCommits: upstream(),
      preserveCommits: [orphan, "f".repeat(40)] }))!;
    expect(manifest.preserved).toEqual([orphan]);
  });

  it("keeps capture objects out of the repository", async () => {
    await write(work, "notes/todo.md", "untracked work\n");
    const before = git(work, "count-objects", "-v");
    expect(await captureRestorePoint({ cwd: work, upstreamCommits: upstream() })).not.toBeNull();
    expect(git(work, "count-objects", "-v")).toBe(before);
    expect(git(work, "fsck", "--no-reflogs", "--unreachable", "--no-progress")).toBe("");
  });

  it("produces the same snapshot ids for unchanged contents and different ids after a change", async () => {
    await write(work, "notes/todo.md", "one\n");
    const first = await currentRestorePointSnapshot(work);
    expect(await currentRestorePointSnapshot(work)).toEqual(first);
    await write(work, "notes/todo.md", "two\n");
    expect(await currentRestorePointSnapshot(work)).not.toEqual(first);
  });

  it("bundles commits only reachable from history that is not on any branch", async () => {
    git(work, "checkout", "-q", "-b", "feature");
    await write(work, "src/lost.ts", "export const lost = true;\n");
    git(work, "add", "src/lost.ts");
    git(work, "commit", "-q", "-m", "rewritten away");
    const lost = git(work, "rev-parse", "HEAD");
    git(work, "reset", "-q", "--hard", "origin/master");
    const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
    expect(captured!.manifest.preserved).toEqual([lost]);
    const restored = await freshClone("restored");
    await importRestorePoint({ repositoryCwd: restored, payload: captured!.payload });
    expect(git(restored, "cat-file", "-t", lost)).toBe("commit");
    expect(git(restored, "for-each-ref", "refs/paperclip-restore-import/")).toBe("");
  });

  describe("ignored files", () => {
    async function ignoredWork() {
      await write(work, ".gitignore", "node_modules/\n.env\n*.tsbuildinfo\nevidence/\ndist/\n");
      git(work, "commit", "-q", "-am", "ignore build output");
      git(work, "push", "-q", "origin", "HEAD:master");
      await write(work, "ui/tsconfig.tsbuildinfo", "{\"version\":\"5\"}\n");
      await write(work, "evidence/run.log", "agent evidence\n", 0o600);
      await write(work, "dist/app.js", "regenerable\n");
      await write(work, "node_modules/pkg/index.js", "regenerable\n");
      await write(work, ".env", "TOKEN=never-saved\n");
    }

    it("saves ignored files that are not regenerable, as a v2 payload", async () => {
      await ignoredWork();
      const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
      expect(captured).not.toBeNull();
      const { manifest, payload } = captured!;
      expect(manifest).toMatchObject({ schema: "paperclip.git-restore-point-payload.v2", index: null, worktree: null, ignored: expect.any(String) });
      expect(manifest.modes).toEqual([{ path: "evidence/run.log", mode: 0o600 }]);
      expect(await currentRestorePointSnapshot(work)).toMatchObject({ ignored: manifest.ignored });
      const restored = await freshClone("restored-ignored");
      const imported = await importRestorePoint({ repositoryCwd: restored, payload });
      expect(git(restored, "ls-tree", "-r", "--name-only", manifest.ignored!).split("\n").sort()).toEqual(["evidence/run.log", "ui/tsconfig.tsbuildinfo"]);
      await applyRestorePoint({ cwd: restored, manifest: imported });
      expect(await read(restored, "ui/tsconfig.tsbuildinfo")).toBe("{\"version\":\"5\"}\n");
      expect(await read(restored, "evidence/run.log")).toBe("agent evidence\n");
      expect((await fs.stat(path.join(restored, "evidence/run.log"))).mode & 0o777).toBe(0o600);
      for (const missing of ["dist/app.js", "node_modules/pkg/index.js", ".env"]) {
        await expect(fs.access(path.join(restored, missing))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(git(restored, "status", "--porcelain")).toBe("");
    });

    it("fails closed instead of overwriting an existing ignored file", async () => {
      await ignoredWork();
      const { payload } = (await captureRestorePoint({ cwd: work, upstreamCommits: upstream() }))!;
      const restored = await freshClone("restored-conflict");
      await write(restored, "evidence/run.log", "newer local evidence\n");
      const imported = await importRestorePoint({ repositoryCwd: restored, payload });
      await expect(applyRestorePoint({ cwd: restored, manifest: imported })).rejects.toBeInstanceOf(RestorePointRestoreFailure);
      expect(await read(restored, "evidence/run.log")).toBe("newer local evidence\n");
    });

    it("restores ignored files byte for byte despite line ending attributes", async () => {
      await write(work, ".gitattributes", "* text=auto\n");
      git(work, "add", ".gitattributes"); git(work, "commit", "-q", "-m", "normalize text");
      git(work, "push", "-q", "origin", "HEAD:master");
      await ignoredWork();
      await write(work, "evidence/windows.txt", "line one\r\nline two\r\n");
      const { manifest, payload } = (await captureRestorePoint({ cwd: work, upstreamCommits: upstream() }))!;
      const restored = await freshClone("restored-crlf");
      const imported = await importRestorePoint({ repositoryCwd: restored, payload });
      await applyRestorePoint({ cwd: restored, manifest: imported });
      expect(await fs.readFile(path.join(restored, "evidence/windows.txt"))).toEqual(Buffer.from("line one\r\nline two\r\n"));
      expect(manifest.ignored).toBeDefined();
    });

    it("removes the files a failed restore wrote, so a retry succeeds", async () => {
      await ignoredWork();
      const { payload } = (await captureRestorePoint({ cwd: work, upstreamCommits: upstream() }))!;
      const restored = await freshClone("restored-partial");
      await fs.writeFile(path.join(restored, "ui"), "a file where a directory is needed\n");
      const imported = await importRestorePoint({ repositoryCwd: restored, payload });
      await expect(applyRestorePoint({ cwd: restored, manifest: imported })).rejects.toBeInstanceOf(RestorePointRestoreFailure);
      await expect(fs.access(path.join(restored, "evidence/run.log"))).rejects.toMatchObject({ code: "ENOENT" });
      await fs.rm(path.join(restored, "ui"));
      await applyRestorePoint({ cwd: restored, manifest: imported });
      expect(await read(restored, "evidence/run.log")).toBe("agent evidence\n");
      expect(await read(restored, "ui/tsconfig.tsbuildinfo")).toBe("{\"version\":\"5\"}\n");
    });

    it("saves a quoted-looking ignored path from inside the workspace, never the file it names", async () => {
      await ignoredWork();
      await write(work, ".gitignore", "node_modules/\n.env\n*.tsbuildinfo\nevidence/\ndist/\n\"*\n");
      git(work, "commit", "-q", "-am", "ignore quoted names");
      git(work, "push", "-q", "origin", "HEAD:master");
      const outside = path.join(root, "outside-secret.txt");
      await fs.writeFile(outside, "outside the workspace\n");
      const crafted = `"${outside}"`;
      await write(work, crafted, "workspace file with a quoted name\n");
      const { payload } = (await captureRestorePoint({ cwd: work, upstreamCommits: upstream() }))!;
      const restored = await freshClone("restored-quoted");
      const imported = await importRestorePoint({ repositoryCwd: restored, payload });
      await applyRestorePoint({ cwd: restored, manifest: imported });
      expect(await read(restored, crafted)).toBe("workspace file with a quoted name\n");
    });

    it("keeps an ignored symlink's target bytes exactly", async () => {
      await ignoredWork();
      const target = Buffer.from([0x2e, 0x2e, 0x2f, 0x66, 0xff, 0x6f]);
      try { await fs.symlink(target, path.join(work, "evidence", "odd-link")); }
      catch { return; }
      const { payload } = (await captureRestorePoint({ cwd: work, upstreamCommits: upstream() }))!;
      const restored = await freshClone("restored-link");
      const imported = await importRestorePoint({ repositoryCwd: restored, payload });
      await applyRestorePoint({ cwd: restored, manifest: imported });
      expect(await fs.readlink(path.join(restored, "evidence", "odd-link"), { encoding: "buffer" })).toEqual(target);
    });

    it("skips an ignored nested repository", async () => {
      await ignoredWork();
      git(work, "init", "-q", path.join(work, "evidence/nested"));
      await write(work, "evidence/nested/file.txt", "inside a nested repository\n");
      await expect(captureRestorePoint({ cwd: work, upstreamCommits: upstream() })).rejects.toBeInstanceOf(RestorePointSkip);
    });

    it("rejects a v1 payload that claims an ignored tree", async () => {
      await ignoredWork();
      const { payload } = (await captureRestorePoint({ cwd: work, upstreamCommits: upstream() }))!;
      const magic = Buffer.from("PCRP-PLAIN1\n");
      const length = payload.readUInt32BE(magic.length);
      const manifest = JSON.parse(payload.subarray(magic.length + 4, magic.length + 4 + length).toString("utf8"));
      const bytes = Buffer.from(JSON.stringify({ ...manifest, schema: "paperclip.git-restore-point-payload.v1" }));
      const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
      const forged = Buffer.concat([magic, size, bytes, payload.subarray(magic.length + 4 + length)]);
      expect(() => decodeRestorePointPayload(forged)).toThrow(RestorePointRestoreFailure);
    });
  });

  it("skips a nested untracked repository", async () => {
    git(root, "init", "-q", path.join(work, "vendor/other"));
    await write(work, "vendor/other/file.txt", "x\n");
    await expect(captureRestorePoint({ cwd: work, upstreamCommits: upstream() }))
      .rejects.toMatchObject({ reason: "untracked_nested_repository" });
  });

  it("ignores special files, which git never tracks", async () => {
    execFileSync("mkfifo", [path.join(work, "pipe")]);
    expect(await captureRestorePoint({ cwd: work, upstreamCommits: upstream() })).toBeNull();
  });

  it("skips workspaces over the size limits", async () => {
    await write(work, "big.bin", "x".repeat(2048));
    await expect(captureRestorePoint({ cwd: work, upstreamCommits: upstream(), limits: { maxFileBytes: 1024 } }))
      .rejects.toBeInstanceOf(RestorePointSkip);
    await expect(captureRestorePoint({ cwd: work, upstreamCommits: upstream(), limits: { maxFiles: 0 } }))
      .rejects.toMatchObject({ reason: "restore_point_too_large" });
  });

  it("refuses to import a bundle whose prerequisites are missing", async () => {
    git(work, "checkout", "-q", "-b", "feature");
    await write(work, "src/app.ts", "export const value = 2;\n");
    git(work, "commit", "-q", "-am", "unpushed");
    const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
    const empty = path.join(root, "empty");
    git(root, "init", "-q", empty);
    await expect(importRestorePoint({ repositoryCwd: empty, payload: captured!.payload }))
      .rejects.toMatchObject({ reason: "bundle_prerequisites_missing" });
  });

  it("refuses to apply onto a different commit", async () => {
    await write(work, "notes/todo.md", "work\n");
    const captured = await captureRestorePoint({ cwd: work, upstreamCommits: upstream() });
    const restored = await freshClone("restored");
    await write(restored, "other.txt", "x\n");
    git(restored, "add", "other.txt");
    git(restored, "commit", "-q", "-m", "diverged");
    await expect(applyRestorePoint({ cwd: restored, manifest: captured!.manifest }))
      .rejects.toMatchObject({ reason: "head_mismatch" });
  });

  describe("encryption", () => {
    const payload = Buffer.from("restore point payload");

    it("round-trips and binds to the restore point identity", async () => {
      const sealed = await sealRestorePoint(payload, identity);
      expect(sealed.ciphertext.includes(payload)).toBe(false);
      expect(await openRestorePoint({ ...sealed, identity })).toEqual(payload);
      await expect(openRestorePoint({ ...sealed, identity: { ...identity, workspaceId: "workspace-2" } }))
        .rejects.toMatchObject({ reason: "key_identity_mismatch" });
    });

    it("rejects tampered, truncated or rehashed ciphertext", async () => {
      const sealed = await sealRestorePoint(payload, identity);
      const flipped = Buffer.from(sealed.ciphertext);
      flipped[flipped.length - 20] ^= 1;
      await expect(openRestorePoint({ ...sealed, ciphertext: flipped, identity }))
        .rejects.toMatchObject({ reason: "ciphertext_hash_mismatch" });
      const { createHash } = await import("node:crypto");
      await expect(openRestorePoint({ ...sealed, ciphertext: flipped, sha256: createHash("sha256").update(flipped).digest("hex"), identity }))
        .rejects.toMatchObject({ reason: "ciphertext_authentication_failed" });
      const truncated = sealed.ciphertext.subarray(0, 10);
      await expect(openRestorePoint({ ...sealed, ciphertext: truncated, sha256: createHash("sha256").update(truncated).digest("hex"), identity }))
        .rejects.toBeInstanceOf(RestorePointRestoreFailure);
    });

    it("cannot be opened with a different master key", async () => {
      const sealed = await sealRestorePoint(payload, identity);
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "42".repeat(32));
      await expect(openRestorePoint({ ...sealed, identity })).rejects.toThrow();
    });
  });
});
