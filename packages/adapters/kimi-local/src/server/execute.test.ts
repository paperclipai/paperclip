import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  prepareSandboxManagedRuntime,
  type SandboxManagedRuntimeClient,
} from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

const execFile = promisify(execFileCallback);

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async (_input: {
  assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean }>;
}) => ({
  workspaceRemoteDir: null as string | null,
  runtimeRootDir: null as string | null,
  assetDirs: {} as Record<string, string>,
  restoreWorkspace: async () => {},
})));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "kimi"));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: (target: { kind?: string } | null) => target?.kind === "remote",
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  adapterExecutionTargetUsesManagedHome: () => false,
  adapterExecutionTargetUsesPaperclipBridge: () => false,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  readAdapterExecutionTargetHomeDir: async () => null,
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
  runAdapterExecutionTargetShellCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  startAdapterExecutionTargetPaperclipBridge: async () => null,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kimi-local-"));
  tempRoots.push(root);
  return root;
}

function makeContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Kimi Agent",
      adapterType: "kimi_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { cwd: root },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  };
  // Default these CLI-lane tests to the CLI engine so they never depend on
  // whether `kimi` is resolvable on PATH (ACP is the runtime default). Tests
  // that need ACP can set engine explicitly in their config override.
  ctx.config = { engine: "cli", ...ctx.config };
  return ctx;
}

const KIMI_STDOUT = [
  JSON.stringify({ role: "assistant", content: "done" }),
  JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: "session_abc-123",
    command: "kimi -r session_abc-123",
  }),
].join("\n");

