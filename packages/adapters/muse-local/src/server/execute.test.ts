import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const mocks = vi.hoisted(() => ({
  isRemote: false,
  restoreMock: vi.fn(async () => {}),
  bridgeStopMock: vi.fn(async () => {}),
  startBridgeMock: vi.fn(),
  prepareRuntimeMock: vi.fn(),
  ensureRuntimeInstalledMock: vi.fn(async () => {}),
  ensureCommandMock: vi.fn(async () => {}),
  resolveCommandForLogsMock: vi.fn(async () => "muse"),
  runProcessMock: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => mocks.isRemote,
  adapterExecutionTargetRemoteCwd: (_t: unknown, cwd: string) => (mocks.isRemote ? "/remote/ws" : cwd),
  prepareAdapterExecutionTargetRuntime: (...a: unknown[]) => (mocks.prepareRuntimeMock as (...x: unknown[]) => unknown)(...a),
  adapterExecutionTargetUsesPaperclipBridge: () => mocks.isRemote,
  adapterExecutionTargetEnablesSandboxDuplexBridge: () => false,
  adapterExecutionTargetDuplexObservabilityRecorder: () => undefined,
  startAdapterExecutionTargetPaperclipBridge: (...a: unknown[]) => (mocks.startBridgeMock as (...x: unknown[]) => unknown)(...a),
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: mocks.isRemote ? "remote" : "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => (mocks.isRemote ? "remote" : "local"),
  ensureAdapterExecutionTargetCommandResolvable: (...a: unknown[]) => (mocks.ensureCommandMock as (...x: unknown[]) => unknown)(...a),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: (...a: unknown[]) => (mocks.ensureRuntimeInstalledMock as (...x: unknown[]) => unknown)(...a),
  readAdapterExecutionTarget: () => (mocks.isRemote ? { kind: "remote", transport: "ssh" } : { kind: "local" }),
  resolveAdapterExecutionTargetCommandForLogs: (...a: unknown[]) => (mocks.resolveCommandForLogsMock as (...x: unknown[]) => unknown)(...a),
  resolveAdapterExecutionTargetTimeoutSec: (_t: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: (...a: unknown[]) => (mocks.runProcessMock as (...x: unknown[]) => unknown)(...a),
}));

import { execute, resolveMuseDataHome } from "./execute.js";
import { promoteMuseDeviceLoginCredential } from "./muse-home.js";

const fixture = (name: string) =>
  fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name), "utf8");

const tempRoots: string[] = [];
async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-local-"));
  tempRoots.push(root);
  return root;
}
const pathExists = (p: string) => fs.access(p).then(() => true).catch(() => false);

function makeCtx(cwd: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Muse Agent", adapterType: "muse_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd, paperclipRuntimeSkills: [] },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

async function okRun(name = "exec-basic.jsonl") {
  return { exitCode: 0, signal: null, timedOut: false, stdout: await fixture(name), stderr: "" };
}

async function makeSkill(root: string) {
  const skillSource = path.join(root, "runtime-skills", "paperclip");
  await fs.mkdir(skillSource, { recursive: true });
  await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n");
  return {
    paperclipRuntimeSkills: [{ key: "paperclip", runtimeName: "paperclip", source: skillSource, required: false }],
    paperclipSkillSync: { desiredSkills: ["paperclip"] },
  };
}

