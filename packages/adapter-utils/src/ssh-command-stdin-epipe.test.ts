import { afterEach, describe, expect, it, vi } from "vitest";

const children = vi.hoisted(() => [] as import("node:child_process").ChildProcess[]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      const remote = args.at(-1) ?? "";
      const script = remote.includes("ECHO_STDIN")
        ? "process.stdin.pipe(process.stdout)"
        : remote.includes("KEEP_ALIVE")
          ? "process.on('SIGTERM', () => {}); require('node:fs').closeSync(0); setInterval(() => {}, 1000)"
          : "require('node:fs').closeSync(0); setTimeout(() => process.exit(255), 30)";
      const child = actual.spawn(process.execPath, ["-e", script], options);
      children.push(child);
      return child;
    }),
  };
});

import { runSshCommand } from "./ssh.js";

const config = {
  host: "fixture.invalid",
  username: "fixture",
  port: 22,
  remoteWorkspacePath: "/tmp/fixture",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

describe("SSH stdin pipe errors", () => {
  afterEach(async () => {
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }));
  });

  it("rejects instead of crashing when the remote side closes stdin early", async () => {
    await expect(
      runSshCommand(config, "true", { stdin: "x".repeat(8 * 1024 * 1024), timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "EPIPE" });
  });

  it("terminates a child that closes stdin and ignores SIGTERM", async () => {
    const command = runSshCommand(config, "KEEP_ALIVE", {
      stdin: "x".repeat(8 * 1024 * 1024),
      timeoutMs: 30_000,
    });
    await expect(command).rejects.toMatchObject({ code: "EPIPE" });
    const child = children.at(-1)!;
    const closed = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(child.signalCode)
      : new Promise<NodeJS.Signals | null>((resolve) => {
          child.once("close", (_code, signal) => resolve(signal));
        });
    expect(await closed).toBe("SIGKILL");
  }, 10_000);

  it("still passes stdin through when the remote side reads it", async () => {
    const result = await runSshCommand(config, "ECHO_STDIN", { stdin: "hello", timeoutMs: 5_000 });
    expect(result.stdout).toBe("hello");
  });
});