describe("kimi_local execute", () => {
  beforeEach(() => {
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("runs kimi headless with stream-json and captures the session id from the meta event", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, args, options) => {
      seenArgs = args;
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    const result = await execute(makeContext(root));

    expect(seenArgs[0]).toBe("--output-format");
    expect(seenArgs[1]).toBe("stream-json");
    expect(seenArgs).not.toContain("-m");
    expect(seenArgs).not.toContain("-r");
    expect(seenArgs[seenArgs.length - 2]).toBe("-p");
    expect(seenEnv.CI).toBe("1");
    expect(seenEnv.NO_COLOR).toBe("1");
    expect(seenEnv.KIMI_CODE_NO_AUTO_UPDATE).toBe("1");
    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "session_abc-123",
      sessionDisplayId: "session_abc-123",
    });
    expect(result.sessionParams).toMatchObject({
      sessionId: "session_abc-123",
      cwd: root,
    });
  });

  it("delivers the owned assignment and ordered wake comments through the CLI prompt", async () => {
    const root = await makeTempRoot();
    const fixture = createPromptContextFixture();
    let deliveredPrompt = "";
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      deliveredPrompt = String(args.at(-1) ?? "");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: KIMI_STDOUT,
        stderr: "",
      };
    });

    await execute(makeContext(root, {
      context: fixture,
    }));

    expect(deliveredPrompt).toContain(fixture.paperclipTaskMarkdownAssignment);
    expect(deliveredPrompt.indexOf("Append the same ledger entry.")).toBeLessThan(
      deliveredPrompt.lastIndexOf("Append the same ledger entry."),
    );
    expect(deliveredPrompt.indexOf("comment-first")).toBeLessThan(
      deliveredPrompt.indexOf("comment-second"),
    );
    expect(deliveredPrompt.indexOf("comment-second")).toBeLessThan(
      deliveredPrompt.indexOf("comment-scope"),
    );
    expect(deliveredPrompt).toContain("Change the final scope to the launch checklist.");
  });

  it("forwards streamed stdout lines to onEvent as assistant + tool_call runtime events", async () => {
    const root = await makeTempRoot();
    const events: Array<{ eventType: string; message?: string; payload?: Record<string, unknown> }> = [];
    const stream =
      `${JSON.stringify({ role: "assistant", content: "Here is my plan" })}\n` +
      `${JSON.stringify({
        role: "assistant",
        content: "running",
        tool_calls: [{ type: "function", id: "t1", function: { name: "Bash", arguments: "{}" } }],
      })}\n`;
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      // Split mid-line so the wrapper's newline buffering is exercised across chunks.
      await options.onLog("stdout", stream.slice(0, 20));
      await options.onLog("stdout", stream.slice(20));
      return { exitCode: 0, signal: null, timedOut: false, stdout: stream, stderr: "" };
    });

    await execute(makeContext(root, { onEvent: async (event) => { events.push(event); } }));

    expect(events).toContainEqual({
      eventType: "assistant",
      stream: "stdout",
      message: "Here is my plan",
      payload: { content: "Here is my plan" },
    });
    expect(events).toContainEqual({ eventType: "tool_call", stream: "stdout", payload: { toolName: "Bash" } });
  });

  it("forwards the final stdout line to onEvent even without a trailing newline", async () => {
    const root = await makeTempRoot();
    const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    // Kimi can close stdout after a valid event with no trailing newline; the
    // forwarder must flush it so the last tool call reaches live status.
    const stream = `${JSON.stringify({
      role: "assistant",
      tool_calls: [{ type: "function", id: "t9", function: { name: "Read", arguments: "{}" } }],
    })}`;
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      await options.onLog("stdout", stream);
      return { exitCode: 0, signal: null, timedOut: false, stdout: stream, stderr: "" };
    });

    await execute(makeContext(root, { onEvent: async (event) => { events.push(event); } }));

    expect(events).toContainEqual({ eventType: "tool_call", stream: "stdout", payload: { toolName: "Read" } });
  });

  it("passes -m only when a model is configured", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model: "kimi-code/k3" } }));

    expect(seenArgs).toContain("-m");
    expect(seenArgs[seenArgs.indexOf("-m") + 1]).toBe("kimi-code/k3");
  });

  it("resumes with -r when the stored session cwd matches the run cwd", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      runtime: {
        sessionId: "session_abc-123",
        sessionParams: { sessionId: "session_abc-123", cwd: root },
        sessionDisplayId: "session_abc-123",
        taskKey: null,
      },
    }));

    expect(seenArgs).toContain("-r");
    expect(seenArgs[seenArgs.indexOf("-r") + 1]).toBe("session_abc-123");
  });

  it("starts a fresh session when the stored session cwd differs", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      runtime: {
        sessionId: "session_abc-123",
        sessionParams: { sessionId: "session_abc-123", cwd: "/some/other/dir" },
        sessionDisplayId: "session_abc-123",
        taskKey: null,
      },
    }));

    expect(seenArgs).not.toContain("-r");
  });

  it("retries fresh when the resume session is unrecoverable", async () => {
    const root = await makeTempRoot();
    const fixture = createPromptContextFixture();
    const seenArgLists: string[][] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgLists.push(args);
      if (seenArgLists.length === 1) {
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "Error: unknown session 'session_stale'" };
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    const result = await execute(makeContext(root, {
      runtime: {
        sessionId: "session_stale",
        sessionParams: { sessionId: "session_stale", cwd: root },
        sessionDisplayId: "session_stale",
        taskKey: null,
      },
      config: { cwd: root, bootstrapPromptTemplate: "BOOTSTRAP {{run.id}}" },
      context: fixture,
    }));

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(seenArgLists[0]).toContain("-r");
    expect(seenArgLists[1]).not.toContain("-r");
    expect(seenArgLists[1].at(-1)).toContain(fixture.paperclipTaskMarkdownAssignment);
    expect(seenArgLists[1].at(-1)).toContain("BOOTSTRAP run-1");
    expect(seenArgLists[1].at(-1)).toContain("comment-first");
    expect(result).toMatchObject({ exitCode: 0, sessionId: "session_abc-123" });
  });

  it("maps auth failures to the kimi_auth_required error code", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: 401 Unauthorized — run kimi login to authenticate",
    }));

    const result = await execute(makeContext(root));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("kimi_auth_required");
    expect(result.errorMessage).toBeTruthy();
  });

  it("reports a timeout when the process exceeds timeoutSec", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockImplementation(async () => ({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
    }));

    const result = await execute(makeContext(root, { config: { cwd: root, timeoutSec: 5 } }));

    expect(result.timedOut).toBe(true);
    expect(result.usageComplete).toBe(true);
    expect(result.costStatus).toBe("unpriced");
    expect(result.costUsd).toBeNull();
    expect(result.errorMessage).toContain("5s");
  });

  it("reports failure when the process is killed by a signal without timing out", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockImplementation(async () => ({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      stdout: "",
      stderr: "",
    }));

    const result = await execute(makeContext(root));

    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toContain("SIGKILL");
    expect(result.errorMessage).not.toBeNull();
  });

  it("preserves user-configured headless env values", async () => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      config: {
        cwd: root,
        env: {
          CI: "0",
          NO_COLOR: "0",
          KIMI_CODE_NO_AUTO_UPDATE: "0",
          TERM: "xterm-256color",
        },
      },
    }));

    expect(seenEnv.CI).toBe("0");
    expect(seenEnv.NO_COLOR).toBe("0");
    expect(seenEnv.KIMI_CODE_NO_AUTO_UPDATE).toBe("0");
    expect(seenEnv.TERM).toBe("xterm-256color");
  });

  it.each(["kimi-code/k3", "kimi-code/k3-256k", "kimi-code/kimi-for-coding"])("forwards configured effort for %s", async (model) => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model, effort: "high" } }));

    expect(seenEnv.KIMI_MODEL_THINKING_EFFORT).toBe("high");
  });

  it("maps the medium effort tier onto high since Kimi has no medium", async () => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model: "kimi-code/k3", effort: "medium" } }));

    expect(seenEnv.KIMI_MODEL_THINKING_EFFORT).toBe("high");
  });

  it("does not forward effort for models without support_efforts", async () => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      config: { cwd: root, model: "kimi-code/kimi-for-coding-highspeed", effort: "high" },
    }));

    expect(seenEnv.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
  });

  it("adds --add-dir for the instructions directory and names sibling files in the prompt", async () => {
    const root = await makeTempRoot();
    const instructionsDir = path.join(root, "instructions");
    await fs.mkdir(instructionsDir, { recursive: true });
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, "# Role\nYou are the lead agent.\n");

    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, instructionsFilePath } }));

    expect(seenArgs).toContain("--add-dir");
    expect(seenArgs[seenArgs.indexOf("--add-dir") + 1]).toBe(instructionsDir);
    const prompt = seenArgs[seenArgs.length - 1];
    expect(prompt).toContain("./HEARTBEAT.md");
    expect(prompt).toContain("./SOUL.md");
    expect(prompt).toContain("./TOOLS.md");
  });

  it("loads the operational skill when no optional skills are configured", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model: "kimi-code/k3" } }));

    expect(seenArgs).toContain("--skills-dir");
    expect(seenArgs[seenArgs.indexOf("--skills-dir") + 1]).toContain("paperclip-kimi-skills-");
  });

  it.skipIf(process.platform !== "linux")("rejects unsafe instructions before remote staging", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    vi.stubEnv("PAPERCLIP_SECRETS_HOST_AGENT_UID", String((process.getuid?.() ?? 1000) + 1));
    const workspace = await makeTempRoot();

    await expect(execute(makeContext(workspace, {
      config: { cwd: workspace, instructionsFilePath: path.join(workspace, "missing-AGENTS.md") },
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/sandbox/workspace" },
    }))).rejects.toThrow();

    expect(prepareRuntimeMock).not.toHaveBeenCalled();
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("rejects a selected skill symlink to a synthetic key before sandbox syncIn", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    const root = await makeTempRoot();
    const workspace = path.join(root, "workspace");
    const skill = path.join(root, "leaky-skill");
    const key = path.join(root, "synthetic-master.key");
    await fs.mkdir(workspace);
    await fs.mkdir(skill);
    await fs.writeFile(path.join(skill, "SKILL.md"), "# skill\n");
    await fs.writeFile(key, "synthetic-kimi-master-key-bytes\n");
    await fs.symlink(key, path.join(skill, "leak"));

    await expect(execute(makeContext(workspace, {
      config: {
        cwd: workspace,
        paperclipRuntimeSkills: [{ key: "company/leaky", runtimeName: "leaky", source: skill }],
        paperclipSkillSync: { desiredSkills: ["company/leaky"] },
      },
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/sandbox/workspace" },
    }))).rejects.toThrow(/symbolic link/);

    expect(prepareRuntimeMock).not.toHaveBeenCalled();
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(await fs.readFile(key, "utf8")).toBe("synthetic-kimi-master-key-bytes\n");
  });

  it.skipIf(process.platform !== "linux")("archives a selected Kimi skill as real files without external key bytes", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME", "true");
    const root = await makeTempRoot();
    const workspace = path.join(root, "workspace");
    const safeSkill = path.join(root, "safe-skill");
    const leakySkill = path.join(root, "leaky-skill");
    const keyBytes = "synthetic-kimi-master-key-bytes\n";
    const key = path.join(root, "synthetic-master.key");
    await fs.mkdir(workspace);
    await fs.mkdir(safeSkill);
    await fs.mkdir(leakySkill);
    await fs.writeFile(path.join(safeSkill, "SKILL.md"), "# ordinary Kimi skill\n");
    await fs.writeFile(path.join(leakySkill, "SKILL.md"), "# leaky skill\n");
    await fs.writeFile(key, keyBytes);
    await fs.symlink(key, path.join(leakySkill, "leak"));
    const archive = path.join(root, "skills.tar");
    const sandboxRoot = path.join(root, "sandbox");
    let syncedSkillsDir = "";
    let syncInArchiveCount = 0;
    prepareRuntimeMock.mockImplementationOnce(async (input) => {
      const asset = input.assets?.find((entry: { key: string }) => entry.key === "skills");
      if (!asset) throw new Error("Kimi skills asset was not staged");
      expect(asset.followSymlinks).toBe(false);
      expect((await fs.lstat(path.join(asset.localDir, "safe"))).isDirectory()).toBe(true);
      const client: SandboxManagedRuntimeClient = {
        makeDir: async (dir) => { await fs.mkdir(dir, { recursive: true }); },
        writeFile: async (file, bytes) => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, Buffer.from(bytes));
        },
        readFile: async (file) => fs.readFile(file),
        listFiles: async (dir) => (await fs.readdir(dir)).sort(),
        remove: async (file) => { await fs.rm(file, { recursive: true, force: true }); },
        run: async (command) => { await execFile("sh", ["-c", command]); },
        syncIn: async (operations) => {
          for (const operation of operations) {
            for (const mapping of operation.files) {
              if (mapping.kind !== "file") throw new Error("Unexpected directory sync in Kimi asset test");
              const bytes = await fs.readFile(mapping.sourcePath);
              if (mapping.targetPath.endsWith("skills-upload.tar")) {
                syncInArchiveCount += 1;
                await fs.writeFile(archive, bytes);
              }
              await fs.mkdir(path.dirname(mapping.targetPath), { recursive: true });
              await fs.writeFile(mapping.targetPath, bytes);
            }
            for (const command of operation.postUploadCommands ?? []) {
              await execFile("sh", ["-c", command.command]);
            }
          }
          return { operations: operations.map((operation) => ({
            operationId: operation.operationId,
            filesTransferred: operation.files.length,
            bytesTransferred: 0,
          })) };
        },
      };
      const staged = await prepareSandboxManagedRuntime({
        spec: { transport: "sandbox", provider: "test", sandboxId: "s1", remoteCwd: sandboxRoot, timeoutMs: 30_000, apiKey: null },
        adapterKey: "kimi",
        client,
        workspaceLocalDir: workspace,
        syncWorkspace: false,
        assets: [asset],
      });
      syncedSkillsDir = staged.assetDirs.skills;
      return {
        workspaceRemoteDir: staged.workspaceRemoteDir,
        runtimeRootDir: staged.runtimeRootDir,
        assetDirs: staged.assetDirs,
        restoreWorkspace: async () => {},
      };
    });
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    const result = await execute(makeContext(workspace, {
      config: {
        cwd: workspace,
        paperclipRuntimeSkills: [
          { key: "company/safe", runtimeName: "safe", source: safeSkill },
          { key: "company/leaky", runtimeName: "leaky", source: leakySkill },
        ],
        paperclipSkillSync: { desiredSkills: ["company/safe"] },
      },
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/sandbox/workspace" },
    }));

    expect(result.exitCode).toBe(0);
    expect(syncInArchiveCount).toBe(1);
    expect(seenArgs[seenArgs.indexOf("--skills-dir") + 1]).toBe(syncedSkillsDir);
    expect(await fs.readFile(path.join(syncedSkillsDir, "safe", "SKILL.md"), "utf8")).toBe("# ordinary Kimi skill\n");
    const { stdout: files } = await execFile("tar", ["-tf", archive]);
    expect(files).toContain("safe/SKILL.md");
    expect(files).not.toContain("leaky/");
    const { stdout: skillBody } = await execFile("tar", ["-xOf", archive, "safe/SKILL.md"]);
    expect(skillBody).toBe("# ordinary Kimi skill\n");
    expect((await fs.readFile(archive)).includes(Buffer.from(keyBytes))).toBe(false);
  });
});
