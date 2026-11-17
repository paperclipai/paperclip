/**
 * TECH-8174: Hermes on a sandbox target. Modeled on pi-local's execute.remote.test.ts: the
 * execution-target layer is mocked with a fake sandbox, and nothing may run on this host.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const RUN_JWT = "run-jwt-SENTINEL-8174-do-not-ship";
const BRIDGE_TOKEN = "bridge-token-8174";
const BRIDGE_URL = "http://127.0.0.1:47123";
const PROVIDER_KEY = "sk-provider-explicit-8174";
const ROUTER_KEY = "rr-agent-bound-router-key-8174-abcdef";
const MCP_TOKEN = "mcp-gateway-token-8174";
const REMOTE_CWD = "/workspace";
const REMOTE_WS = "/workspace/.paperclip-runtime/runs/run-sbx/workspace";
const REMOTE_RUNTIME = `${REMOTE_WS}/.paperclip-runtime/hermes`;
const REMOTE_HERMES_HOME = `${REMOTE_RUNTIME}/hermesHome`;
const REMOTE_INSTRUCTIONS = `${REMOTE_RUNTIME}/instructions`;

interface ProcessCall {
  command: string;
  args: string[];
  options: { cwd: string; env: Record<string, string>; stdin?: string; timeoutSec: number };
}

const h = vi.hoisted(() => ({
  processCalls: [] as ProcessCall[],
  shellCalls: [] as string[],
  prepareInputs: [] as Array<{ adapterKey: string; workspaceLocalDir: string; assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean }> }>,
  shipped: {} as Record<string, Record<string, string>>,
  restoreWorkspace: vi.fn(async () => {}),
  bridgeStop: vi.fn(async () => {}),
  hermesStdout: "Pod answer.\n\nsession_id: sess-pod-1\n",
  hermesExit: 0 as number | null,
  stageExit: 0,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => {
      throw new Error("host spawn is forbidden for a sandbox run");
    }),
  };
});

async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string, rel: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, relPath);
      else out[relPath] = await fs.readFile(full, "utf8").catch(() => "<unreadable>");
    }
  };
  await walk(dir, "");
  return out;
}

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    prepareAdapterExecutionTargetRuntime: vi.fn(async (input: (typeof h.prepareInputs)[number]) => {
      h.prepareInputs.push(input);
      for (const asset of input.assets ?? []) h.shipped[asset.key] = await snapshotDir(asset.localDir);
      return {
        target: input,
        workspaceRemoteDir: REMOTE_WS,
        runtimeRootDir: REMOTE_RUNTIME,
        assetDirs: Object.fromEntries((input.assets ?? []).map((a) => [a.key, `${REMOTE_RUNTIME}/${a.key}`])),
        additionalSourceDirs: {},
        additionalSourceFailures: [],
        workspaceSyncSnapshot: null,
        restoreWorkspace: h.restoreWorkspace,
      };
    }),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
      env: { PAPERCLIP_API_URL: BRIDGE_URL, PAPERCLIP_API_KEY: BRIDGE_TOKEN, PAPERCLIP_API_BRIDGE_MODE: "queue_v1" },
      stop: h.bridgeStop,
    })),
    runAdapterExecutionTargetProcess: vi.fn(async (_runId: string, _target: unknown, command: string, args: string[], options: ProcessCall["options"]) => {
      h.processCalls.push({ command, args, options });
      const isHermes = command.endsWith("/hermes");
      return {
        exitCode: isHermes ? h.hermesExit : h.stageExit,
        signal: null,
        timedOut: false,
        stdout: isHermes ? h.hermesStdout : "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      };
    }),
    runAdapterExecutionTargetShellCommand: vi.fn(async (_runId: string, _target: unknown, command: string) => {
      h.shellCalls.push(command);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() };
    }),
  };
});

import { execute } from "./execute.js";
import {
  HERMES_SANDBOX_COMMAND_SCAN_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_MANAGED_CONNECTION_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_PROVIDER_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_MEMORY_PROVIDER_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_RUNTIME_MEMORY_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE,
  HERMES_SANDBOX_UNTRUSTED_COMMAND_MESSAGE,
} from "./execute-sandbox.js";
import { HERMES_MAX_SYSTEM_PROMPT_BYTES } from "./execute.js";
import { ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE } from "./router-readiness.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { prepareAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "kubernetes",
  environmentId: "env-1",
  leaseId: "lease-1",
  remoteCwd: REMOTE_CWD,
};

const ENV_KEYS = ["HOME", "TMPDIR", "PAPERCLIP_HERMES_COMMAND_SCAN", "DATABASE_URL"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let root: string;
let workspaceDir: string;
let instructionsPath: string;
let logs: Array<[string, string]>;

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-sandbox-test-")));
  const hostHome = path.join(root, "host-home");
  await fs.mkdir(path.join(hostHome, ".hermes"), { recursive: true });
  // A host Hermes config that must never influence a sandbox run.
  await fs.writeFile(path.join(hostHome, ".hermes", "config.yaml"), "model:\n  default: host-model\n  provider: router\n");
  await fs.writeFile(path.join(hostHome, ".hermes", ".env"), "OPENAI_API_KEY=sk-host-dotenv-SENTINEL\n");
  process.env.HOME = hostHome;
  process.env.TMPDIR = root;
  process.env.DATABASE_URL = "postgres://host-db-SENTINEL";
  delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
  vi.spyOn(os, "homedir").mockReturnValue(hostHome);
  workspaceDir = path.join(root, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const bundleDir = path.join(root, "bundle");
  await fs.mkdir(bundleDir, { recursive: true });
  instructionsPath = path.join(bundleDir, "AGENTS.md");
  await fs.writeFile(instructionsPath, "You are the sandbox test agent. See notes.md.");
  await fs.writeFile(path.join(bundleDir, "notes.md"), "sibling file");
  logs = [];
  h.processCalls.length = 0;
  h.shellCalls.length = 0;
  h.prepareInputs.length = 0;
  for (const key of Object.keys(h.shipped)) delete h.shipped[key];
  h.hermesStdout = "Pod answer.\n\nsession_id: sess-pod-1\n";
  h.hermesExit = 0;
  h.stageExit = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

function ctx(overrides: { config?: Record<string, unknown>; target?: AdapterExecutionTarget; extra?: Partial<AdapterExecutionContext> } = {}): AdapterExecutionContext {
  return {
    runId: "run-sbx",
    agent: { id: "agent-1", companyId: "company-1", name: "Sandbox Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: { sessionId: "prev-session" }, sessionDisplayId: null, taskKey: null },
    config: {
      provider: "openai-api",
      model: "gpt-5.4",
      instructionsFilePath: instructionsPath,
      env: {
        OPENAI_API_KEY: PROVIDER_KEY,
        PAPERCLIP_API_KEY: "config-supplied-key-must-not-survive",
        DATABASE_URL: "postgres://config-db-SENTINEL",
        PATH: "/host/only/bin",
      },
      ...(overrides.config ?? {}),
    },
    context: {
      taskId: "task-1",
      wakeReason: "issue_assigned",
      paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      paperclipTaskMarkdown: "TASK-BODY-SENTINEL: please do the thing",
    },
    executionTarget: overrides.target ?? sandboxTarget,
    authToken: RUN_JWT,
    onLog: async (stream: string, chunk: string) => {
      logs.push([stream, chunk]);
    },
    ...(overrides.extra ?? {}),
  } as unknown as AdapterExecutionContext;
}

function hermesCall(): ProcessCall {
  const call = h.processCalls.find((c) => c.command.endsWith("/hermes"));
  if (!call) throw new Error("hermes was not launched");
  return call;
}

describe("Hermes execute on a sandbox target (TECH-8174)", () => {
  it("runs Hermes in the sandbox with a shipped home, the prompt in a file, and only sandbox paths in env", async () => {
    const result = await execute(ctx());

    // Nothing ran on the host.
    expect(runChildProcess).not.toHaveBeenCalled();

    // Assets: an isolated Hermes home (never the host ~/.hermes) and the instructions bundle dir.
    const prepare = h.prepareInputs[0]!;
    expect(prepare.adapterKey).toBe("hermes");
    expect(prepare.workspaceLocalDir).toBe(workspaceDir);
    expect(prepare.assets?.map((a) => a.key)).toEqual(["hermesHome", "instructions"]);
    expect(prepare.assets?.[0]?.followSymlinks).toBe(true);
    expect(Object.keys(h.shipped.hermesHome ?? {})).toEqual(expect.arrayContaining(["config.yaml", ".env"]));
    const shippedHome = JSON.stringify(h.shipped.hermesHome);
    expect(shippedHome).not.toContain("host-model");
    expect(shippedHome).not.toContain("sk-host-dotenv-SENTINEL");
    expect(shippedHome).not.toContain(RUN_JWT);
    // An external instructions file is shipped alone: its directory may hold anything (.env, a repo).
    expect(Object.keys(h.shipped.instructions ?? {})).toEqual(["AGENTS.md"]);
    expect(prepare.assets?.[1]?.followSymlinks).toBe(false);

    // The prompt is staged over stdin, never in argv.
    const stage = h.processCalls[0]!;
    expect(stage.command).toBe("sh");
    expect(stage.options.stdin).toContain("TASK-BODY-SENTINEL");
    expect(stage.args.join(" ")).not.toContain("TASK-BODY-SENTINEL");
    expect(stage.args).toContain(`${REMOTE_RUNTIME}/query.txt`);
    expect(stage.options.env).toEqual({});

    const call = hermesCall();
    expect(call.command).toBe("/opt/hermes/bin/hermes");
    expect(call.args.slice(0, 3)).toEqual(["chat", "--query-file", `${REMOTE_RUNTIME}/query.txt`]);
    expect(call.args).toEqual(expect.arrayContaining(["--provider", "openai-api", "-m", "gpt-5.4", "--source", "tool", "--yolo"]));
    expect(call.args).not.toContain("--resume");
    expect(call.args.join(" ")).not.toContain("TASK-BODY-SENTINEL");
    expect(call.options.cwd).toBe(REMOTE_WS);

    // Env: bridge identity instead of the run JWT; sandbox paths only.
    const env = call.options.env;
    expect(JSON.stringify(env)).not.toContain(RUN_JWT);
    expect(JSON.stringify(call.args)).not.toContain(RUN_JWT);
    expect(env.PAPERCLIP_API_KEY).toBe(BRIDGE_TOKEN);
    expect(env.PAPERCLIP_API_URL).toBe(BRIDGE_URL);
    expect(env.OPENAI_API_KEY).toBe(PROVIDER_KEY);
    expect(env.HERMES_HOME).toBe(REMOTE_HERMES_HOME);
    expect(env.HOME).toBe(`${REMOTE_RUNTIME}/home`);
    expect(env.TMPDIR).toBe(`${REMOTE_RUNTIME}/home/tmp`);
    expect(env.PATH).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.HERMES_DISABLE_LAZY_INSTALLS).toBe("1");
    expect(env.MEM0_TELEMETRY).toBe("False");
    expect(env.PAPERCLIP_TASK_ID).toBe("task-1");
    for (const [key, value] of Object.entries(env)) {
      expect(value, key).not.toContain(root);
      expect(value, key).not.toContain(os.tmpdir());
    }
    expect(env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toContain("You are the sandbox test agent.");
    expect(env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toContain(`loaded from ${REMOTE_INSTRUCTIONS}/AGENTS.md`);
    expect(stage.options.stdin).toContain(BRIDGE_URL);

    // Result: parsed from the sandbox stdout; never a session to resume.
    expect(result.clearSession).toBe(true);
    expect(result.sessionParams).toBeUndefined();
    expect(result.summary).toBe("Pod answer.");
    expect(result.exitCode).toBe(0);

    // Cleanup: bridge stopped, remote home/prompt removed, workspace restored, local assets gone.
    expect(h.bridgeStop).toHaveBeenCalledTimes(1);
    expect(h.restoreWorkspace).toHaveBeenCalledTimes(1);
    expect(h.shellCalls.some((c) => c.startsWith("rm -rf") && c.includes(REMOTE_HERMES_HOME) && c.includes(`${REMOTE_RUNTIME}/query.txt`))).toBe(true);
    const localHome = prepare.assets?.[0]?.localDir ?? "";
    await expect(fs.stat(localHome)).rejects.toThrow();
  });

  it("drops runtime MCP servers with a warning and ships none of their tokens", async () => {
    await execute(ctx({
      extra: {
        runtimeMcp: {
          getServers: () => [{ name: "Gateway", url: "https://paperclip.example/mcp/gateways/g1", token: MCP_TOKEN, connectionId: "c1", allowedTools: ["t"] }],
        },
      } as Partial<AdapterExecutionContext>,
    }));
    expect(logs.some(([, line]) => line.includes("runtime MCP server(s) are not available in sandbox environments yet"))).toBe(true);
    expect(JSON.stringify(h.shipped)).not.toContain(MCP_TOKEN);
    expect(JSON.stringify(hermesCall().options.env)).not.toContain(MCP_TOKEN);
  });

  it("carries a maximum-size system prompt in env (never argv)", async () => {
    // Fill the instructions so the overlay lands just under the limit.
    const probe = await (async () => {
      await execute(ctx());
      return Buffer.byteLength(hermesCall().options.env.HERMES_EPHEMERAL_SYSTEM_PROMPT ?? "", "utf8");
    })();
    h.processCalls.length = 0;
    const padding = "p".repeat(HERMES_MAX_SYSTEM_PROMPT_BYTES - probe);
    await fs.writeFile(instructionsPath, `You are the sandbox test agent. See notes.md.${padding}`);
    await execute(ctx());
    const prompt = hermesCall().options.env.HERMES_EPHEMERAL_SYSTEM_PROMPT ?? "";
    expect(Buffer.byteLength(prompt, "utf8")).toBe(HERMES_MAX_SYSTEM_PROMPT_BYTES);
    expect(hermesCall().args.join(" ")).not.toContain(padding.slice(0, 64));
  });

  it("keeps the stdout failure text out of the summary on a non-zero exit", async () => {
    h.hermesExit = 2;
    h.hermesStdout = "HTTP 401 from provider\n";
    const result = await execute(ctx());
    expect(result.summary).toBeUndefined();
    expect(result.errorMessage).toBe("Hermes exited with code 2: HTTP 401 from provider");
    expect(result.clearSession).toBe(true);
  });

  it("ships a Paperclip-managed instructions bundle whole, without following symlinks", async () => {
    const bundleDir = path.dirname(instructionsPath);
    await fs.writeFile(path.join(bundleDir, ".env"), "SECRET=never-ships-from-external-dirs");
    await execute(ctx({ config: { instructionsBundleMode: "managed", instructionsRootPath: bundleDir } }));
    expect(h.shipped.instructions?.["notes.md"]).toBe("sibling file");
    expect(h.prepareInputs[0]!.assets?.[1]).toMatchObject({ localDir: bundleDir, followSymlinks: false });
    expect(hermesCall().options.env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toContain(`loaded from ${REMOTE_INSTRUCTIONS}/AGENTS.md`);
  });

  it("ships only the instructions file when the bundle is external, never its directory", async () => {
    const bundleDir = path.dirname(instructionsPath);
    await fs.writeFile(path.join(bundleDir, ".env"), "SECRET=must-not-ship");
    await execute(ctx({ config: { instructionsBundleMode: "external", instructionsRootPath: bundleDir } }));
    expect(Object.keys(h.shipped.instructions ?? {})).toEqual(["AGENTS.md"]);
    expect(JSON.stringify(h.shipped)).not.toContain("must-not-ship");
  });

  it("ships a symlinked external instructions file as a plain copy of its content, never the link target's directory", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "real.md"), "linked instructions");
    await fs.writeFile(path.join(outside, ".env"), "SECRET=outside-must-not-ship");
    const link = path.join(root, "bundle", "LINKED.md");
    await fs.symlink(path.join(outside, "real.md"), link);
    await execute(ctx({ config: { instructionsFilePath: link } }));
    expect(h.shipped.instructions).toEqual({ "LINKED.md": "linked instructions" });
    const localDir = h.prepareInputs[0]!.assets?.[1]?.localDir ?? "";
    // The local copy lives in the run's scratch home and is removed with it.
    await expect(fs.stat(localDir)).rejects.toThrow();
  });

  it("does not treat a managed-root file whose name starts with '..' as outside the root", async () => {
    const bundleDir = path.dirname(instructionsPath);
    const dotted = path.join(bundleDir, "..notes.md");
    await fs.writeFile(dotted, "dotted");
    await execute(ctx({ config: { instructionsFilePath: dotted, instructionsBundleMode: "managed", instructionsRootPath: bundleDir } }));
    expect(h.prepareInputs[0]!.assets?.[1]?.localDir).toBe(bundleDir);
  });

  it("redacts the agent's provider key and the bridge token from output", async () => {
    h.hermesStdout = `echo ${PROVIDER_KEY} and ${BRIDGE_TOKEN}\n\nsession_id: s\n`;
    const result = await execute(ctx());
    const everything = JSON.stringify({ result, logs });
    expect(everything).not.toContain(PROVIDER_KEY);
    expect(everything).not.toContain(BRIDGE_TOKEN);
  });

  it("refuses an oversized system prompt before anything is staged", async () => {
    await fs.writeFile(instructionsPath, "x".repeat(HERMES_MAX_SYSTEM_PROMPT_BYTES + 1));
    await expect(execute(ctx())).rejects.toThrow(/exceeds maximum argument size/);
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
  });

  it("fails a completed run when the workspace copy-back fails", async () => {
    h.restoreWorkspace.mockRejectedValueOnce(new Error("copy-back failed"));
    await expect(execute(ctx())).rejects.toThrow("copy-back failed");
  });

  it("keeps the original error when the run fails and the copy-back also fails", async () => {
    h.restoreWorkspace.mockRejectedValueOnce(new Error("copy-back failed"));
    h.stageExit = 1;
    await expect(execute(ctx())).rejects.toThrow("Could not stage the Hermes prompt in the sandbox.");
    expect(logs.some(([, line]) => line.includes("Sandbox workspace restore failed after the run failed: copy-back failed"))).toBe(true);
    expect(h.processCalls.some((c) => c.command.endsWith("/hermes"))).toBe(false);
    expect(h.shellCalls.some((c) => c.startsWith("rm -rf"))).toBe(true);
  });

  it("routes a legacy remote transport to the sandbox path (refused there as SSH)", async () => {
    const c = ctx();
    (c as unknown as Record<string, unknown>).executionTarget = undefined;
    (c as unknown as Record<string, unknown>).executionTransport = {
      remoteExecution: { host: "h", port: 22, username: "u", remoteWorkspacePath: "/srv", remoteCwd: "/srv", privateKey: "k", knownHosts: "h k", strictHostKeyChecking: true },
    };
    await expect(execute(c)).rejects.toThrow(HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE);
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, () => AdapterExecutionContext, string]> = [
    [
      "an SSH target",
      () => ctx({
        target: {
          kind: "remote",
          transport: "ssh",
          remoteCwd: "/srv",
          spec: { host: "h", port: 22, username: "u", remoteWorkspacePath: "/srv", remoteCwd: "/srv", privateKey: null, knownHosts: null, strictHostKeyChecking: true },
        } as unknown as AdapterExecutionTarget,
      }),
      HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE,
    ],
    [
      "Paperclip runtime memory",
      () => ctx({ extra: { runtimeMemory: { getConfig: async () => ({}) } } as unknown as Partial<AdapterExecutionContext> }),
      HERMES_SANDBOX_RUNTIME_MEMORY_UNSUPPORTED_MESSAGE,
    ],
    ["an env-configured memory provider", () => ctx({ config: { memoryProvider: "mem0" } }), HERMES_SANDBOX_MEMORY_PROVIDER_UNSUPPORTED_MESSAGE],
    [
      "a Ramp Router run",
      () => ctx({ config: { provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: ROUTER_KEY } } }),
      ROUTER_REMOTE_TARGET_UNSUPPORTED_MESSAGE,
    ],
    ["a custom Hermes command", () => ctx({ config: { hermesCommand: "/tmp/evil-hermes" } }), HERMES_SANDBOX_UNTRUSTED_COMMAND_MESSAGE],
    ["managed AI routing", () => ctx({ config: { managedAiRouting: { id: "x" } } }), HERMES_SANDBOX_MANAGED_CONNECTION_UNSUPPORTED_MESSAGE],
    ["a managed AI connection", () => ctx({ config: { managedAiConnection: { id: "x" } } }), HERMES_SANDBOX_MANAGED_CONNECTION_UNSUPPORTED_MESSAGE],
    [
      "a sandbox provider other than Kubernetes",
      () => ctx({ target: { ...sandboxTarget, providerKey: "modal" } as AdapterExecutionTarget }),
      HERMES_SANDBOX_PROVIDER_UNSUPPORTED_MESSAGE,
    ],
  ];

  for (const [label, makeCtx, message] of refusals) {
    it(`refuses ${label} before anything is staged or launched`, async () => {
      await expect(execute(makeCtx())).rejects.toThrow(message);
      expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
      expect(h.processCalls).toHaveLength(0);
      expect(runChildProcess).not.toHaveBeenCalled();
    });
  }

  it("refuses required command-scan mode before anything is staged or launched", async () => {
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
    await expect(execute(ctx())).rejects.toThrow(HERMES_SANDBOX_COMMAND_SCAN_UNSUPPORTED_MESSAGE);
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("requires an explicit provider credential (never the host's)", async () => {
    await expect(execute(ctx({ config: { env: {} } }))).rejects.toThrow(/explicit provider credential/);
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
  });

  it("stages an empty workspace instead of the server cwd when the run has none", async () => {
    const c = ctx();
    (c as unknown as { context: Record<string, unknown> }).context = { taskId: "task-1" };
    await execute(c);
    const local = h.prepareInputs[0]!.workspaceLocalDir;
    expect(local).not.toBe(process.cwd());
    expect(path.basename(local)).toMatch(/^paperclip-hermes-sandbox-ws-/);
    await expect(fs.stat(local)).rejects.toThrow();
  });
});
