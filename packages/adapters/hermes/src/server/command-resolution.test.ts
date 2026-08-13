import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const runChildProcessMock = vi.hoisted(() => vi.fn(async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
})));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: runChildProcessMock,
  };
});

import { HERMES_CLI } from "../shared/constants.js";
import {
  buildHermesInvocation,
  execute,
  resolveHermesCommand,
  validateHermesAdapterConfig,
  validateHermesCommandConfig,
} from "./execute.js";
import { resolveProvider } from "./detect-model.js";

const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  HERMES_HOME: process.env.HERMES_HOME,
  HERMES_S6_SUPERVISED_CHILD: process.env.HERMES_S6_SUPERVISED_CHILD,
};

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  runChildProcessMock.mockClear();
});

test("passes the explicit MoA provider from resolution through Hermes invocation", () => {
  const resolved = resolveProvider({ explicitProvider: "moa", model: "local-daily" });
  expect(resolved).toEqual({ provider: "moa", resolvedFrom: "adapterConfig" });

  const invocation = buildHermesInvocation({
    config: {},
    prompt: "hello",
    model: "local-daily",
    resolvedProvider: resolved.provider,
  });

  expect(invocation.args).toEqual(expect.arrayContaining(["--provider", "moa"]));
});

describe("resolveHermesCommand", () => {
  test("accepts blank/default command values only", () => {
    expect(resolveHermesCommand({})).toBe(HERMES_CLI);
    expect(resolveHermesCommand({ command: "" })).toBe(HERMES_CLI);
    expect(resolveHermesCommand({ hermesCommand: "" })).toBe(HERMES_CLI);
    expect(resolveHermesCommand({ command: "hermes" })).toBe(HERMES_CLI);
    expect(resolveHermesCommand({ hermesCommand: "hermes" })).toBe(HERMES_CLI);
  });

  test("rejects non-default command and hermesCommand overrides", () => {
    expect(() => resolveHermesCommand({ command: "hermes-dev" })).toThrow(/command/i);
    expect(() => resolveHermesCommand({ hermesCommand: "/usr/local/bin/hermes" })).toThrow(/hermesCommand/i);
    expect(() => resolveHermesCommand({ command: "python3" })).toThrow(/command/i);
    expect(() => resolveHermesCommand({ hermesCommand: "python3" })).toThrow(/hermesCommand/i);
    expect(() => validateHermesCommandConfig({ command: "hermes-dev" })).toThrow(/command/i);
    expect(() => validateHermesCommandConfig({ hermesCommand: "/usr/local/bin/hermes" })).toThrow(/hermesCommand/i);
    expect(() => validateHermesCommandConfig({ hermesCommand: "hermes_alias" })).toThrow(/hermesCommand/i);
  });

  test("rejects present non-string command and hermesCommand values", () => {
    for (const [key, value] of [
      ["command", 1],
      ["command", true],
      ["command", { value: "hermes" }],
      ["command", ["hermes"]],
      ["hermesCommand", 1],
      ["hermesCommand", false],
      ["hermesCommand", { value: "hermes" }],
      ["hermesCommand", ["hermes"]],
    ] as const) {
      expect(() => validateHermesCommandConfig({ [key]: value })).toThrow(key);
      expect(() => validateHermesAdapterConfig({ [key]: value })).toThrow(key);
      expect(() => resolveHermesCommand({ [key]: value })).toThrow(key);
    }
  });

  test("allows absent, null, blank, and exact built-in command values", () => {
    for (const config of [
      {},
      { command: null },
      { hermesCommand: null },
      { command: "" },
      { hermesCommand: "" },
      { command: "hermes" },
      { hermesCommand: "hermes" },
    ]) {
      expect(() => validateHermesCommandConfig(config)).not.toThrow();
      expect(() => validateHermesAdapterConfig(config)).not.toThrow();
    }
  });
});

