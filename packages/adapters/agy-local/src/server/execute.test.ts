import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { discoverAgySessionArtifacts, execute } from "./execute.js";
import { DENIED_ACTION_RUN, SIMPLE_RUN, TOOL_ERROR_RECOVERED_RUN } from "./fixtures.test-util.js";
import * as mcpModule from "./mcp.js";

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable: vi.fn(async () => {}),
    runChildProcess: vi.fn(async (input: { command: string; args?: string[] }) => {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ event: "init", conversation_id: "conv-fresh-1" }) + "\n" +
          JSON.stringify({ event: "result", result: { status: "SUCCESS", conversation_id: "conv-fresh-1" } }) + "\n",
        stderr: "",
      };
    }),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => {}),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async (cmd: string) => cmd),
  };
});

describe("agy-local execute", () => {
  it("passes configured mode, model, and effort to agy CLI arguments", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          mode: "plan",
          model: "claude-sonnet-4-6",
          effort: "high",
          dangerouslySkipPermissions: true,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("conv-fresh-1");

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--mode");
    expect(commandArgs[commandArgs.indexOf("--mode") + 1]).toBe("plan");
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(commandArgs).toContain("--effort");
    expect(commandArgs[commandArgs.indexOf("--effort") + 1]).toBe("high");
    expect(commandArgs).toContain("--dangerously-skip-permissions");
  });

  it("omits --effort when model already contains an effort suffix matching requested effort", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-model-effort-suffix",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          model: "gemini-3.8-flash-high",
          effort: "high",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
    expect(commandArgs).not.toContain("--effort");
  });

  it("updates suffixed model to match effort override without passing conflicting --effort", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-model-effort-override",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          model: "gemini-3.8-flash-high",
          effort: "low",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("gemini-3.8-flash-low");

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(commandArgs).not.toContain("--effort");
  });

  it("does not rewrite model to an invalid model ID when effort override is not supported by that model family", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    const logs: string[] = [];

    const ctx: AdapterExecutionContext = {
      runId: "run-model-effort-override-unsupported",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          model: "gpt-oss-120b-medium",
          effort: "high",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async (_stream, text) => {
        logs.push(text);
      },
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("gpt-oss-120b-medium");

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("gpt-oss-120b-medium");
    expect(commandArgs).not.toContain("--effort");
    expect(logs.join("")).toContain('Warning: Model "gpt-oss-120b-medium" does not have a "high" variant; running with "gpt-oss-120b-medium".');
  });

  it("preserves uncataloged effort-suffixed models and emits a warning when requested effort variant is not recognized", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    const logs: string[] = [];

    const ctx: AdapterExecutionContext = {
      runId: "run-model-custom-effort-override",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          model: "custom-preview-model-high",
          effort: "low",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async (_stream, text) => {
        logs.push(text);
      },
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("custom-preview-model-high");

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("custom-preview-model-high");
    expect(commandArgs).not.toContain("--effort");
    expect(logs.join("")).toContain('Warning: Model "custom-preview-model-high" does not have a "low" variant; running with "custom-preview-model-high".');
  });

  it("passes --conversation when resuming a previous session", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          dangerouslySkipPermissions: true,
        },
      },
      runtime: {
        sessionId: "conv-prior-1",
        sessionParams: {
          sessionId: "conv-prior-1",
          cwd: "/tmp/workspace",
        },
        sessionDisplayId: "conv-prior-1",
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--conversation");
    expect(commandArgs[commandArgs.indexOf("--conversation") + 1]).toBe("conv-prior-1");
  });

  it("passes multi-workspace --add-dir, --agent, --sandbox, and --json-schema", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-3",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          agent: "flutter_a11y_agent",
          sandbox: true,
          jsonSchema: '{"type":"object"}',
          addDirs: ["/tmp/extra-repo"],
          dangerouslySkipPermissions: true,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/main-workspace",
        },
        paperclipWorkspaces: [
          { cwd: "/tmp/main-workspace" },
          { cwd: "/tmp/second-workspace" },
        ],
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];

    // Verify --add-dir contains main-workspace, second-workspace, and extra-repo
    const addDirIndices: number[] = [];
    commandArgs.forEach((arg, idx) => {
      if (arg === "--add-dir") addDirIndices.push(idx + 1);
    });
    const addDirValues = addDirIndices.map((i) => commandArgs[i]);
    expect(addDirValues).toContain("/tmp/main-workspace");
    expect(addDirValues).toContain("/tmp/second-workspace");
    expect(addDirValues).toContain("/tmp/extra-repo");

    // Verify agent, sandbox, jsonSchema
    expect(commandArgs).toContain("--agent");
    expect(commandArgs[commandArgs.indexOf("--agent") + 1]).toBe("flutter_a11y_agent");
    expect(commandArgs).toContain("--sandbox");
    expect(commandArgs).toContain("--json-schema");
    expect(commandArgs[commandArgs.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  });

  it("omits --dangerously-skip-permissions by default when dangerouslySkipPermissions is omitted", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-5",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("omits --dangerously-skip-permissions when dangerouslySkipPermissions is false", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-4",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          dangerouslySkipPermissions: false,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("does not pass --mode when mode is omitted (defaults to edit mode)", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-default-mode",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).not.toContain("--mode");
  });

  it("passes --mode accept-edits when mode is explicitly set to accept-edits", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-accept-edits-mode",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          mode: "accept-edits",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--mode");
    expect(commandArgs[commandArgs.indexOf("--mode") + 1]).toBe("accept-edits");
  });

  it("passes --project, --print-timeout, and --disable-slash-commands when configured", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-custom-flags",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          project: "paperclip-core",
          printTimeout: "45m",
          disableSlashCommands: true,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--project");
    expect(commandArgs[commandArgs.indexOf("--project") + 1]).toBe("paperclip-core");
    expect(commandArgs).toContain("--print-timeout");
    expect(commandArgs[commandArgs.indexOf("--print-timeout") + 1]).toBe("45m");
    expect(commandArgs).toContain("--disable-slash-commands");
  });

  it("defaults --print-timeout to 24h when timeoutSec is 0 or aligns to timeoutSec", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-timeout-align",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          timeoutSec: 360,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--print-timeout");
    expect(commandArgs[commandArgs.indexOf("--print-timeout") + 1]).toBe("360s");
  });
});

