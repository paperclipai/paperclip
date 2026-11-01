import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { createSshCommandManagedRuntimeRunner } from "./ssh.js";

const roots: string[] = [];
afterEach(async () => {
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
