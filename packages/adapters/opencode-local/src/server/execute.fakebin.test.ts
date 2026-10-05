import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./execute.js";

// These tests drive the REAL exported execute() with real child processes: the
// fake `opencode` binary is placed on PATH (named `opencode`) and both OpenCode
// CLI lines are emulated via FAKE_OPENCODE_MODE. Nothing about the spawn/parse
// pipeline is mocked, so argv shapes, JSONL parsing, error surfacing, and
// skills-home routing are all proven end to end.
const FAKE_OPENCODE_BIN = fileURLToPath(
  new URL("../../test-support/fake-opencode.mjs", import.meta.url),
);

// PROBE-VERIFIED v2 text-only run: step_start + text, NO step_finish.
const V2_TEXT_ONLY_REPLY = [
  JSON.stringify({
    type: "step_start",
    timestamp: 1,
    sessionID: "ses_A",
    part: { id: "prt_1", sessionID: "ses_A", messageID: "msg_1", type: "step-start" },
  }),
  JSON.stringify({
    type: "text",
    timestamp: 2,
    sessionID: "ses_A",
    part: {
      id: "prt_2",
      sessionID: "ses_A",
      messageID: "msg_1",
      type: "text",
      text: "PONG",
      time: { start: 1, end: 2 },
    },
  }),
].join("\n");

// PROBE-VERIFIED v2 tool-using run: step_start | tool_use | step_finish with
// the exact token keys | step_start | text.
const V2_TOOL_RUN_REPLY = [
  JSON.stringify({
    type: "step_start",
    timestamp: 1,
    sessionID: "ses_B",
    part: { id: "prt_s1", sessionID: "ses_B", messageID: "msg_1", type: "step-start" },
  }),
  JSON.stringify({
    type: "tool_use",
    timestamp: 2,
    sessionID: "ses_B",
    part: {
      id: "prt_t1",
      sessionID: "ses_B",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "echo hi" },
        output: "hi\n",
      },
    },
  }),
  JSON.stringify({
    type: "step_finish",
    timestamp: 3,
    sessionID: "ses_B",
    part: {
      id: "prt_f1",
      sessionID: "ses_B",
      messageID: "msg_1",
      type: "step-finish",
      reason: "tool-calls",
      cost: 0,
      tokens: {
        input: 7540,
        output: 17,
        reasoning: 37,
        cache: { read: 3200, write: 0 },
      },
    },
  }),
  JSON.stringify({
    type: "step_start",
    timestamp: 4,
    sessionID: "ses_B",
    part: { id: "prt_s2", sessionID: "ses_B", messageID: "msg_1", type: "step-start" },
  }),
  JSON.stringify({
    type: "text",
    timestamp: 5,
    sessionID: "ses_B",
    part: {
      id: "prt_2_text-0",
      sessionID: "ses_B",
      messageID: "msg_1",
      type: "text",
      text: "Done",
      time: { start: 4, end: 5 },
    },
  }),
].join("\n");

// PROBE-VERIFIED v2 cancellation envelope: exactly one object, no top-level type.
const V2_CANCEL_REPLY = JSON.stringify({
  error: { type: "unknown", message: "Command cancelled" },
  content: [],
});

// v1 run envelope mirrors the parse.test.ts v1 fixtures (simple `part` shapes).
const V1_RUN_REPLY = [
  JSON.stringify({
    type: "text",
    sessionID: "ses_v1",
    part: { text: "Hello from OpenCode" },
  }),
  JSON.stringify({
    type: "tool_use",
    sessionID: "ses_v1",
    part: {
      state: {
        status: "completed",
        input: { command: "echo hi" },
        output: "hi\n",
      },
    },
  }),
  JSON.stringify({
    type: "step_finish",
    sessionID: "ses_v1",
    part: {
      reason: "done",
      cost: 0.0025,
      tokens: {
        input: 120,
        output: 40,
        reasoning: 10,
        cache: { read: 20, write: 0 },
      },
    },
  }),
].join("\n");

