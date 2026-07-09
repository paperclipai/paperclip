import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import { DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC } from "@paperclipai/adapter-utils/execution-target";
import {
  createAcpxEngineExecutor,
  findAncestorBin,
  geminiVersionSupportsNativeAcpFlag,
  parseGeminiVersionParts,
  rewriteGeminiAcpFlagForVersion,
} from "./execute.js";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function onlyChildDir(parent: string): Promise<string> {
  const entries = await fs.readdir(parent);
  expect(entries).toHaveLength(1);
  return path.join(parent, entries[0]!);
}

async function createSkill(root: string, name: string, body = `---\nrequired: false\n---\n# ${name}\n`) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
  return {
    key: `paperclipai/test/${name}`,
    runtimeName: name,
    source: skillDir,
    required: false,
  };
}

function buildRuntime() {
  return {
    ensureSession: async () => ({
      backendSessionId: "backend-session",
      agentSessionId: "agent-session",
      runtimeSessionName: "runtime-session",
    }),
    startTurn: () => ({
      events: (async function* () {
        yield { type: "done", stopReason: "end_turn" };
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    }),
    close: async () => {},
  };
}

async function runExecutor(
  config: Record<string, unknown>,
  options: {
    context?: Record<string, unknown>;
    executionTransport?: Record<string, unknown>;
    authToken?: string;
    executionTarget?: Record<string, unknown>;
  } = {},
) {
  const runtimeOptions: Record<string, unknown>[] = [];
  const meta: Record<string, unknown>[] = [];
  const logs: Array<{ stream: string; text: string }> = [];
  const execute = createAcpxEngineExecutor({
    createRuntime: (options) => {
      runtimeOptions.push(options as unknown as Record<string, unknown>);
      return buildRuntime() as never;
    },
  });

  const result = await execute({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
    },
      runtime: {},
      config,
      context: options.context ?? {},
      executionTransport: options.executionTransport,
      authToken: options.authToken,
      executionTarget: options.executionTarget,
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
    onMeta: async (payload: unknown) => {
      meta.push(payload as Record<string, unknown>);
    },
  } as never);

  expect(result.exitCode).toBe(0);
  return { logs, meta, runtimeOptions, result };
}

describe("shared ACPX engine runtime behavior", () => {
  it("includes Paperclip env and API access notes in the ACPX prompt without leaking the token", async () => {
    const { meta } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js" },
      {
        authToken: "runtime-secret-token",
        context: {
          taskId: "issue-1",
          wakeReason: "issue_assigned",
          paperclipWake: {
            reason: "issue_assigned",
            issue: { id: "issue-1", identifier: "TEST-1" },
          },
        },
      },
    );

    const prompt = String(meta[0]?.prompt ?? "");
    const promptMetrics = meta[0]?.promptMetrics as Record<string, number> | undefined;
    expect(prompt).toContain("Paperclip runtime note:");
    expect(prompt).toContain("PAPERCLIP_AGENT_ID");
    expect(prompt).toContain("PAPERCLIP_API_KEY");
    expect(prompt).toContain("PAPERCLIP_WAKE_PAYLOAD_JSON");
    expect(prompt).toContain("Paperclip API access note:");
    expect(prompt).toContain('PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"; PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"');
    expect(prompt).toContain("$PAPERCLIP_API_BASE/api/agents/me");
    expect(prompt).toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID");
    expect(prompt).toContain("X-Paperclip-Run-Id");
    expect(prompt).not.toContain("$PAPERCLIP_API_URL/api/");
    expect(prompt).not.toContain("/api/issues/{id}");
    expect(prompt).not.toContain("-d '{...}'");
    expect(prompt).not.toContain("runtime-secret-token");
    expect(promptMetrics?.runtimeNoteChars).toBeGreaterThan(0);
  });

  it("does not show a scoped issue API command when the task id is unavailable", async () => {
    const { meta } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js" },
      { authToken: "runtime-secret-token" },
    );

    const prompt = String(meta[0]?.prompt ?? "");
    expect(prompt).toContain("Paperclip API access note:");
    expect(prompt).toContain("Use a real issue id from the current context before making issue write requests.");
    expect(prompt).not.toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID");
  });

  it.skipIf(process.platform === "win32")("materializes ACPX Claude skills without symlinked descendants", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const outsideRoot = path.join(root, "outside");
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "do not expose", "utf8");
    const skill = await createSkill(skillRoot, "danger");
    await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(skill.source, "leak.txt"));
    await fs.symlink(outsideRoot, path.join(skill.source, "leak-dir"));

    const stateDir = path.join(root, "state");
    const { meta } = await runExecutor({
      agent: "claude",
      stateDir,
      paperclipRuntimeSkills: [skill],
      paperclipSkillSync: { desiredSkills: [skill.key] },
    });

    const mountedRoot = await onlyChildDir(path.join(stateDir, "runtime-skills", "claude"));
    const skillsHome = path.join(mountedRoot, ".claude", "skills");
    const materializedSkill = path.join(skillsHome, skill.runtimeName);
    expect(await fs.readFile(path.join(materializedSkill, "SKILL.md"), "utf8")).toContain("# danger");
    expect(await pathExists(path.join(materializedSkill, "leak.txt"))).toBe(false);
    expect(await pathExists(path.join(materializedSkill, "leak-dir"))).toBe(false);
    expect(String(meta[0]?.prompt ?? "")).toContain(`Skill root: ${skillsHome}`);
  });

  it.skipIf(process.platform === "win32")("revokes removed ACPX Codex skills and skips symlinked descendants", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const outsideRoot = path.join(root, "outside");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "do not expose", "utf8");
    const keep = await createSkill(skillRoot, "keep");
    const remove = await createSkill(skillRoot, "remove");
    await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(keep.source, "leak.txt"));
    await fs.symlink(outsideRoot, path.join(keep.source, "leak-dir"));

    const baseConfig = {
      agent: "codex",
      stateDir: path.join(root, "state"),
      env: { CODEX_HOME: codexHome },
      paperclipRuntimeSkills: [keep, remove],
    };

    await runExecutor({
      ...baseConfig,
      paperclipSkillSync: { desiredSkills: [keep.key, remove.key] },
    });
    expect(await pathExists(path.join(codexHome, "skills", remove.runtimeName, "SKILL.md"))).toBe(true);

    await runExecutor({
      ...baseConfig,
      paperclipSkillSync: { desiredSkills: [keep.key] },
    });

    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "leak.txt"))).toBe(false);
    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "leak-dir"))).toBe(false);
    expect(await pathExists(path.join(codexHome, "skills", remove.runtimeName))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("removes legacy ACPX Codex skill symlinks when a skill is no longer desired", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const codexHome = path.join(root, "codex-home");
    const legacy = await createSkill(skillRoot, "legacy");
    const skillsHome = path.join(codexHome, "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(legacy.source, path.join(skillsHome, legacy.runtimeName));

    await runExecutor({
      agent: "codex",
      stateDir: path.join(root, "state"),
      env: { CODEX_HOME: codexHome },
      paperclipRuntimeSkills: [legacy],
      paperclipSkillSync: { desiredSkills: [] },
    });

    expect(await pathExists(path.join(skillsHome, legacy.runtimeName))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("replaces stale managed Codex auth files with source symlinks", async () => {
    const root = await makeTempRoot();
    const sourceCodexHome = path.join(root, "source-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const paperclipInstanceId = "test-instance";
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      paperclipInstanceId,
      "companies",
      "company-1",
      "codex-home",
    );
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.mkdir(managedCodexHome, { recursive: true });
    const sourceAuth = path.join(sourceCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");
    await fs.writeFile(sourceAuth, "{\"source\":true}", "utf8");
    await fs.writeFile(managedAuth, "{\"stale\":true}", "utf8");

    const previousCodexHome = process.env.CODEX_HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    try {
      process.env.CODEX_HOME = sourceCodexHome;
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = paperclipInstanceId;
      await runExecutor({
        agent: "codex",
        stateDir: path.join(root, "state"),
        paperclipRuntimeSkills: [],
        paperclipSkillSync: { desiredSkills: [] },
      });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
    }

    const authStat = await fs.lstat(managedAuth);
    expect(authStat.isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(managedAuth), await fs.readlink(managedAuth))).toBe(sourceAuth);
  });

  it("keeps fresh credential wrapper scripts across ACPX agent changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = {
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      agent: "custom-a",
      env: { PAPERCLIP_API_KEY: "old-key" },
    });
    await runExecutor({
      ...baseConfig,
      agent: "custom-b",
      env: { PAPERCLIP_API_KEY: "new-key" },
    });

    const wrappers = await fs.readdir(path.join(stateDir, "wrappers"));
    expect(wrappers.filter((name) => name.endsWith(".sh"))).toHaveLength(2);
    expect(wrappers.filter((name) => name.endsWith(".env"))).toHaveLength(2);
    expect(wrappers.some((name) => name.startsWith("custom-a-"))).toBe(true);
    expect(wrappers.some((name) => name.startsWith("custom-b-"))).toBe(true);
    const wrapperPath = path.join(stateDir, "wrappers", wrappers.find((name) => name.startsWith("custom-b-") && name.endsWith(".sh"))!);
    const envPath = path.join(stateDir, "wrappers", wrappers.find((name) => name.startsWith("custom-b-") && name.endsWith(".env"))!);
    const wrapper = await fs.readFile(wrapperPath, "utf8");
    const env = await fs.readFile(envPath, "utf8");
    expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(wrapperPath)).mode & 0o777).toBe(0o700);
    expect(wrapper).toContain("node ./fake-acp.js");
    expect(wrapper).not.toContain("PAPERCLIP_API_KEY");
    expect(wrapper).not.toContain("new-key");
    expect(wrapper).not.toContain("old-key");
    expect(env).toContain("PAPERCLIP_API_KEY='new-key'");
    expect(env).not.toContain("old-key");
  });

  it("shapes ACPX wrapper workspace env for remote execution identities", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    await runExecutor(
      {
        agentCommand: "node ./fake-acp.js",
        stateDir,
      },
      {
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
            strategy: "git_worktree",
            workspaceId: "workspace-1",
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
            branchName: "feature/remote-acpx",
            worktreePath: workspaceDir,
          },
        },
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
      },
    );

    const wrappers = await fs.readdir(path.join(stateDir, "wrappers"));
    const envPath = path.join(
      stateDir,
      "wrappers",
      wrappers.find((name) => name.endsWith(".env"))!,
    );
    const env = await fs.readFile(envPath, "utf8");

    expect(env).toContain("PAPERCLIP_WORKSPACE_CWD='/remote/workspace'");
    expect(env).not.toContain("PAPERCLIP_WORKSPACE_WORKTREE_PATH=");
  });

  it("cleans aged credential wrapper scripts across ACPX agent changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const wrappersDir = path.join(stateDir, "wrappers");
    const baseConfig = {
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      agent: "custom-a",
      env: { PAPERCLIP_API_KEY: "old-key" },
    });
    const oldDate = new Date(Date.now() - 16 * 60 * 1000);
    await Promise.all(
      (await fs.readdir(wrappersDir))
        .filter((name) => name.startsWith("custom-a-"))
        .map((name) => fs.utimes(path.join(wrappersDir, name), oldDate, oldDate)),
    );

    await runExecutor({
      ...baseConfig,
      agent: "custom-b",
      env: { PAPERCLIP_API_KEY: "new-key" },
    });

    const wrappers = await fs.readdir(wrappersDir);
    expect(wrappers.filter((name) => name.endsWith(".sh"))).toHaveLength(1);
    expect(wrappers.filter((name) => name.endsWith(".env"))).toHaveLength(1);
    expect(wrappers.some((name) => name.startsWith("custom-a-"))).toBe(false);
    expect(wrappers.some((name) => name.startsWith("custom-b-"))).toBe(true);
  });

  it("keeps distinct wrapper env files for concurrent runs with different credentials", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = {
      agent: "custom-a",
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      env: { PAPERCLIP_API_KEY: "first-key" },
    });
    await runExecutor({
      ...baseConfig,
      env: { PAPERCLIP_API_KEY: "second-key" },
    });

    const envFileNames = (await fs.readdir(path.join(stateDir, "wrappers"))).filter((name) => name.endsWith(".env"));
    expect(envFileNames).toHaveLength(2);
    const envFiles = await Promise.all(
      envFileNames.map(async (name) => fs.readFile(path.join(stateDir, "wrappers", name), "utf8")),
    );
    expect(envFiles.filter((contents) => contents.includes("PAPERCLIP_API_KEY='first-key'"))).toHaveLength(1);
    expect(envFiles.filter((contents) => contents.includes("PAPERCLIP_API_KEY='second-key'"))).toHaveLength(1);
  });

  it("enriches acpx.error diagnostics and child stderr when ensureSession rejects", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const runStderrDir = path.join(stateDir, "run-stderr");
    await fs.mkdir(runStderrDir, { recursive: true });
    const stderrTail = "claude-agent-acp: SDK init failed (auth missing)";
    await fs.writeFile(path.join(runStderrDir, "run-1.log"), `${stderrTail}\n`, "utf8");

    class FakeAcpRuntimeError extends Error {
      readonly code = "ACP_SESSION_INIT_FAILED";
      readonly cause: Error;
      readonly retryable = false;
      constructor(message: string, cause: Error) {
        super(message);
        this.name = "AcpRuntimeError";
        this.cause = cause;
      }
    }

    const logs: Array<{ stream: string; text: string }> = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => {
          throw new FakeAcpRuntimeError(
            "session/new failed: backend rejected initialize",
            new Error("upstream timeout"),
          );
        },
        startTurn: () => ({
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
      },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_session_init_failed");
    const meta = result.errorMeta ?? {};
    expect(meta.errorName).toBe("AcpRuntimeError");
    expect(meta.acpCode).toBe("ACP_SESSION_INIT_FAILED");
    expect(meta.causeMessage).toBe("upstream timeout");
    expect(meta.retryable).toBe(false);
    expect(typeof meta.stackPreview).toBe("string");
    expect(meta.phase).toBe("ensure_session");

    const errorLogLine = logs.find((entry) => entry.stream === "stdout" && entry.text.includes("\"type\":\"acpx.error\""));
    expect(errorLogLine).toBeTruthy();
    const errorPayload = JSON.parse(errorLogLine!.text.trim());
    expect(errorPayload.phase).toBe("ensure_session");
    expect(errorPayload.errorName).toBe("AcpRuntimeError");
    expect(errorPayload.acpCode).toBe("ACP_SESSION_INIT_FAILED");
    expect(errorPayload.causeMessage).toBe("upstream timeout");
    expect(errorPayload.childStderrTail).toContain("SDK init failed");

    const stderrLog = logs.find((entry) => entry.stream === "stderr" && entry.text.includes("ACPX child stderr tail"));
    expect(stderrLog).toBeTruthy();
    expect(stderrLog!.text).toContain(stderrTail);
  });

  it("writes wrapper that redirects child stderr to a per-run log file", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");

    const runtimeOptions: AcpRuntimeOptions[] = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: (options) => {
        runtimeOptions.push(options as unknown as AcpRuntimeOptions);
        return buildRuntime() as never;
      },
    });

    const result = await execute({
      runId: "run-stderr-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    const verboseFlags = runtimeOptions.map((options) => (options as { verbose?: boolean }).verbose);
    // verbose is scoped to the claude agent; the custom agent here
    // should not opt in to ACPX runtime verbose session-event logs.
    expect(verboseFlags.every((flag) => flag === false)).toBe(true);

    const wrappers = await fs.readdir(path.join(stateDir, "wrappers"));
    const wrapperFile = wrappers.find((name) => name.endsWith(".sh"));
    expect(wrapperFile).toBeTruthy();
    const wrapper = await fs.readFile(path.join(stateDir, "wrappers", wrapperFile!), "utf8");
    expect(wrapper).toContain("stderr_dir=");
    expect(wrapper).toContain("run-stderr");
    expect(wrapper).toContain("PAPERCLIP_RUN_ID");
    expect(wrapper).toContain("tee -a");
    expect(wrapper).toContain("exec node ./fake-acp.js");
  });

  it.skipIf(process.platform === "win32")("drops benign ACP nes/close cleanup stderr but keeps it in the run log", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");

    const execute = createAcpxEngineExecutor({
      createRuntime: () => buildRuntime() as never,
    });

    const fakeAgentPath = path.join(root, "fake-acp.sh");
    await fs.writeFile(
      fakeAgentPath,
      [
        "#!/usr/bin/env bash",
        "echo \"Error handling request { method: 'nes/close' } { code: -32601, message: '\\\"Method not found\\\": nes/close' }\" >&2",
        "echo \"some genuine crash: TypeError: x is not a function\" >&2",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = await execute({
      runId: "run-nes-close-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: fakeAgentPath,
        stateDir,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    const wrapperFile = (await fs.readdir(path.join(stateDir, "wrappers"))).find((name) => name.endsWith(".sh"));
    expect(wrapperFile).toBeTruthy();
    const wrapperPath = path.join(stateDir, "wrappers", wrapperFile!);

    const { stderr } = await execFileAsync("bash", [wrapperPath], {
      env: { ...process.env, PAPERCLIP_RUN_ID: "run-nes-close-1" },
    });

    expect(stderr).not.toContain("nes/close");
    expect(stderr).toContain("some genuine crash: TypeError: x is not a function");

    const runLog = await fs.readFile(path.join(stateDir, "run-stderr", "run-nes-close-1.log"), "utf8");
    expect(runLog).toContain("nes/close");
    expect(runLog).toContain("some genuine crash: TypeError: x is not a function");
  });

  it("passes Paperclip env through the ACP agent wrapper instead of process.env", async () => {
    let observedApiKeyDuringStream: string | undefined;
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            await Promise.resolve();
            observedApiKeyDuringStream = process.env.PAPERCLIP_API_KEY;
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    try {
      delete process.env.PAPERCLIP_API_KEY;
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
        },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js" },
        context: {},
        authToken: "runtime-key",
        onLog: async () => {},
        onMeta: async () => {},
      } as never);

      expect(result.exitCode).toBe(0);
      expect(observedApiKeyDuringStream).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });

  it("writes a Paperclip-managed .claude/settings.local.json for the claude agent so it can reach the Paperclip API", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { meta } = await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd, agentHome: path.join(root, "agent-home") } } },
    );

    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      permissions?: {
        allow?: unknown;
        additionalDirectories?: unknown;
        defaultMode?: unknown;
      };
    };
    expect(written.permissions?.defaultMode).toBe("default");
    const allow = written.permissions?.allow;
    expect(Array.isArray(allow)).toBe(true);
    expect(allow).toContain("Bash(curl:*)");
    expect(allow).toContain(`Bash(${cwd}/scripts/paperclip-issue-update.sh:*)`);
    const additionalDirectories = written.permissions?.additionalDirectories as string[] | undefined;
    expect(Array.isArray(additionalDirectories)).toBe(true);
    expect(additionalDirectories).toContain(stateDir);
    expect(additionalDirectories).toContain(path.join(root, "agent-home"));

    const note = (meta[0]?.commandNotes as string[] | undefined)?.find((entry) =>
      entry.includes("Paperclip-managed Claude settings"),
    );
    expect(note).toBeTruthy();
  });

  it("merges Paperclip allowlist into an existing .claude/settings.local.json without losing user entries", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify(
        {
          statusLine: { type: "command", command: "preserve-me" },
          permissions: {
            allow: ["Bash(npm test:*)"],
            additionalDirectories: ["/Users/example/custom"],
            defaultMode: "acceptEdits",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    const written = JSON.parse(
      await fs.readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8"),
    ) as {
      statusLine?: unknown;
      permissions?: {
        allow?: string[];
        additionalDirectories?: string[];
        defaultMode?: string;
      };
    };
    expect(written.statusLine).toEqual({ type: "command", command: "preserve-me" });
    expect(written.permissions?.defaultMode).toBe("acceptEdits");
    expect(written.permissions?.allow).toContain("Bash(npm test:*)");
    expect(written.permissions?.allow).toContain("Bash(curl:*)");
    expect(written.permissions?.additionalDirectories).toContain("/Users/example/custom");
    expect(written.permissions?.additionalDirectories).toContain(stateDir);
  });

  it("overrides a user-supplied dontAsk defaultMode so ACPX can route Bash through canUseTool", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { defaultMode: "dontAsk" } }, null, 2),
      "utf8",
    );

    const { meta } = await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    const written = JSON.parse(
      await fs.readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8"),
    ) as { permissions?: { defaultMode?: string } };
    expect(written.permissions?.defaultMode).toBe("default");

    const overrideNote = (meta[0]?.commandNotes as string[] | undefined)?.find((entry) =>
      entry.includes("overrode user dontAsk"),
    );
    expect(overrideNote).toBeTruthy();
  });

  it("opts the claude agent into ACPX runtime verbose logs but leaves codex/custom agents quiet", async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const verboseByAgent: Record<string, boolean | undefined> = {};
    for (const agent of ["claude", "codex", "custom"] as const) {
      const runtimeOptions: AcpRuntimeOptions[] = [];
      const execute = createAcpxEngineExecutor({
        createRuntime: (options) => {
          runtimeOptions.push(options as AcpRuntimeOptions);
          return buildRuntime() as never;
        },
      });
      const result = await execute({
        runId: `run-${agent}`,
        agent: { id: `agent-${agent}`, companyId: "company-1" },
        runtime: {},
        config:
          agent === "custom"
            ? { agent, agentCommand: "node ./fake-acp.js", stateDir: path.join(root, `state-${agent}`), cwd }
            : { agent, stateDir: path.join(root, `state-${agent}`), cwd },
        context: { paperclipWorkspace: { cwd } },
        onLog: async () => {},
        onMeta: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      verboseByAgent[agent] = (runtimeOptions[0] as { verbose?: boolean } | undefined)?.verbose;
    }

    expect(verboseByAgent.claude).toBe(true);
    expect(verboseByAgent.codex).toBe(false);
    expect(verboseByAgent.custom).toBe(false);
  });

  it("does not touch .claude/settings.local.json for the codex agent", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    await runExecutor(
      { agent: "codex", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    expect(await pathExists(path.join(cwd, ".claude", "settings.local.json"))).toBe(false);
  });

  it("changes the ACPX session fingerprint when the resolved secret manifest rotates", async () => {
    const root = await makeTempRoot();
    const baseConfig = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
    };

    const first = await runExecutor(baseConfig, {
      context: {
        paperclipSecrets: {
          manifest: [
            {
              configPath: "env.API_TOKEN",
              envKey: "API_TOKEN",
              secretId: "secret-1",
              bindingId: "binding-1",
              secretKey: "api-token",
              version: 1,
              provider: "local_encrypted",
            },
          ],
        },
      },
    });
    const second = await runExecutor(baseConfig, {
      context: {
        paperclipSecrets: {
          manifest: [
            {
              configPath: "env.API_TOKEN",
              envKey: "API_TOKEN",
              secretId: "secret-1",
              bindingId: "binding-1",
              secretKey: "api-token",
              version: 2,
              provider: "local_encrypted",
            },
          ],
        },
      },
    });

    expect(first.result.sessionParams?.configFingerprint).toBeTypeOf("string");
    expect(second.result.sessionParams?.configFingerprint).toBeTypeOf("string");
    expect(first.result.sessionParams?.configFingerprint).not.toBe(second.result.sessionParams?.configFingerprint);
  });
});

