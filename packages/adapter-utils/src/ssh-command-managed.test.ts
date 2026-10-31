import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getWriteDelay, setWriteDelay } = vi.hoisted(() => {
  let writeDelay = 0;
  return {
    getWriteDelay: () => writeDelay,
    setWriteDelay: (value: number) => {
      writeDelay = value;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file === "ssh") return actual.execFile("sh", ["-c", args.at(-1)!], options, callback);
      return actual.execFile(file, args, options, callback);
    }),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file === "ssh") return actual.spawn("sh", ["-c", args.at(-1)!], options);
      return actual.spawn(file, args, options);
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (file: string, options?: Parameters<typeof actual.createWriteStream>[1]) => {
      const stream = actual.createWriteStream(file, options);
      const delay = getWriteDelay();
      if (delay <= 0) return stream;
      const originalWrite = stream._write.bind(stream);
      stream._write = (chunk, encoding, callback) => {
        setTimeout(() => originalWrite(chunk, encoding, callback), delay);
      };
      return stream;
    },
  };
});

import { createSshCommandManagedRuntimeRunner, restoreWorkspaceFromSshExecution } from "./ssh.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  setWriteDelay(0);
});

async function runner() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ssh-managed-argv-"));
  roots.push(cwd);
  return createSshCommandManagedRuntimeRunner({
    spec: {
      host: "fixture.invalid", username: "fixture", port: 22,
      remoteCwd: cwd, remoteWorkspacePath: cwd,
      privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFileCallback(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function initGitRepository(cwd: string, fileName: string, contents: string | Buffer, message: string): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.name", "Paperclip Test"]);
  await git(cwd, ["config", "user.email", "test@paperclip.dev"]);
  await writeFile(path.join(cwd, fileName), contents);
  await git(cwd, ["add", fileName]);
  await git(cwd, ["commit", "-qm", message]);
}

describe("SSH command-managed argv", () => {
  it("rejects environment keys that could be interpreted as env options", async () => {
    await expect((await runner()).execute({ command: "true", env: { "-u": "PATH" } }))
      .rejects.toThrow("Invalid SSH environment variable key");
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "preserves shell positional arguments with environment=%s and stdin=%s",
    async (withEnvironment, withStdin) => {
      const value = "literal 'quote' $(printf unsafe) `printf unsafe`";
      const result = await (await runner()).execute({
        command: "sh",
        args: ["-c", 'set -eu; printf "%s\\n" "$0" "$1" "$2" "${SENTINEL_TEXT-unset}"', "named-probe", "two words", value],
        ...(withEnvironment ? { env: { SENTINEL_TEXT: value } } : {}),
        ...(withStdin ? { stdin: "" } : {}),
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(["named-probe", "two words", value, withEnvironment ? value : "unset"].join("\n") + "\n");
    },
  );

  it("applies environment to a non-shell command", async () => {
    const result = await (await runner()).execute({
      command: "printenv", args: ["SENTINEL_TEXT"],
      env: { SENTINEL_TEXT: "two words" }, timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("two words\n");
  });

  it("issue #16567: waits for a delayed git bundle write before completing SSH restore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ssh-stream-lifecycle-"));
    roots.push(root);
    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    const remoteShellDir = remoteDir.replaceAll("\\", "/");
    const payload = Buffer.alloc(4 * 1024 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < payload.length; index += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      payload[index] = state >>> 24;
    }

    await initGitRepository(localDir, "local.txt", "local\n", "local base");
    await initGitRepository(remoteDir, "payload.bin", payload, "remote payload");

    setWriteDelay(2);
    await restoreWorkspaceFromSshExecution({
      spec: {
        host: "fixture.invalid",
        username: "fixture",
        port: 22,
        remoteCwd: remoteShellDir,
        remoteWorkspacePath: remoteShellDir,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      localDir,
      remoteDir: remoteShellDir,
      onProgress: () => undefined,
    });

    expect(await git(localDir, ["log", "-1", "--pretty=%s"])).toBe("remote payload");
    await expect(readFile(path.join(localDir, "payload.bin"))).resolves.toEqual(payload);
  }, 30_000);
});
