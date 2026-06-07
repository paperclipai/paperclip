import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import { createAcpxLocalExecutor } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
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
  } = {},
) {
  const runtimeOptions: Record<string, unknown>[] = [];
  const meta: Record<string, unknown>[] = [];
  const logs: Array<{ stream: string; text: string }> = [];
  const execute = createAcpxLocalExecutor({
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

describe("acpx_local runtime skill isolation", () => {
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

  it.skipIf(process.platform === "win32")("treats a concurrently-created managed Codex auth symlink as success", async () => {
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
    const sourceAuth = path.join(sourceCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(sourceAuth, "{\"source\":true}", "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

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

    expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
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
    const execute = createAcpxLocalExecutor({
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
    const execute = createAcpxLocalExecutor({
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
    // verbose is scoped to the claude agent (PAPA-388); the custom agent here
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

  it("passes Paperclip env through the ACP agent wrapper instead of process.env", async () => {
    let observedApiKeyDuringStream: string | undefined;
    const execute = createAcpxLocalExecutor({
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
      const execute = createAcpxLocalExecutor({
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
});
