import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { discoverAgySessionArtifacts, execute } from "./execute.js";

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
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
          model: "gemini-3.7-flash-high",
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
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("gemini-3.7-flash-high");
    expect(commandArgs).toContain("--effort");
    expect(commandArgs[commandArgs.indexOf("--effort") + 1]).toBe("high");
    expect(commandArgs).toContain("--dangerously-skip-permissions");
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

describe("discoverAgySessionArtifacts", () => {
  it("returns empty array for invalid or missing sessionId", async () => {
    expect(await discoverAgySessionArtifacts("")).toEqual([]);
    expect(await discoverAgySessionArtifacts("non-existent-conv-id-99999")).toEqual([]);
  });
});