interface FakeRunFixture {
  root: string;
  home: string;
  workspace: string;
  binDir: string;
  argsFile: string;
  env: Record<string, string>;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (!root) continue;
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

async function createFakeRunFixture(options: {
  mode: "v1" | "v2";
  reply: string;
}): Promise<FakeRunFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-fakebin-"));
  cleanupRoots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const argsFile = path.join(root, "opencode-args.jsonl");
  const replyFile = path.join(root, "reply.jsonl");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(replyFile, options.reply, "utf8");
  // The fake is a standalone executable node script; the PATH shim is a plain
  // symlink named `opencode` so the adapter resolves it exactly like the real CLI.
  await fs.chmod(FAKE_OPENCODE_BIN, 0o755);
  await fs.symlink(FAKE_OPENCODE_BIN, path.join(binDir, "opencode"));
  return {
    root,
    home,
    workspace,
    binDir,
    argsFile,
    env: {
      HOME: home,
      // A fresh config home keeps the runtime-config copy source hermetic:
      // the adapter copies <XDG_CONFIG_HOME>/opencode into its isolated runtime
      // home, and a developer's real skills links would pre-seed that copy.
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_OPENCODE_MODE: options.mode,
      FAKE_OPENCODE_ARGS_FILE: argsFile,
      FAKE_OPENCODE_REPLY: replyFile,
      // Tests without this bypass would run the `opencode models` availability
      // probe against the fake listing; the probe itself is covered separately.
      OPENCODE_ALLOW_ALL_MODELS: "1",
    },
  };
}

interface CapturedRun {
  argv: string[];
  stdinBytes: number;
  stdinPrefix: string;
  xdgConfigHome: string | null;
}

async function readCapturedRuns(argsFile: string): Promise<CapturedRun[]> {
  const raw = await fs.readFile(argsFile, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedRun);
}

async function readCapturedArgs(argsFile: string): Promise<string[][]> {
  return (await readCapturedRuns(argsFile)).map((run) => run.argv);
}

function expectFlagValue(args: string[], flag: string, value: string) {
  const index = args.indexOf(flag);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBe(value);
}

interface RunOverrides {
  model?: string;
  variant?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  skills?: Array<{ key: string; runtimeName: string; source: string }>;
  context?: Record<string, unknown>;
  autoApprove?: boolean;
  dangerouslySkipPermissions?: boolean;
}

async function runExecute(
  fixture: FakeRunFixture,
  overrides: RunOverrides = {},
): Promise<{ result: Awaited<ReturnType<typeof execute>>; logs: string[] }> {
  const logs: string[] = [];
  const result = await execute({
    runId: `run-fakebin-${Math.random().toString(16).slice(2)}`,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenCode Coder",
      adapterType: "opencode_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "opencode",
      cwd: fixture.workspace,
      model: overrides.model ?? "p/m",
      variant: overrides.variant ?? "high",
      promptTemplate: "Run the task.",
      env: { ...fixture.env, ...overrides.env },
      ...(overrides.extraArgs ? { extraArgs: overrides.extraArgs } : {}),
      ...(overrides.skills ? { paperclipRuntimeSkills: overrides.skills } : {}),
      ...(overrides.autoApprove !== undefined ? { autoApprove: overrides.autoApprove } : {}),
      ...(overrides.dangerouslySkipPermissions !== undefined
        ? { dangerouslySkipPermissions: overrides.dangerouslySkipPermissions }
        : {}),
    },
    context: overrides.context ?? {},
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
  });
  return { result, logs };
}