describe("findAncestorBin", () => {
  async function writeFakeBin(dir: string, name: string) {
    const binDir = path.join(dir, "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, name);
    await fs.writeFile(binPath, "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });
    return binPath;
  }

  it("finds the binary in the start directory's own node_modules/.bin", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });
    const expectedBin = await writeFakeBin(packageDir, "claude-agent-acp");

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBe(expectedBin);
  });

  it("finds the binary hoisted to an ancestor node_modules/.bin", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });
    const expectedBin = await writeFakeBin(root, "claude-agent-acp");

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBe(expectedBin);
  });

  it("returns null when the binary is not present in any ancestor", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBeNull();
  });

  it("terminates at the filesystem root instead of looping forever", async () => {
    const resolved = await findAncestorBin("/", "definitely-not-a-real-bin-name-xyz");
    expect(resolved).toBeNull();
  });
});

describe("gemini ACP flag selection", () => {
  it("parses semantic version parts from gemini --version output", () => {
    expect(parseGeminiVersionParts("0.30.0")).toEqual([0, 30, 0]);
    expect(parseGeminiVersionParts("gemini-cli v1.2.3\n")).toEqual([1, 2, 3]);
    expect(parseGeminiVersionParts("no version here")).toBeNull();
    expect(parseGeminiVersionParts(null)).toBeNull();
  });

  it("keeps --acp for gemini >= 0.33.0 and unknown versions", () => {
    expect(geminiVersionSupportsNativeAcpFlag([0, 33, 0])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag([0, 34, 1])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag([1, 0, 0])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag(null)).toBe(true);
    expect(rewriteGeminiAcpFlagForVersion("gemini --acp", [0, 33, 0])).toBe("gemini --acp");
  });

  it("downgrades --acp to --experimental-acp for gemini < 0.33.0", () => {
    expect(geminiVersionSupportsNativeAcpFlag([0, 30, 0])).toBe(false);
    expect(geminiVersionSupportsNativeAcpFlag([0, 32, 9])).toBe(false);
    expect(rewriteGeminiAcpFlagForVersion("gemini --acp", [0, 30, 0])).toBe("gemini --experimental-acp");
    expect(rewriteGeminiAcpFlagForVersion("/opt/bin/gemini --acp", [0, 30, 0])).toBe(
      "/opt/bin/gemini --experimental-acp",
    );
  });

  async function writeFakeGemini(binDir: string, version: string) {
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, "gemini");
    await fs.writeFile(binPath, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  }

  function pathWithFakeBin(binDir: string): string {
    return [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  }

  async function readGeminiWrapperScript(stateDir: string): Promise<string> {
    const wrappersDir = path.join(stateDir, "wrappers");
    const names = await fs.readdir(wrappersDir);
    const scriptName = names.find((name) => name.endsWith(".sh"));
    expect(scriptName).toBeTypeOf("string");
    return fs.readFile(path.join(wrappersDir, scriptName!), "utf8");
  }

  it("writes a gemini wrapper that execs a multi-word command instead of a single quoted token", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const binDir = path.join(root, "bin");
    await writeFakeGemini(binDir, "0.33.0");

    await runExecutor({
      agent: "gemini",
      stateDir,
      env: { HOME: path.join(root, "home"), PATH: pathWithFakeBin(binDir) },
    });

    const script = await readGeminiWrapperScript(stateDir);
    expect(script).toContain('exec gemini --acp "$@"');
    expect(script).not.toContain("'gemini --acp'");
  });

  it("downgrades the built-in gemini command flag when the local CLI predates --acp", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const binDir = path.join(root, "bin");
    await writeFakeGemini(binDir, "0.30.0");

    await runExecutor({
      agent: "gemini",
      stateDir,
      env: { HOME: path.join(root, "home"), PATH: pathWithFakeBin(binDir) },
    });

    const script = await readGeminiWrapperScript(stateDir);
    expect(script).toContain('exec gemini --experimental-acp "$@"');
  });
});

