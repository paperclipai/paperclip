import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Goal: prove #11602 with the same Windows spawn math Paperclip uses.
 *
 * Pass marks (all must be true):
 * 1. Legacy argv (system prompt + user prompt inline) exceeds cmd.exe 8191 after quoting.
 * 2. Fixed argv (file path + stdin) stays under 8191 after quoting.
 * 3. The 12k instructions body never appears on the fixed argv.
 * 4. stdin carries the user prompt.
 * 5. On Windows, cmd.exe rejects the legacy line and accepts a short fixed line.
 */

const WINDOWS_CMD_LINE_LIMIT = 8191;
const REALISTIC_PI_CMD = path.join(
  process.env.APPDATA ?? "C:\\Users\\fixture\\AppData\\Roaming",
  "npm",
  "pi.cmd",
);

// Must match `quoteForCmd` in packages/adapter-utils/src/server-utils.ts.
function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

function buildWindowsCmdLine(executable: string, args: string[]): string {
  return [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
}

function replaceAppendSystemPrompt(args: string[], replacement: string): string[] {
  const next = [...args];
  const index = next.indexOf("--append-system-prompt");
  if (index >= 0 && index + 1 < next.length) next[index + 1] = replacement;
  return next;
}

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

describe("pi_local Windows cmdline marking bench", () => {
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

  it("scores legacy overflow vs fixed stdin/file transport against the cmd.exe limit", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-cmdline-bench-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const hugeInstructions = `Use the isolated workspace.\n${"A".repeat(12_000)}`;
    const instructionsPath = path.join(workspaceDir, "AGENTS.md");
    await writeFile(instructionsPath, hugeInstructions, "utf8");

    let stagedPrompt = "";
    const result = await execute({
      runId: "run-cmdline-bench",
      agent: {
        id: "agent-cmdline-bench",
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
        const args = Array.isArray(meta.commandArgs) ? meta.commandArgs.map(String) : [];
        const promptFlag = args.indexOf("--append-system-prompt");
        const promptArg = promptFlag >= 0 ? args[promptFlag + 1] : "";
        if (promptArg) stagedPrompt = await readFile(promptArg, "utf8");
      },
    });

    if (typeof result.sessionId === "string" && result.sessionId.length > 0) {
      cleanupFiles.push(result.sessionId);
    }

    const call = runChildProcess.mock.calls[0] as unknown as SpawnCall | undefined;
    expect(call).toBeDefined();
    const fixedArgs = call?.[2] ?? [];
    const stdin = call?.[3].stdin ?? "";

    const legacyArgs = [...replaceAppendSystemPrompt(fixedArgs, stagedPrompt), stdin];
    const legacyCmdLine = buildWindowsCmdLine(REALISTIC_PI_CMD, legacyArgs);
    const fixedCmdLine = buildWindowsCmdLine(REALISTIC_PI_CMD, fixedArgs);

    const marks = {
      legacyExceedsLimit: legacyCmdLine.length > WINDOWS_CMD_LINE_LIMIT,
      fixedUnderLimit: fixedCmdLine.length < WINDOWS_CMD_LINE_LIMIT,
      payloadOffArgv: !fixedArgs.join("\0").includes(hugeInstructions),
      stdinCarriesUserPrompt: stdin.length > 0 && !fixedArgs.includes(stdin),
      systemPromptStagedToFile: stagedPrompt.includes(hugeInstructions),
    };

    // Visible in CI logs so reviewers can see the proof, not just a boolean.
    console.log(
      JSON.stringify(
        {
          goal: "Prove #11602: legacy inline argv overflows cmd.exe; file+stdin does not.",
          limit: WINDOWS_CMD_LINE_LIMIT,
          legacyCmdLineChars: legacyCmdLine.length,
          fixedCmdLineChars: fixedCmdLine.length,
          marginUnderLimit: WINDOWS_CMD_LINE_LIMIT - fixedCmdLine.length,
          stdinChars: stdin.length,
          stagedSystemPromptChars: stagedPrompt.length,
          marks,
        },
        null,
        2,
      ),
    );

    expect(stagedPrompt.length).toBeGreaterThan(12_000);
    expect(marks.legacyExceedsLimit).toBe(true);
    expect(marks.fixedUnderLimit).toBe(true);
    expect(marks.payloadOffArgv).toBe(true);
    expect(marks.stdinCarriesUserPrompt).toBe(true);
    expect(marks.systemPromptStagedToFile).toBe(true);
    expect(Object.values(marks).every(Boolean)).toBe(true);

    if (process.platform === "win32") {
      const cmdExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
      const legacyOs = spawnSync(cmdExe, ["/d", "/s", "/c", legacyCmdLine], {
        encoding: "utf8",
        windowsHide: true,
      });
      const fixedProbeLine = buildWindowsCmdLine(cmdExe, ["/c", "echo paperclip-cmdline-ok"]);
      const fixedOs = spawnSync(cmdExe, ["/d", "/s", "/c", "echo paperclip-cmdline-ok"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const legacyText = `${legacyOs.stderr ?? ""}${legacyOs.stdout ?? ""}${legacyOs.error?.message ?? ""}`;
      expect(legacyText.toLowerCase()).toContain("too long");
      expect(fixedOs.status).toBe(0);
      expect((fixedOs.stdout ?? "").toLowerCase()).toContain("paperclip-cmdline-ok");
      expect(fixedProbeLine.length).toBeLessThan(WINDOWS_CMD_LINE_LIMIT);
    }
  });
});
