import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const WINDOWS_CMD_LINE_LIMIT = 8191;

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  ensurePiModelConfiguredAndAvailable,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: "done",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cost: { total: 0.01 },
        },
      },
      toolResults: [],
    }),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "pi"),
  ensurePiModelConfiguredAndAvailable: vi.fn(async () => [
    { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
  ]),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    ensurePiModelConfiguredAndAvailable,
  };
});

import { execute } from "./execute.js";

type SpawnCall = [
  string,
  string,
  string[],
  { env: Record<string, string>; stdin?: string },
];

describe("pi local prompt delivery", () => {
  const cleanupDirs: string[] = [];
  const cleanupFiles: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupFiles.length > 0) {
      const file = cleanupFiles.pop();
      if (!file) continue;
      await rm(file, { force: true }).catch(() => undefined);
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a 12k+ prompt off argv and under the Windows cmd.exe limit", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-prompt-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const hugeInstructions = `Use the isolated workspace.\n${"A".repeat(12_000)}`;
    const instructionsPath = path.join(workspaceDir, "AGENTS.md");
    await writeFile(instructionsPath, hugeInstructions, "utf8");

    let capturedArgs: string[] = [];
    let stagedPrompt = "";
    const result = await execute({
      runId: "run-prompt-limit",
      agent: {
        id: "agent-prompt-limit",
        companyId: "company-1",
        name: "Pi Builder",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "pi",
        model: "openai/gpt-5.4-mini",
        instructionsFilePath: instructionsPath,
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedArgs = Array.isArray(meta.commandArgs) ? meta.commandArgs.map(String) : [];
        const promptFlag = capturedArgs.indexOf("--append-system-prompt");
        const promptArg = promptFlag >= 0 ? capturedArgs[promptFlag + 1] : "";
        if (promptArg) stagedPrompt = await readFile(promptArg, "utf8");
      },
    });

    if (typeof result.sessionId === "string" && result.sessionId.length > 0) {
      cleanupFiles.push(result.sessionId);
    }

    const call = runChildProcess.mock.calls[0] as unknown as SpawnCall | undefined;
    expect(call).toBeDefined();
    const args = call?.[2] ?? [];
    const stdin = call?.[3].stdin ?? "";

    expect(args).toContain("-p");
    expect(args).toContain("--append-system-prompt");
    expect(args.join(" ").length).toBeLessThan(WINDOWS_CMD_LINE_LIMIT);
    expect(capturedArgs.join(" ").length).toBeLessThan(WINDOWS_CMD_LINE_LIMIT);
    expect(args.join("\0")).not.toContain(hugeInstructions);
    expect(capturedArgs.join("\0")).not.toContain(hugeInstructions);
    expect(args).not.toContain(stdin);
    expect(stdin.length).toBeGreaterThan(0);

    const promptFlag = args.indexOf("--append-system-prompt");
    const promptArg = promptFlag >= 0 ? args[promptFlag + 1] : "";
    expect(promptArg).toBeTruthy();
    expect(promptArg.length).toBeLessThan(400);
    expect(stagedPrompt).toContain(hugeInstructions);
    expect(stagedPrompt).toContain("The above agent instructions were loaded from");
  });

  it("enables the native PowerShell tool and shell guidance on Windows", async () => {
    if (process.platform !== "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-windows-tools-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    let capturedArgs: string[] = [];
    let stagedPrompt = "";
    const result = await execute({
      runId: "run-windows-tools",
      agent: {
        id: "agent-windows-tools",
        companyId: "company-1",
        name: "Pi Builder",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "pi",
        model: "openai/gpt-5.4-mini",
        promptTemplate: "Keep working.",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedArgs = Array.isArray(meta.commandArgs) ? meta.commandArgs.map(String) : [];
        const promptPathFlag = capturedArgs.indexOf("--append-system-prompt");
        const promptArg = promptPathFlag >= 0 ? capturedArgs[promptPathFlag + 1] : "";
        if (promptArg) stagedPrompt = await readFile(promptArg, "utf8");
      },
    });

    if (typeof result.sessionId === "string" && result.sessionId.length > 0) {
      cleanupFiles.push(result.sessionId);
    }

    const toolsFlag = capturedArgs.indexOf("--tools");
    expect(toolsFlag).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[toolsFlag + 1]).toBe("read,bash,powershell,edit,write,grep,find,ls");
    expect(stagedPrompt).toContain("Use the `powershell` tool for PowerShell-native syntax");
    expect(stagedPrompt).toContain("Where-Object { $_.PSIsContainer }");
  });
});