describe("shared ACP engine execution timeouts", () => {
  it("applies the 4h sandbox backstop when timeoutSec is unset on a sandbox execution target", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd },
      {
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "acme-sandbox",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: cwd,
        },
      },
    );

    // The sandbox default flows into the ACPX runtime wall-clock timer.
    expect(runtimeOptions[0]?.timeoutMs).toBe(DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000);
    // The effective timeout and its source are stated at run start so a later
    // timeout is diagnosable from the run log alone.
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine).toBeTruthy();
    expect(startLine!.text).toContain(
      `[paperclip] Adapter execution timeout: timeoutSec=${DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC} ` +
        "(sandbox default; set adapterConfig.timeoutSec to override).",
    );
  });

  it("keeps local execution unlimited by default and logs the unlimited timeout", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      cwd,
    });

    expect(runtimeOptions[0]?.timeoutMs).toBeUndefined();
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine).toBeTruthy();
    expect(startLine!.text).toContain("Adapter execution timeout: none");
  });

  it("prefers a configured timeoutSec over the sandbox default", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: 90 },
      {
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: cwd,
        },
      },
    );

    expect(runtimeOptions[0]?.timeoutMs).toBe(90 * 1000);
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine!.text).toContain(
      "Adapter execution timeout: timeoutSec=90 (configured via adapterConfig.timeoutSec; set adapterConfig.timeoutSec to override).",
    );
  });

  it("keeps the sandbox backstop for an explicit timeoutSec of 0 but honors a negative opt-out", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });
    const sandboxContext = {
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: cwd,
      },
    };

    // The config UI persists the schema default of 0 for untouched fields, so
    // an explicit 0 cannot mean "no timeout" — it keeps the 4h backstop.
    const explicitZero = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: 0 },
      sandboxContext,
    );
    expect(explicitZero.runtimeOptions[0]?.timeoutMs).toBe(
      DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000,
    );

    // A negative timeoutSec is the documented opt-out from any adapter
    // wall-clock timeout, sandbox targets included.
    const negativeOptOut = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: -1 },
      sandboxContext,
    );
    expect(negativeOptOut.runtimeOptions[0]?.timeoutMs).toBeUndefined();
    const startLine = negativeOptOut.logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine!.text).toContain(
      "Adapter execution timeout: none (explicitly disabled via adapterConfig.timeoutSec; " +
        "set it to a positive value to add one).",
    );
  });

  it("reports a self-describing timeout error when the wall-clock timer kills a turn", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const cancelReasons: string[] = [];
    let releaseTurn: (() => void) | null = null;
    const turnCancelled = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          // Never yields on its own: only the Paperclip wall-clock timer's
          // cancel unblocks the turn, simulating a hung run.
          events: (async function* () {
            await turnCancelled;
          })(),
          result: turnCancelled.then(() => ({ status: "cancelled", stopReason: "cancelled" })),
          cancel: async ({ reason }: { reason: string }) => {
            cancelReasons.push(reason);
            releaseTurn?.();
          },
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-timeout-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd,
        timeoutSec: 1,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    const expectedMessage =
      "Run exceeded the adapter execution timeout (timeoutSec=1, configured via adapterConfig.timeoutSec). " +
      "Set adapterConfig.timeoutSec to raise it.";
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("acpx_timeout");
    expect(result.errorMessage).toBe(expectedMessage);
    expect(cancelReasons).toContain(expectedMessage);
  }, 15_000);
});
