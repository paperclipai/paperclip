import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      return actual.execFile("sh", ["-c", args.at(-1)!], options, callback);
    }),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      return actual.spawn("sh", ["-c", args.at(-1)!], options);
    }),
  };
});

import { createSshCommandManagedRuntimeRunner, runSshCommand } from "./ssh.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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

describe("SSH command-managed argv", () => {
  it.each(["spawn", "command"])("decodes with BSD-compatible flags and preserves stdin through %s", async mode => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "ssh-bsd-base64-"));
    roots.push(bin);
    await writeFile(path.join(bin, "base64"), `#!${process.execPath}\nif (process.argv.length !== 3 || process.argv[2] !== '-d') process.exit(2);\nlet text='';process.stdin.on('data', b => text+=b);process.stdin.on('end', () => process.stdout.write(Buffer.from(text,'base64')));\n`, { mode: 0o700 });
    vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
    const invocation = { command: "sh", args: ["-c", 'printf "%s\\n" "$SENTINEL_TEXT"; cat'], env: { SENTINEL_TEXT: "fixture-credential" }, stdin: "provider input\n", timeoutMs: 5000 };
    const result = mode === "spawn" ? await (await runner()).execute(invocation) : await runSshCommand({ host: "fixture.invalid", port: 22, username: "fixture", remoteWorkspacePath: "/tmp", privateKey: null, knownHosts: null, strictHostKeyChecking: true }, 'printf "%s\\n" "$SENTINEL_TEXT"; cat', invocation);
    expect(result.stdout).toBe("fixture-credential\nprovider input\n");
  });
  it("delivers configured credentials without placing them in SSH process arguments and preserves provider stdin", async () => {
    const token = "selected-agent-subscription-canary";
    const result = await (await runner()).execute({ command: "sh", args: ["-c", 'printf "%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN"; cat'],
      env: { CLAUDE_CODE_OAUTH_TOKEN: token }, stdin: "provider input\n", timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(token + "\nprovider input\n");
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]?.join(" ")).not.toContain(token);
  });
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
});
