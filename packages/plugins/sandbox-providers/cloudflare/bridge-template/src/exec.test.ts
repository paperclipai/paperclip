import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

import { buildLoginShellScript, executeInSandbox } from "./exec.js";

describe("bridge exec", () => {
  it("invokes target.exec with a single shell command string and no args option", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "claude 1.0.0\n",
      stderr: "",
    });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "claude",
      args: ["--version"],
      cwd: "/workspace/paperclip",
      env: { PAPERCLIP_TEST_FLAG: "1" },
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 12_345,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    const [commandArg, optionsArg] = exec.mock.calls[0] ?? [];
    expect(typeof commandArg).toBe("string");
    expect(commandArg).toMatch(/^sh -lc /);
    expect(optionsArg).toEqual({ cwd: "/", timeout: 12_345 });
    expect(optionsArg).not.toHaveProperty("args");
    expect(optionsArg).not.toHaveProperty("stdin");
    expect(commandArg).toContain('. /etc/profile');
    expect(commandArg).toContain("cd ");
    expect(commandArg).toContain("/workspace/paperclip");
    expect(commandArg).toContain("PAPERCLIP_TEST_FLAG");
    expect(commandArg).toContain("claude");
    expect(commandArg).toContain("--version");
  });

  it("requests streaming callbacks when bridge output forwarding is enabled", async () => {
    const exec = vi.fn().mockImplementation(async (_command, options) => {
      await options?.onOutput?.("stdout", "hello\n");
      return {
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      };
    });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
    } as const;
    const onOutput = vi.fn();

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "echo",
      args: ["hello"],
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 5_000,
      onOutput,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/",
      timeout: 5_000,
      stream: true,
      onOutput: expect.any(Function),
    });
    expect(onOutput).toHaveBeenCalledWith("stdout", "hello\n");
  });

  it("stages stdin through a sandbox temp file and redirects from it", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    // sessionStrategy: "default" routes through the sandbox itself (no
    // getSession wrapper), so exec must live directly on the sandbox.
    const sandbox = {
      exec,
      getSession: vi.fn(),
      writeFile,
      deleteFile,
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "cat",
      args: [],
      sessionStrategy: "default",
      timeoutMs: 5_000,
      stdin: "payload-bytes",
    });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [stdinPath, stdinPayload] = writeFile.mock.calls[0] ?? [];
    expect(typeof stdinPath).toBe("string");
    expect(stdinPath).toMatch(/^\/tmp\/\.paperclip-bridge-stdin-/);
    expect(stdinPayload).toBe("payload-bytes");

    const commandArg = exec.mock.calls[0]?.[0];
    expect(commandArg).toContain(stdinPath);
    expect(commandArg).toMatch(/<\s*['"]/);

    expect(deleteFile).toHaveBeenCalledWith(stdinPath);
  });

  it("does not write a stdin file or redirect when stdin is empty", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const writeFile = vi.fn();
    const deleteFile = vi.fn();
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile,
      deleteFile,
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "pwd",
      sessionStrategy: "named",
      sessionId: "paperclip",
      timeoutMs: 5_000,
      stdin: null,
    });

    expect(writeFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    const commandArg = exec.mock.calls[0]?.[0];
    expect(commandArg).not.toContain("<");
  });

  it("rejects invalid environment variable keys in the login-shell wrapper", () => {
    expect(() => buildLoginShellScript({
      command: "pwd",
      args: [],
      env: { "bad-key": "1" },
    })).toThrow("Invalid sandbox environment variable key: bad-key");
  });
});