describe("buildHermesInvocation", () => {
  test("default invocation contains no dangerous-command bypass flag", () => {
    const invocation = buildHermesInvocation({
      config: {},
      prompt: "hello",
      model: "anthropic/claude-sonnet-4",
      resolvedProvider: "auto",
    });

    expect(invocation.command).toBe(HERMES_CLI);
    expect(invocation.args).not.toContain("--yolo");
  });

  test("explicit dangerousCommandBypass=true contains exactly one yolo flag", () => {
    const invocation = buildHermesInvocation({
      config: { dangerousCommandBypass: true },
      prompt: "hello",
      model: "anthropic/claude-sonnet-4",
      resolvedProvider: "auto",
    });

    expect(invocation.args.filter((arg) => arg === "--yolo")).toHaveLength(1);
  });

  test("valid profile appears before chat and exactly once", () => {
    const invocation = buildHermesInvocation({
      config: { profile: "agent_01-prod" },
      prompt: "hello",
      model: "anthropic/claude-sonnet-4",
      resolvedProvider: "auto",
    });

    expect(invocation.args.slice(0, 3)).toEqual(["--profile", "agent_01-prod", "chat"]);
    expect(invocation.args.filter((arg) => arg === "--profile")).toHaveLength(1);
    expect(invocation.args.filter((arg) => arg === "agent_01-prod")).toHaveLength(1);
  });

  test("default profile is accepted", () => {
    const invocation = buildHermesInvocation({
      config: { profile: "default" },
      prompt: "hello",
      model: "anthropic/claude-sonnet-4",
      resolvedProvider: "auto",
    });

    expect(invocation.args.slice(0, 3)).toEqual(["--profile", "default", "chat"]);
  });

  test("invalid profile variants reject before spawn", () => {
    for (const profile of [
      "Agent",
      " agent",
      "agent profile",
      "../agent",
      "agent/profile",
      "agent;rm",
      "agent$HOME",
      "agent.name",
      "-agent",
      "_agent",
      "a".repeat(65),
    ]) {
      expect(() => buildHermesInvocation({
        config: { profile },
        prompt: "hello",
        model: "anthropic/claude-sonnet-4",
        resolvedProvider: "auto",
      })).toThrow(/profile/i);
    }
  });

  test("reserved profile names reject before spawn", () => {
    for (const profile of ["hermes", "test", "tmp", "root", "sudo"]) {
      expect(() => validateHermesAdapterConfig({ profile })).toThrow(/reserved/i);
      expect(() => buildHermesInvocation({
        config: { profile },
        prompt: "hello",
        model: "anthropic/claude-sonnet-4",
        resolvedProvider: "auto",
      })).toThrow(/reserved/i);
    }
  });

  test("blank profile and empty extraArgs are accepted", () => {
    const invocation = buildHermesInvocation({
      config: { profile: "", extraArgs: [] },
      prompt: "hello",
      model: "anthropic/claude-sonnet-4",
      resolvedProvider: "auto",
    });

    expect(invocation.args[0]).toBe("chat");
  });

  test("non-empty or malformed extraArgs rejects", () => {
    for (const extraArgs of [
      ["--profile", "other"],
      "--profile other",
      { value: "--profile other" },
      [1],
    ]) {
      expect(() => buildHermesInvocation({
        config: { extraArgs },
        prompt: "hello",
        model: "anthropic/claude-sonnet-4",
        resolvedProvider: "auto",
      })).toThrow(/extraArgs/i);
    }
  });

  test("rejects malformed command types before building invocation", () => {
    for (const config of [
      { command: 1 },
      { command: true },
      { command: { value: "hermes" } },
      { command: ["hermes"] },
      { hermesCommand: 1 },
      { hermesCommand: false },
      { hermesCommand: { value: "hermes" } },
      { hermesCommand: ["hermes"] },
    ]) {
      expect(() => buildHermesInvocation({
        config,
        prompt: "hello",
        model: "anthropic/claude-sonnet-4",
        resolvedProvider: "auto",
      })).toThrow(/command/i);
    }
  });

  test("execute rejects malformed command types before logs or subprocess spawn", async () => {
    const logs: string[] = [];

    await expect(execute({
      runId: "run-test",
      config: {
        command: { value: "hermes" },
        instructionsFilePath: "/path/that/must/not/be/read",
      },
      agent: {
        id: "agent-test",
        companyId: "company-test",
        name: "Hermes Test",
      },
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
        logs.push(chunk);
      },
    } as any)).rejects.toThrow(/command/i);

    expect(logs).toEqual([]);
    expect(runChildProcessMock).not.toHaveBeenCalled();
  });

  test("execute rejects explicit missing profile before detection, instruction read, logs, or subprocess spawn", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
    const invalidInstructionsPath = join(tempHome, "SECRET_INSTRUCTION_MARKER-must-not-be-read.md");
    const logs: string[] = [];
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.HERMES_HOME;
    delete process.env.HERMES_S6_SUPERVISED_CHILD;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    try {
      await mkdir(join(tempHome, ".hermes"), { recursive: true });
      await writeFile(join(tempHome, ".hermes", "config.yaml"), [
        "model:",
        "  default: openrouter/root-model",
        "  provider: openrouter",
        "  api_key: root-secret-marker",
      ].join("\n"), "utf8");

      await expect(execute({
        runId: "run-test",
        config: {
          profile: "missing-profile",
          model: "openrouter/root-model",
          instructionsFilePath: invalidInstructionsPath,
        },
        agent: {
          id: "agent-test",
          companyId: "company-test",
          name: "Hermes Test",
        },
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
          logs.push(chunk);
        },
      } as any)).rejects.toThrow(/selected Hermes profile/i);

      expect(logs).toEqual([]);
      expect(runChildProcessMock).not.toHaveBeenCalled();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(tempHome);
      expect(message).not.toContain("SECRET_INSTRUCTION_MARKER");
      throw err;
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("preserves session provider and toolset arguments", () => {
    const invocation = buildHermesInvocation({
      config: {
        toolsets: "terminal,file,web",
        maxTurnsPerRun: 7,
        persistSession: true,
        quiet: true,
        worktreeMode: true,
        checkpoints: true,
        verbose: true,
      },
      prompt: "hello",
      model: "anthropic/claude-sonnet-4",
      resolvedProvider: "openrouter",
      previousSessionId: "session-123",
    });

    expect(invocation.args).toEqual([
      "chat",
      "-q",
      "hello",
      "-Q",
      "-m",
      "anthropic/claude-sonnet-4",
      "--provider",
      "openrouter",
      "-t",
      "terminal,file,web",
      "--max-turns",
      "7",
      "-w",
      "--checkpoints",
      "-v",
      "--source",
      "tool",
      "--resume",
      "session-123",
    ]);
  });
});