describe("agy-local execute run outcome", () => {
  const runWithOutput = async (stdout: string, stderr = "", exitCode = 0) => {
    vi.mocked(runChildProcess).mockResolvedValueOnce({
      exitCode,
      signal: null,
      timedOut: false,
      stdout,
      stderr,
    } as Awaited<ReturnType<typeof runChildProcess>>);
    const logs: string[] = [];
    const result = await execute({
      runId: "run-outcome",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {},
      context: { paperclipWorkspace: { cwd: "/tmp/workspace" } },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    return { result, logs: logs.join("") };
  };

  it("reports a SUCCESS run as succeeded despite a recovered tool error and auth-like transcript text", async () => {
    const stdout = TOOL_ERROR_RECOVERED_RUN.replace(
      '"text_delta":"RECOVERED"',
      '"text_delta":"No unauthenticated endpoints; no 401 or 429 responses found. RECOVERED"',
    );
    const { result } = await runWithOutput(stdout);
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("RECOVERED");
  });

  it("fails an auto-denied run with agy_permission_denied and logs how to fix it", async () => {
    const { result, logs } = await runWithOutput(DENIED_ACTION_RUN);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("agy_permission_denied");
    expect(result.errorMessage).toMatch(/WriteToFile/);
    expect(result.summary).toBe(result.errorMessage);
    expect(logs).toMatch(/auto-denied 1 tool action\(s\): WriteToFile/);
  });

  it("returns no summary for a successful run with an empty response", async () => {
    const stdout = SIMPLE_RUN.replace(/"text_delta":"[^"]*"/g, '"text_delta":""').replace(
      '"response":"HELLO_AGY\\n"',
      '"response":""',
    );
    const { result } = await runWithOutput(stdout);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBeNull();
  });

  it("keeps a run that answered after a denied action successful but still logs the denial", async () => {
    const stdout = DENIED_ACTION_RUN.replace('"response":""', '"response":"Wrote the text into my reply instead."');
    const { result, logs } = await runWithOutput(stdout);
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(logs).toMatch(/auto-denied 1 tool action\(s\): WriteToFile/);
  });

  it("still classifies a real authentication failure from the terminal result", async () => {
    const { result } = await runWithOutput(
      '{"event":"result","result":{"status":"ERROR","error":"not authenticated: please sign in"}}',
    );
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("agy_auth_required");
    expect(result.errorMessage).toBe("not authenticated: please sign in");
  });

  it("streams prompt via stdin NDJSON with --input-format stream-json by default, avoiding --print argv", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    vi.mocked(runChildProcess).mockClear();

    const ctx: AdapterExecutionContext = {
      runId: "run-stream-json",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--input-format");
    expect(commandArgs[commandArgs.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(commandArgs).not.toContain("--print");

    const calls = vi.mocked(runChildProcess).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCallOptions = calls[calls.length - 1][3] as { stdin?: string };
    expect(lastCallOptions?.stdin).toBeDefined();
    const parsedStdin = JSON.parse(lastCallOptions.stdin!.trim());
    expect(parsedStdin.event).toBe("user");
    expect(parsedStdin.message.content).toBeDefined();
  });

  it("falls back to --print argv when inputFormat is explicitly configured as text", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    vi.mocked(runChildProcess).mockClear();

    const ctx: AdapterExecutionContext = {
      runId: "run-text-input",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          inputFormat: "text",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--input-format");
    expect(commandArgs[commandArgs.indexOf("--input-format") + 1]).toBe("text");
    expect(commandArgs).toContain("--print");

    const calls = vi.mocked(runChildProcess).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCallOptions = calls[calls.length - 1][3] as { stdin?: string };
    expect(lastCallOptions?.stdin).toBeUndefined();
  });

  it("delivers runtime connection tools via environment and configures MCP servers", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-exec-mcp-"));

    try {
      const cleanupSpy = vi.fn(async () => {});
      const writeMcpSpy = vi.spyOn(mcpModule, "prepareAgyLocalRunMcpHome").mockResolvedValueOnce({
        homeDir: path.join(tempHome, "run-home"),
        configPath: path.join(tempHome, "run-home", ".gemini", "config", "mcp_config.json"),
        injectedServerNames: ["Paperclip connections"],
        cleanup: cleanupSpy,
      });

      const ctx: AdapterExecutionContext = {
        runId: "run-mcp-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Test Agent",
          adapterType: "agy_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          env: {
            HOME: tempHome,
          },
        },
        context: {},
        runtimeMcp: {
          getServers: () => [
            {
              name: "Paperclip connections",
              url: "https://api.paperclip.test/mcp/connections",
              token: "tok-123",
              connectionId: "conn-123",
            },
          ],
        },
        runtimeTools: {
          version: 1,
          guidance: "Use these tools",
          mcpEndpoint: "https://api.paperclip.test/mcp/connections",
          rest: {
            connectionsSearch: "https://api.paperclip.test/connections/search",
            connectionRequest: "https://api.paperclip.test/connections/request",
          },
          bearerToken: "tok-123",
          expiresAt: "2026-10-09T00:00:00Z",
          tools: ["connections_search", "connection_request"],
        },
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedMeta = meta;
        },
      };

      const result = await execute(ctx);
      expect(result.exitCode).toBe(0);
      expect(writeMcpSpy).toHaveBeenCalledOnce();
      expect(cleanupSpy).toHaveBeenCalledOnce();

      expect(capturedMeta!.env!.PAPERCLIP_RUNTIME_TOOLS_MCP_URL).toBe(
        "https://api.paperclip.test/mcp/connections",
      );
      expect(capturedMeta!.env!.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBe("***REDACTED***");
      const calls = vi.mocked(runChildProcess).mock.calls;
      const lastCallOptions = calls[calls.length - 1][3] as { env?: Record<string, string> };
      expect(lastCallOptions?.env?.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBe("tok-123");
      // The process runs with the private per-run HOME, never the shared one.
      expect(lastCallOptions?.env?.HOME).toBe(path.join(tempHome, "run-home"));
      expect(result.sessionParams?.mcpServerIdentity).toBeDefined();

      writeMcpSpy.mockRestore();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("notes a changed MCP server set when resuming and stamps the current identity", async () => {
    const logs: string[] = [];
    let capturedMeta: AdapterInvocationMeta | null = null;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "agy-exec-mcp-resume-"));

    try {
      const writeMcpSpy = vi.spyOn(mcpModule, "prepareAgyLocalRunMcpHome").mockResolvedValue({
        homeDir: path.join(tempHome, "run-home"),
        configPath: path.join(tempHome, "run-home", ".gemini", "config", "mcp_config.json"),
        injectedServerNames: ["Paperclip connections"],
        cleanup: async () => {},
      });

      const ctx: AdapterExecutionContext = {
        runId: "run-mcp-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Test Agent",
          adapterType: "agy_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "conv-prior-1",
          sessionParams: {
            sessionId: "conv-prior-1",
            cwd: "/tmp/workspace",
            mcpServerIdentity: JSON.stringify([
              { name: "Paperclip connections", url: "https://old.example/mcp", connectionId: "conn-old" },
            ]),
          },
          sessionDisplayId: "conv-prior-1",
          taskKey: null,
        },
        config: {
          env: {
            HOME: tempHome,
          },
        },
        context: {
          paperclipWorkspace: {
            cwd: "/tmp/workspace",
          },
        },
        runtimeMcp: {
          getServers: () => [
            {
              name: "Paperclip connections",
              url: "https://api.paperclip.test/mcp/connections",
              token: "tok-123",
              connectionId: "conn-123",
            },
          ],
        },
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (meta) => {
          capturedMeta = meta;
        },
      };

      const result = await execute(ctx);
      expect(result.exitCode).toBe(0);

      // The session still resumes: agy re-reads mcp_config.json on every
      // invocation, so the changed tool set is loaded, not fatal.
      const commandArgs = capturedMeta!.commandArgs as string[];
      expect(commandArgs).toContain("--conversation");
      expect(commandArgs[commandArgs.indexOf("--conversation") + 1]).toBe("conv-prior-1");
      expect(logs.join("")).toContain("MCP server set changed");

      expect(result.sessionParams?.mcpServerIdentity).toBe(
        JSON.stringify([
          {
            name: "Paperclip connections",
            url: "https://api.paperclip.test/mcp/connections",
            connectionId: "conn-123",
          },
        ]),
      );

      writeMcpSpy.mockRestore();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // Remote execution targets are covered in execute.remote.test.ts: remote
  // runs receive the managed MCP config via the staged sync, so the local
  // per-run home is not used but the session does carry mcpServerIdentity.
});

describe("discoverAgySessionArtifacts", () => {
  it("returns empty array for invalid or missing sessionId", async () => {
    expect(await discoverAgySessionArtifacts("")).toEqual([]);
    expect(await discoverAgySessionArtifacts("non-existent-conv-id-99999")).toEqual([]);
  });
});
