import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { model: "claude-opus-5", ...config },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start CLI after default ACP fails", async () => {
    const ctx = buildContext();
    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ engine: "cli", networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("makes the selected skill available in the isolated managed Claude user directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const source = path.join(root, "source");
      const configDir = path.join(root, "provider");
      await mkdir(source); await mkdir(configDir);
      await writeFile(path.join(source, "SKILL.md"), "---\nname: probe-skill\ndescription: Test skill\n---\nExpected contents\n");
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [{ key: "company/probe", runtimeName: "probe-skill", source }],
        paperclipSkillSync: { desiredSkills: ["company/probe"] } });
      await execute(ctx as never);
      expect(await readFile(path.join(configDir, "skills", "probe-skill", "SKILL.md"), "utf8")).toContain("Expected contents");
      const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, unknown, string, string[]]>;
      const args = calls[0]![3];
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not overwrite an existing managed skill", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const source = path.join(root, "source");
      const configDir = path.join(root, "provider");
      const existing = path.join(configDir, "skills", "probe-skill");
      await mkdir(source);
      await mkdir(existing, { recursive: true });
      await writeFile(path.join(source, "SKILL.md"), "new");
      await writeFile(path.join(existing, "SKILL.md"), "existing");
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [{ key: "company/probe", runtimeName: "probe-skill", source }],
        paperclipSkillSync: { desiredSkills: ["company/probe"] } });
      await expect(execute(ctx as never)).rejects.toThrow("destination already exists");
      expect(await readFile(path.join(existing, "SKILL.md"), "utf8")).toBe("existing");
      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("loads project settings only when the prepared workspace explicitly permits it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const configDir = path.join(root, "provider");
      await mkdir(configDir);
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } });
      ctx.context = { paperclipWorkspace: { claudeProjectSettingsAllowed: true } };
      await execute(ctx as never);
      const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, unknown, string, string[]]>;
      const args = calls[0]![3];
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("user,project");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([[true, false], [false, true]])("starts a fresh session when project trust changes from %s to %s", async (before, after) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-test-grant-"));
    try {
      const configDir = path.join(root, "provider");
      await mkdir(configDir);
      const ctx = buildContext({ engine: "cli", cwd: root, managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } });
      Object.assign(ctx.runtime, { sessionId: "00000000-0000-4000-8000-000000000001", sessionParams: {
        sessionId: "00000000-0000-4000-8000-000000000001", cwd: root, claudeProjectSettingsAllowed: before,
      } });
      ctx.context = { paperclipWorkspace: { claudeProjectSettingsAllowed: after } };
      await execute(ctx as never);
      const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<[string, unknown, string, string[]]>;
      expect(calls[0]![3]).not.toContain("--resume");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves project trust in saved Claude session parameters", () => {
    const params = { sessionId: "00000000-0000-4000-8000-000000000001", claudeProjectSettingsAllowed: true };
    expect(sessionCodec.deserialize(sessionCodec.serialize(params))).toMatchObject(params);
  });

  it("refuses to write skills into a non-managed Claude configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-unmanaged-test-"));
    try {
      const source = path.join(root, "source");
      const configDir = path.join(root, "provider");
      await mkdir(source);
      await mkdir(configDir);
      await writeFile(path.join(source, "SKILL.md"), "test");
      const ctx = buildContext({ engine: "cli", managedAiConnection: true, env: { CLAUDE_CONFIG_DIR: configDir },
        paperclipRuntimeSkills: [{ key: "company/probe", runtimeName: "probe-skill", source }],
        paperclipSkillSync: { desiredSkills: ["company/probe"] } });
      await expect(execute(ctx as never)).rejects.toThrow("outside a Paperclip-managed temporary Claude configuration");
      expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
