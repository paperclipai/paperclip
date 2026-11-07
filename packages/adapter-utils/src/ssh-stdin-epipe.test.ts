import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { prepareWorkspaceForSshExecution, syncDirectoryFromSsh, syncDirectoryToSsh } from "./ssh.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);

type FakeChild = EventEmitter & {
  stdin: PassThrough | null;
  stdout: PassThrough | null;
  stderr: PassThrough | null;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(stdio: { stdin?: boolean; stdout?: boolean; stderr?: boolean }): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = stdio.stdin ? new PassThrough() : null;
  child.stdout = stdio.stdout ? new PassThrough() : null;
  child.stderr = stdio.stderr ? new PassThrough() : null;
  child.kill = vi.fn();
  return child;
}

function epipe(): Error {
  const error = new Error("write EPIPE") as NodeJS.ErrnoException;
  error.code = "EPIPE";
  return error;
}

const spec = {
  host: "example.test",
  port: 22,
  username: "agent",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
  strictHostKeyChecking: false,
  knownHosts: "",
  remoteCwd: "/workspace",
  remoteWorkspacePath: "/workspace",
};

describe("ssh sync stdin EPIPE guard", () => {
  let localDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(path.join(tmpdir(), "paperclip-epipe-test-"));
    writeFileSync(path.join(localDir, "file.txt"), "payload");
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("rejects instead of crashing when ssh closes stdin early (upload direction)", async () => {
    const ssh = fakeChild({ stdin: true, stderr: true });
    const tar = fakeChild({ stdout: true, stderr: true });
    spawnMock.mockImplementation((command: string) =>
      (command === "ssh" ? ssh : tar) as unknown as ReturnType<typeof spawn>,
    );

    const pending = syncDirectoryToSsh({
      spec,
      localDir,
      remoteDir: "/workspace",
    });

    // Wait until the transfer wired its error listeners onto ssh.stdin, then
    // simulate the kernel answering a late write with EPIPE after the remote
    // `tar -xf` exited early.
    await vi.waitFor(() => {
      expect(ssh.stdin!.listenerCount("error")).toBeGreaterThan(0);
    });
    // The remote script left a diagnostic on stderr before exiting early;
    // the rejection must surface that instead of the bare EPIPE.
    ssh.stderr!.write("mkdir: cannot create directory /workspace: Permission denied\n");
    ssh.stdin!.emit("error", epipe());

    await expect(pending).rejects.toThrow(/Permission denied/);
    expect(ssh.kill).toHaveBeenCalled();
  });

  it("rejects instead of crashing when tar closes stdin early (download direction)", async () => {
    const ssh = fakeChild({ stdout: true, stderr: true });
    const tar = fakeChild({ stdin: true, stderr: true });
    spawnMock.mockImplementation((command: string) =>
      (command === "ssh" ? ssh : tar) as unknown as ReturnType<typeof spawn>,
    );

    const pending = syncDirectoryFromSsh({
      spec,
      remoteDir: "/workspace",
      localDir,
    });

    await vi.waitFor(() => {
      expect(tar.stdin!.listenerCount("error")).toBeGreaterThan(0);
    });
    tar.stdin!.emit("error", epipe());

    await expect(pending).rejects.toMatchObject({ code: "EPIPE" });
    expect(tar.kill).toHaveBeenCalled();
  });
});

describe("ssh git-bundle upload stdin EPIPE guard", () => {
  let localDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(path.join(tmpdir(), "paperclip-epipe-git-"));
    execFileSync("git", ["-C", localDir, "init", "-q"]);
    execFileSync("git", [
      "-C", localDir,
      "-c", "user.name=Epipe Test",
      "-c", "user.email=epipe-test@example.com",
      "commit", "-q", "--allow-empty", "-m", "init",
    ]);
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // Greptile: the EPIPE guard also covers streamLocalFileToSsh (the git-bundle
  // upload inside importGitWorkspaceToSsh), which the directory-sync tests do
  // not reach. Drive it through the public prepareWorkspaceForSshExecution
  // entry with a real local git repo and a mocked ssh child.
  it("rejects instead of crashing when ssh closes stdin early during the git-bundle upload", async () => {
    const ssh = fakeChild({ stdin: true, stderr: true });
    spawnMock.mockImplementation((command: string) =>
      (command === "ssh" ? ssh : fakeChild({})) as unknown as ReturnType<typeof spawn>,
    );

    const pending = prepareWorkspaceForSshExecution({
      spec,
      localDir,
      remoteDir: "/workspace",
    });

    // Wait until the bundle transfer wired its error listener onto ssh.stdin,
    // then simulate the kernel answering a late write with EPIPE after the
    // remote setup script exited early.
    await vi.waitFor(() => {
      expect(ssh.stdin!.listenerCount("error")).toBeGreaterThan(0);
    });
    // The remote script left a diagnostic on stderr before exiting early;
    // the rejection must surface that instead of the bare EPIPE.
    ssh.stderr!.write("mkdir: cannot create directory /workspace: Permission denied\n");
    ssh.stdin!.emit("error", epipe());

    await expect(pending).rejects.toThrow(/Permission denied/);
    expect(ssh.kill).toHaveBeenCalled();
  });
});