describe("muse_local execute", () => {
  beforeEach(async () => {
    mocks.isRemote = false;
    mocks.runProcessMock.mockReset();
    mocks.restoreMock.mockClear();
    mocks.prepareRuntimeMock.mockReset();
    mocks.prepareRuntimeMock.mockImplementation(async () => ({ workspaceRemoteDir: "/remote/ws/runs/run-1", runtimeRootDir: "/remote/ws/runs/run-1/.paperclip-runtime", assetDirs: {}, restoreWorkspace: mocks.restoreMock }));
    mocks.bridgeStopMock.mockClear();
    mocks.startBridgeMock.mockReset();
    mocks.startBridgeMock.mockImplementation(async () => ({ env: { PAPERCLIP_API_URL: "http://127.0.0.1:43123", PAPERCLIP_API_KEY: "bridge-token" }, stop: mocks.bridgeStopMock }));
    vi.stubEnv("PAPERCLIP_HOME", await makeTempRoot());
    vi.stubEnv("META_API_KEY", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
  });

  it("builds the exec argv and env", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, {
      config: { cwd: root, paperclipRuntimeSkills: [], model: "muse-spark-1.3-contributor", reasoningEffort: "low", extraArgs: ["--max-model-steps", "40"] },
    }));

    const [, , command, args, options] = mocks.runProcessMock.mock.calls[0]!;
    expect(command).toBe("muse");
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args[args.indexOf("--model") + 1]).toBe("muse-spark-1.3-contributor");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("low");
    expect(args).toContain("--trust-workspace");
    expect(args[args.indexOf("--approval-mode") + 1]).toBe("never");
    expect(args[args.indexOf("--workspace") + 1]).toBe(root);
    expect(args[args.indexOf("--session-id") + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.slice(-2)).toEqual(["--max-model-steps", "40"]);
    const env = (options as { env: Record<string, string> }).env;
    expect(env.XDG_DATA_HOME).toBe(resolveMuseDataHome(process.env, "company-1", "agent-1"));
    // Forcing the file backend hides a macOS keychain `muse login` (verified live).
    expect(env.TBH_CREDENTIAL_BACKEND).toBeUndefined();
    expect(env.MUSE_NO_AUTO_UPDATE).toBe("1");
    expect(env.XDG_CONFIG_HOME).toBeUndefined();

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("MUSE OK");
    expect(result.sessionId).toBe("01a0df95-ddaf-7cd0-91f4-246c59f925e8");
    expect(result.sessionParams).toMatchObject({ sessionId: "01a0df95-ddaf-7cd0-91f4-246c59f925e8", cwd: root });
    expect(result.provider).toBe("meta");
    expect(result.biller).toBe("muse");
    expect(result.billingType).toBe("subscription");
    expect(result.costUsd).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });

  it("writes the prompt to a file passed via --prompt-file and removes it afterwards", async () => {
    const root = await makeTempRoot();
    let promptPath = "";
    mocks.runProcessMock.mockImplementation(async (_r: unknown, _t: unknown, _c: unknown, args: string[]) => {
      promptPath = args[args.indexOf("--prompt-file") + 1]!;
      expect(await fs.readFile(promptPath, "utf8")).toContain("Paperclip");
      return okRun();
    });
    await execute(makeCtx(root));
    expect(promptPath).not.toBe("");
    expect(await pathExists(promptPath)).toBe(false);
  });

  it("resumes the stored session when cwd matches", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const sessionId = "01a0df95-ddaf-7cd0-91f4-246c59f925e8";
    await execute(makeCtx(root, { runtime: { sessionId, sessionParams: { sessionId, cwd: root }, sessionDisplayId: null, taskKey: null } }));
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args[args.indexOf("--session-id") + 1]).toBe(sessionId);
  });

  it("does not resume across cwd changes", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await execute(makeCtx(root, { runtime: { sessionId, sessionParams: { sessionId, cwd: "/somewhere/else" }, sessionDisplayId: null, taskKey: null } }));
    const args = mocks.runProcessMock.mock.calls[0]![3] as string[];
    expect(args[args.indexOf("--session-id") + 1]).not.toBe(sessionId);
  });

  it("maps auth failures to muse_auth_required", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stdout: await fixture("exec-badkey.jsonl"), stderr: "" });
    const result = await execute(makeCtx(root));
    expect(result.errorCode).toBe("muse_auth_required");
    expect(result.errorMessage).toMatch(/muse login|META_API_KEY/);
  });

  it("reports the real failure from stderr, not Muse's informational preamble", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue({
      exitCode: 1, signal: null, timedOut: false, stdout: "",
      stderr: "muse: workspace root: /x (explicit)\nmuse: workspace trust: trusted source=run-flag\nreceived SIGTERM; flushed session logs\n",
    });
    const result = await execute(makeCtx(root));
    expect(result.errorMessage).toBe("received SIGTERM; flushed session logs");
  });

  it("fails a run that exits 0 without a terminal record", async () => {
    const root = await makeTempRoot();
    const truncated = (await fixture("exec-basic.jsonl")).split("\n").filter((line) => line && !line.includes('"run.terminal.')).join("\n");
    mocks.runProcessMock.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: truncated, stderr: "" });
    const result = await execute(makeCtx(root));
    expect(result.errorMessage).toMatch(/ended without a final result/);
  });

  it("reports api billing when META_API_KEY is bound", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, {
      config: { cwd: root, paperclipRuntimeSkills: [], env: { META_API_KEY: "LLM|test-key-000000000000000000000000000000000000" } },
    }));
    expect(result.billingType).toBe("api");
    expect(JSON.stringify(result)).not.toContain("LLM|test-key");
  });

  it("bills a managed Muse subscription connection as subscription even though it injects META_API_KEY", async () => {
    const root = await makeTempRoot();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, {
      config: {
        cwd: root,
        paperclipRuntimeSkills: [],
        env: { META_API_KEY: "LLM|subscription-key-0000000000000000000000000000" },
        managedAiConnection: { method: "subscription", provider: "meta", grantId: "g", identity: "g:u:x" },
      },
    }));
    expect(result.billingType).toBe("subscription");
  });

  const COMPANY_KEY = "LLM|666666666666666|companydevicelogin0000000";
  const promoteCompanyKey = () => promoteMuseDeviceLoginCredential({
    authBytes: Buffer.from(JSON.stringify({ providers: { meta: { api_key: COMPANY_KEY } } })),
    companyId: "company-1", userInitiated: true, isSoleActiveOwner: () => true, log: () => {},
  });

  it("uses the company Muse key from a sandbox device login when nothing else is bound", async () => {
    const root = await makeTempRoot();
    await promoteCompanyKey();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root));
    const env = (mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> }).env;
    expect(env.META_API_KEY).toBe(COMPANY_KEY);
    expect(result.billingType).toBe("subscription");
  });

  it("prefers a bound META_API_KEY over the company key", async () => {
    const root = await makeTempRoot();
    await promoteCompanyKey();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    await execute(makeCtx(root, { config: { cwd: root, paperclipRuntimeSkills: [], env: { META_API_KEY: "LLM|bound-key-0000000000000000000000000000000" } } }));
    const env = (mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> }).env;
    expect(env.META_API_KEY).toBe("LLM|bound-key-0000000000000000000000000000000");
  });

  it("prefers a managed connection over the company key", async () => {
    const root = await makeTempRoot();
    await promoteCompanyKey();
    mocks.runProcessMock.mockResolvedValue(await okRun());
    await execute(makeCtx(root, { config: { cwd: root, paperclipRuntimeSkills: [], env: { META_API_KEY: "LLM|managed-key-00000000000000000000000000000" }, managedAiConnection: { method: "subscription" } } }));
    const env = (mocks.runProcessMock.mock.calls[0]![4] as { env: Record<string, string> }).env;
    expect(env.META_API_KEY).toBe("LLM|managed-key-00000000000000000000000000000");
  });

  it("stages skills into .agents/skills and cleans them up", async () => {
    const root = await makeTempRoot();
    const skills = await makeSkill(root);
    mocks.runProcessMock.mockImplementation(async () => {
      expect(await pathExists(path.join(root, ".agents", "skills", "paperclip", "SKILL.md"))).toBe(true);
      return okRun();
    });
    await execute(makeCtx(root, { config: { cwd: root, ...skills } }));
    expect(mocks.runProcessMock).toHaveBeenCalledTimes(1);
    expect(await pathExists(path.join(root, ".agents"))).toBe(false);
  });

  it("leaves pre-existing skill dirs untouched", async () => {
    const root = await makeTempRoot();
    const existing = path.join(root, ".agents", "skills", "paperclip");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "SKILL.md"), "user-owned");
    const skills = await makeSkill(root);
    mocks.runProcessMock.mockResolvedValue(await okRun());
    await execute(makeCtx(root, { config: { cwd: root, ...skills } }));
    expect(await fs.readFile(path.join(existing, "SKILL.md"), "utf8")).toBe("user-owned");
  });

  it("removes already-staged skills when a later skill fails to stage", async () => {
    const root = await makeTempRoot();
    const skills = await makeSkill(root);
    const broken = { key: "broken", runtimeName: "broken", source: path.join(root, "runtime-skills", "does-not-exist"), required: false };
    mocks.runProcessMock.mockResolvedValue(await okRun());
    await expect(execute(makeCtx(root, {
      config: {
        cwd: root,
        paperclipRuntimeSkills: [...skills.paperclipRuntimeSkills, broken],
        paperclipSkillSync: { desiredSkills: ["paperclip", "broken"] },
      },
    }))).rejects.toThrow();
    expect(mocks.runProcessMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(root, ".agents"))).toBe(false);
  });

  it("continues when the instructions file is unreadable", async () => {
    const root = await makeTempRoot();
    const logs: string[] = [];
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, {
      config: { cwd: root, paperclipRuntimeSkills: [], instructionsFilePath: path.join(root, "missing.md") },
      onLog: async (_s, line) => { logs.push(line); },
    }));
    expect(result.exitCode).toBe(0);
    expect(logs.join("")).toMatch(/could not read agent instructions file/);
  });

  it("prepends the instructions file to the prompt", async () => {
    const root = await makeTempRoot();
    const instructions = path.join(root, "AGENTS.md");
    await fs.writeFile(instructions, "You are a Muse agent.\n");
    let prompt = "";
    mocks.runProcessMock.mockImplementation(async (_r: unknown, _t: unknown, _c: unknown, args: string[]) => {
      prompt = await fs.readFile(args[args.indexOf("--prompt-file") + 1]!, "utf8");
      return okRun();
    });
    await execute(makeCtx(root, { config: { cwd: root, paperclipRuntimeSkills: [], instructionsFilePath: instructions } }));
    expect(prompt.startsWith("You are a Muse agent.")).toBe(true);
  });

  it("runs on a remote target with the synced workspace and restores it", async () => {
    const root = await makeTempRoot();
    mocks.isRemote = true;
    mocks.runProcessMock.mockResolvedValue(await okRun());
    const result = await execute(makeCtx(root, { config: { cwd: root, paperclipRuntimeSkills: [], env: { META_API_KEY: "LLM|remote-key-000000000000000000000000000000" } } }));
    expect(mocks.prepareRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({ adapterKey: "muse", workspaceLocalDir: root }));
    expect((mocks.prepareRuntimeMock.mock.calls[0]![0] as { assets?: unknown }).assets).toBeUndefined();
    const [, , , args, options] = mocks.runProcessMock.mock.calls[0]!;
    expect(args[args.indexOf("--workspace") + 1]).toBe("/remote/ws/runs/run-1");
    expect(args).not.toContain("--prompt-file");
    expect(args.at(-1)).toContain("Paperclip");
    const env = (options as { env: Record<string, string> }).env;
    // A stable per-agent store outside the per-run workspace, so the next
    // remote heartbeat finds the Muse session (the synced workspace dir can
    // change every run).
    expect(env.XDG_DATA_HOME).toBe("/remote/ws/.paperclip-muse/agent-1/data");
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.META_API_KEY).toBe("LLM|remote-key-000000000000000000000000000000");
    // The remote agent reaches the Paperclip API through the bridge, with the
    // run's own token handed to the bridge (found in the live SSH smoke).
    expect(mocks.startBridgeMock).toHaveBeenCalledWith(expect.objectContaining({ adapterKey: "muse", hostApiToken: "run-token" }));
    expect(env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:43123");
    expect(env.PAPERCLIP_API_KEY).toBe("bridge-token");
    expect(mocks.bridgeStopMock).toHaveBeenCalled();
    expect(mocks.restoreMock).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toMatchObject({ cwd: "/remote/ws/runs/run-1", remoteExecution: { kind: "remote" } });
  });

});