function runFake(
  args: string[],
  mode: "v1" | "v2",
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FAKE_OPENCODE_BIN, args, {
      env: { ...process.env, FAKE_OPENCODE_MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}

describe("fake opencode CLI contract", () => {
  it("prints the bare v1 version banner", async () => {
    const result = await runFake(["--version"], "v1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1.18.32");
  });

  it("prints the prefixed v2 version banner", async () => {
    const result = await runFake(["--version"], "v2");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("opencode v2.0.18");
  });

  it("lists models including a #variant-suffixed id on the v1 line and accepts --refresh", async () => {
    const result = await runFake(["models", "--refresh"], "v1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("opencode-go/mimo-v2.6-pro");
    expect(result.stdout).toContain("weird/model#variant");
  });

  it("lists models on the v2 line but rejects --refresh with a stderr error", async () => {
    const plain = await runFake(["models"], "v2");
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toContain("opencode-go/mimo-v2.6-pro");
    expect(plain.stdout).toContain("weird/model#variant");

    const refreshed = await runFake(["models", "--refresh"], "v2");
    expect(refreshed.exitCode).toBe(1);
    expect(refreshed.stdout).toBe("");
    expect(refreshed.stderr).toContain("unknown option");
    expect(refreshed.stderr).toContain("--refresh");
  });

  it("fails a v2 run carrying --variant with the run help text and zero JSONL", async () => {
    const result = await runFake(["run", "--format", "json", "--variant", "high"], "v2");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("DESCRIPTION");
    expect(
      result.stdout
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith("{")),
    ).toHaveLength(0);
  });
});

describe("opencode-local driven by the fake opencode CLI", () => {
  it("drives the v1 CLI with run --format json, --variant, and --model and parses the reply", async () => {
    const fixture = await createFakeRunFixture({ mode: "v1", reply: V1_RUN_REPLY });

    const { result } = await runExecute(fixture);

    expect(result.exitCode).toBe(0);
    const captured = await readCapturedRuns(fixture.argsFile);
    expect(captured).toHaveLength(1);
    // Plan §5.3: the prompt must reach the v1 CLI on stdin, not as a positional
    // argv token — nonzero bytes whose prefix is the configured prompt.
    expect(captured[0].stdinBytes).toBeGreaterThan(0);
    expect(captured[0].stdinPrefix.startsWith("Run the task.")).toBe(true);
    const args = captured[0].argv;
    expect(args.slice(0, 3)).toEqual(["run", "--format", "json"]);
    expectFlagValue(args, "--model", "p/m");
    expectFlagValue(args, "--variant", "high");
    expect(result.summary).toBe("Hello from OpenCode");
    expect(result.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(result.costUsd).toBeCloseTo(0.0025, 6);
  });

  it("drives the v2 CLI with a folded --model, --standalone, --auto, and a leading --print-logs", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_TEXT_ONLY_REPLY });

    const { result } = await runExecute(fixture, {
      env: { PAPERCLIP_OPENCODE_PRINT_LOGS: "1" },
    });

    expect(result.exitCode).toBe(0);
    const captured = await readCapturedArgs(fixture.argsFile);
    expect(captured).toHaveLength(1);
    const args = captured[0];
    expect(args).not.toContain("--variant");
    expect(args).toContain("--standalone");
    expect(args).toContain("--auto");
    expectFlagValue(args, "--model", "p/m#high");
    const runIndex = args.indexOf("run");
    const printLogsIndex = args.indexOf("--print-logs");
    expect(runIndex).toBeGreaterThan(0);
    expect(printLogsIndex).toBeGreaterThanOrEqual(0);
    expect(printLogsIndex).toBeLessThan(runIndex);
  });

  it("emits no --auto for a v2 run when dangerouslySkipPermissions is false even with default autoApprove", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_TEXT_ONLY_REPLY });

    const { result } = await runExecute(fixture, { dangerouslySkipPermissions: false });

    expect(result.exitCode).toBe(0);
    const captured = await readCapturedArgs(fixture.argsFile);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("--standalone");
    expect(captured[0]).not.toContain("--auto");
  });

  it("emits no --auto for a v2 run when autoApprove is explicitly false", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_TEXT_ONLY_REPLY });

    const { result } = await runExecute(fixture, { autoApprove: false });

    expect(result.exitCode).toBe(0);
    const captured = await readCapturedArgs(fixture.argsFile);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain("--auto");
  });

  it("tolerates a v2 text-only reply with no step_finish and reports zero usage", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_TEXT_ONLY_REPLY });

    const { result } = await runExecute(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("PONG");
    expect(result.usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(result.costUsd).toBe(0);
    expect(result.errorMessage).toBeNull();
  });

  it("rolls up v2 tool-run tokens from step_finish with reasoning counted as output", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_TOOL_RUN_REPLY });

    const { result } = await runExecute(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Done");
    expect(result.usage).toEqual({
      inputTokens: 7540,
      cachedInputTokens: 3200,
      outputTokens: 54,
    });
    expect(result.costUsd).toBe(0);
  });

  it("surfaces a v2 cancellation envelope as an adapter error instead of silent success", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_CANCEL_REPLY });

    const { result } = await runExecute(fixture);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Command cancelled");
    expect(result.summary).toBe("");
  });

  it("fails a v2 run that forces --variant through extraArgs instead of reporting empty success", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_TEXT_ONLY_REPLY });

    const { result } = await runExecute(fixture, { extraArgs: ["--variant", "high"] });

    expect(result.exitCode).toBe(2);
    expect(result.errorMessage).toMatch(/exited with code 2/);
    expect(result.summary).toBe("");
    const captured = await readCapturedArgs(fixture.argsFile);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("--variant");
  });

  it.each([
    {
      line: "v1" as const,
      banner: "1.18.32",
      reply: V1_RUN_REPLY,
      // v1 injects into the HOME-based ~/.claude/skills (persistent).
      expectedSubpath: [".claude", "skills"] as string[],
      unexpectedSubpath: [".config", "opencode", "skills"] as string[],
    },
    {
      line: "v2" as const,
      banner: "opencode v2.0.18",
      reply: V2_TEXT_ONLY_REPLY,
      // v2 injects into the EFFECTIVE config home the run sees (its own
      // XDG_CONFIG_HOME) — the HOME-based ~/.claude/skills is not touched.
      expectedSubpath: null,
      unexpectedSubpath: [".claude", "skills"] as string[],
    },
  ])(
    "injects runtime skills into the $line home picked by the detected version banner",
    async ({ line, banner, reply, expectedSubpath, unexpectedSubpath }) => {
      const fixture = await createFakeRunFixture({ mode: line, reply });
      const skillSource = await createSkillDir(path.join(fixture.root, "runtime-skills"), "paperclip");

      const { result, logs } = await runExecute(fixture, {
        variant: "",
        skills: [{ key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: skillSource }],
      });

      expect(result.exitCode).toBe(0);
      const capturedRuns = await readCapturedRuns(fixture.argsFile);
      expect(capturedRuns).toHaveLength(1);
      const runXdgConfigHome = capturedRuns[0].xdgConfigHome;
      expect(runXdgConfigHome).toBeTruthy();
      const injectedHome = expectedSubpath
        ? path.join(fixture.home, ...expectedSubpath)
        : path.join(runXdgConfigHome as string, "opencode", "skills");
      if (expectedSubpath) {
        const installedSkill = path.join(injectedHome, "paperclip");
        expect((await fs.lstat(installedSkill)).isSymbolicLink()).toBe(true);
        expect(await fs.realpath(installedSkill)).toBe(await fs.realpath(skillSource));
      }
      // The injection message names the home the skills landed in — for v2 that
      // must be the native skills dir under the run's actual XDG_CONFIG_HOME.
      expect(logs.join("")).toContain(
        `Injected OpenCode skill "paperclipai/paperclip/paperclip" into ${injectedHome}`,
      );
      await expect(
        fs.lstat(path.join(fixture.home, ...unexpectedSubpath, "paperclip")),
      ).rejects.toThrow();
      expect(logs.join("")).toContain(`Detected OpenCode ${banner} (line: ${line}).`);
    },
  );

  it("accepts a #variant-qualified model straight from the v2 models listing without re-qualifying it", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_TEXT_ONLY_REPLY });

    const { result } = await runExecute(fixture, {
      env: { OPENCODE_ALLOW_ALL_MODELS: "0" },
      model: "weird/model#variant",
      variant: "",
    });

    expect(result.exitCode).toBe(0);
    const captured = await readCapturedArgs(fixture.argsFile);
    expect(captured).toHaveLength(1);
    expectFlagValue(captured[0], "--model", "weird/model#variant");
  });

  it("fails before spawning a run when the model is absent from the CLI models listing", async () => {
    const fixture = await createFakeRunFixture({ mode: "v2", reply: V2_TEXT_ONLY_REPLY });

    await expect(
      runExecute(fixture, { env: { OPENCODE_ALLOW_ALL_MODELS: "0" } }),
    ).rejects.toThrow("Configured OpenCode model is unavailable: p/m");
    await expect(fs.readFile(fixture.argsFile, "utf8")).rejects.toThrow();
  });
});
