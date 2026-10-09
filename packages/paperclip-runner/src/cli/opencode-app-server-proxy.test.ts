import { describe, expect, it } from "vitest";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRUSTED_OPENCODE_EXECUTABLE_ARG,
  trustedOpenCodeLaunchBinding,
  withoutAmbientOpenCodeCommand,
} from "./opencode-proxy-command.js";
import { openCodeProxyTaskEnvelope } from "./opencode-proxy-task-envelope.js";

describe("OpenCode runnerd proxy executable", () => {
  it("uses the runner-owned inherited executable descriptor", () => {
    if (process.platform !== "linux") return;
    expect(trustedOpenCodeLaunchBinding([
      TRUSTED_OPENCODE_EXECUTABLE_ARG,
      "/proc/self/fd/7",
    ])).toEqual({ command: "/proc/self/fd/7", commandFd: 7 });
  });

  it("executes the inherited artifact through the nested child fd mapping", () => {
    if (process.platform === "win32") return;
    if (process.platform === "darwin") {
      const root = mkdtempSync(join(tmpdir(), "paperclip-opencode-nested-"));
      const directory = join(
        root,
        ".paperclip-verified-executable-0123456789abcdef0123456789abcdef",
      );
      const command = join(directory, "launch");
      try {
        mkdirSync(directory, { mode: 0o700 });
        writeFileSync(command, "#!/bin/sh\nprintf verified-nested-spawn\n");
        chmodSync(command, 0o500);
        const binding = trustedOpenCodeLaunchBinding([
          TRUSTED_OPENCODE_EXECUTABLE_ARG,
          command,
        ]);
        binding.commandLifecycle?.beforeSpawn();
        const child = spawnSync(binding.command, [], { encoding: "utf8" });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.stdout).toBe("verified-nested-spawn");
        binding.commandLifecycle?.afterSpawn();
        expect(() => lstatSync(command)).toThrow();
        expect(() => lstatSync(directory)).toThrow();
        binding.commandLifecycle?.beforeSpawn();
        const retriedChild = spawnSync(binding.command, [], { encoding: "utf8" });
        expect(retriedChild.error).toBeUndefined();
        expect(retriedChild.status).toBe(0);
        expect(retriedChild.stdout).toBe("verified-nested-spawn");
        binding.commandLifecycle?.afterSpawn();
        expect(() => lstatSync(command)).toThrow();
        expect(() => lstatSync(directory)).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      return;
    }
    const parentFd = openSync(process.execPath, "r");
    try {
      const binding = trustedOpenCodeLaunchBinding([
        TRUSTED_OPENCODE_EXECUTABLE_ARG,
        `/proc/self/fd/${parentFd}`,
      ]);
      const stdio: Array<"ignore" | "pipe" | number> = [
        "ignore",
        "pipe",
        "pipe",
      ];
      while (stdio.length <= binding.commandFd!) stdio.push("ignore");
      stdio[binding.commandFd!] = binding.commandFd!;
      const child = spawnSync(
        binding.command,
        ["-e", "process.stdout.write('verified-nested-spawn')"],
        {
          encoding: "utf8",
          stdio,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("verified-nested-spawn");
    } finally {
      closeSync(parentFd);
    }
  });

  it("fails closed instead of accepting an ambient command fallback", () => {
    expect(() => trustedOpenCodeLaunchBinding([]))
      .toThrow("refusing ambient PATH or PAPERCLIP_OPENCODE_COMMAND fallback");
    expect(() => trustedOpenCodeLaunchBinding([
      TRUSTED_OPENCODE_EXECUTABLE_ARG,
      "/tmp/unqualified-opencode",
    ])).toThrow("runner-owned executable binding is unavailable");
    expect(() => trustedOpenCodeLaunchBinding([
      TRUSTED_OPENCODE_EXECUTABLE_ARG,
      "/proc/self/fd/7",
      "unexpected",
    ])).toThrow("runner-owned executable binding is unavailable");
  });

  it("removes the ambient override from the launched provider environment", () => {
    const original = {
      OPENROUTER_API_KEY: "secret",
      PAPERCLIP_OPENCODE_COMMAND: "/tmp/unqualified-opencode",
    };

    expect(withoutAmbientOpenCodeCommand(original)).toEqual({
      OPENROUTER_API_KEY: "secret",
    });
    expect(original.PAPERCLIP_OPENCODE_COMMAND).toBe("/tmp/unqualified-opencode");
  });
});

describe("OpenCode runnerd proxy task envelope", () => {
  it("uses the durable completion-contract binding instead of a demo revision", () => {
    expect(openCodeProxyTaskEnvelope({
      baseInstructions: "Complete only this task.",
      completionContract: {
        revision: "17",
        criterionIds: ["objective", "verification"],
      },
    })).toMatchObject({
      completionContract: {
        revision: "17",
        criteria: [
          { id: "objective" },
          { id: "verification" },
        ],
      },
    });
  });
});