describe("execute Hermes home pinning", () => {
  async function createHermesRoot(activeProfile?: string) {
    const tempHome = await mkdtemp(join(tmpdir(), "hermes-paperclip-adapter-"));
    const root = join(tempHome, ".hermes");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "config.yaml"), [
      "model:",
      "  default: openrouter/root-model",
      "  provider: openrouter",
    ].join("\n"), "utf8");

    const profilesRoot = join(root, "profiles");
    for (const profile of ["active", "named", "other"]) {
      const profileHome = join(profilesRoot, profile);
      await mkdir(profileHome, { recursive: true });
      await writeFile(join(profileHome, "config.yaml"), [
        "model:",
        `  default: openrouter/${profile}-model`,
        "  provider: openrouter",
      ].join("\n"), "utf8");
    }

    if (activeProfile !== undefined) {
      await writeFile(join(root, "active_profile"), `${activeProfile}\n`, "utf8");
    }

    return { tempHome, root, profilesRoot };
  }

  function makeExecuteContext(config: Record<string, unknown>, logs: string[] = []) {
    return {
      runId: "run-test",
      config,
      agent: {
        id: "agent-test",
        companyId: "company-test",
        name: "Hermes Test",
      },
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
        logs.push(chunk);
      },
    } as any;
  }

  function lastSpawnCall() {
    return runChildProcessMock.mock.calls.at(-1)! as unknown as [
      string,
      string,
      string[],
      { env: Record<string, string> },
    ];
  }

  function expectExactlyOneProfileSelector(args: string[], profile: string) {
    expect(args.slice(0, 3)).toEqual(["--profile", profile, "chat"]);
    expect(args.filter((arg: string) => arg === "--profile")).toHaveLength(1);
    expect(args.filter((arg: string) => arg === profile)).toHaveLength(1);
  }

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["default", "default"],
  ] as const)("pins implicit root selection against active_profile TOCTOU when sticky is %s", async (_label, initialActiveProfile) => {
    const { tempHome, root, profilesRoot } = await createHermesRoot(initialActiveProfile);
    const selectedLaterHome = join(profilesRoot, "active");
    const logs: string[] = [];
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.HERMES_HOME = root;
    delete process.env.HERMES_S6_SUPERVISED_CHILD;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    try {
      await execute({
        ...makeExecuteContext({
          model: "openrouter/root-model",
        }, logs),
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
          logs.push(chunk);
          if (chunk.includes("Starting Hermes Agent")) {
            await writeFile(join(root, "active_profile"), "active\n", "utf8");
          }
        },
      } as any);

      const [, , args, options] = lastSpawnCall();
      expectExactlyOneProfileSelector(args, "default");
      expect(options.env.HERMES_HOME).toBe(root);
      expect(options.env.HERMES_HOME).not.toBe(selectedLaterHome);
      expect(logs.join("")).not.toContain(root);
      expect(logs.join("")).not.toContain(selectedLaterHome);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("pins supervised root selection against hostile agent environment", async () => {
    const { tempHome, root, profilesRoot } = await createHermesRoot("active");
    const unselectedHome = join(profilesRoot, "other");
    const logs: string[] = [];
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.HERMES_HOME = root;
    process.env.HERMES_S6_SUPERVISED_CHILD = "1";
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    try {
      await execute(makeExecuteContext({
        model: "openrouter/root-model",
        env: {
          HERMES_HOME: unselectedHome,
          HERMES_S6_SUPERVISED_CHILD: "",
        },
      }, logs));

      const [, , args, options] = lastSpawnCall();
      expectExactlyOneProfileSelector(args, "default");
      expect(options.env.HERMES_HOME).toBe(root);
      expect(options.env.HERMES_HOME).not.toBe(unselectedHome);
      expect(options.env.HERMES_S6_SUPERVISED_CHILD).toBe("1");
      expect(logs.join("")).not.toContain(root);
      expect(logs.join("")).not.toContain(unselectedHome);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("pins sticky selected Hermes home after process and agent env are merged", async () => {
    const { tempHome, root, profilesRoot } = await createHermesRoot("active");
    const selectedHome = join(profilesRoot, "active");
    const unselectedHome = join(profilesRoot, "other");
    const logs: string[] = [];
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.HERMES_HOME = root;
    delete process.env.HERMES_S6_SUPERVISED_CHILD;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    try {
      await execute(makeExecuteContext({
        model: "openrouter/root-model",
        env: {
          HERMES_HOME: unselectedHome,
        },
      }, logs));

      const [, , args, options] = lastSpawnCall();
      expect(options.env.HERMES_HOME).toBe(selectedHome);
      expect(options.env.HERMES_HOME).not.toBe(root);
      expect(options.env.HERMES_HOME).not.toBe(unselectedHome);
      expect(options.env.HERMES_HOME).not.toContain("openrouter");
      expect(args).not.toContain("--profile");
      expect(args[0]).toBe("chat");
      expect(logs.join("")).not.toContain(selectedHome);
      expect(logs.join("")).not.toContain(root);
      expect(logs.join("")).not.toContain(unselectedHome);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("pins root/default selected Hermes home consistently", async () => {
    const { tempHome, root, profilesRoot } = await createHermesRoot();
    const unselectedHome = join(profilesRoot, "other");
    const logs: string[] = [];
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.HERMES_HOME = root;
    delete process.env.HERMES_S6_SUPERVISED_CHILD;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    try {
      await execute(makeExecuteContext({
        profile: "default",
        model: "openrouter/root-model",
        env: {
          HERMES_HOME: unselectedHome,
        },
      }, logs));

      const [, , args, options] = lastSpawnCall();
      expect(options.env.HERMES_HOME).toBe(root);
      expect(options.env.HERMES_HOME).not.toBe(unselectedHome);
      expect(args.slice(0, 3)).toEqual(["--profile", "default", "chat"]);
      expect(logs.join("")).not.toContain(root);
      expect(logs.join("")).not.toContain(unselectedHome);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("pins explicit named selected Hermes home consistently", async () => {
    const { tempHome, root, profilesRoot } = await createHermesRoot("active");
    const selectedHome = join(profilesRoot, "named");
    const unselectedHome = join(profilesRoot, "other");
    const logs: string[] = [];
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.HERMES_HOME = root;
    delete process.env.HERMES_S6_SUPERVISED_CHILD;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    try {
      await execute(makeExecuteContext({
        profile: "named",
        model: "openrouter/named-model",
        env: {
          HERMES_HOME: unselectedHome,
        },
      }, logs));

      const [, , args, options] = lastSpawnCall();
      expect(options.env.HERMES_HOME).toBe(selectedHome);
      expect(options.env.HERMES_HOME).not.toBe(root);
      expect(options.env.HERMES_HOME).not.toBe(unselectedHome);
      expect(args.slice(0, 3)).toEqual(["--profile", "named", "chat"]);
      expect(args.filter((arg: string) => arg === "--profile")).toHaveLength(1);
      expect(logs.join("")).not.toContain(selectedHome);
      expect(logs.join("")).not.toContain(root);
      expect(logs.join("")).not.toContain(unselectedHome);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
