import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const { root, runProcess } = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return {
    root: await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-windows-test-")),
    runProcess: vi.fn<typeof import("@paperclipai/adapter-utils/execution-target").runAdapterExecutionTargetProcess>(),
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, default: { ...actual, homedir: () => root } };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, readPaperclipRuntimeSkillEntries: async () => [] };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: async () => {},
    resolveAdapterExecutionTargetCommandForLogs: async () => "pi.cmd",
    runAdapterExecutionTargetProcess: runProcess,
  };
});

vi.mock("./models.js", () => ({
  ensurePiModelConfiguredAndAvailable: async () => [],
}));

import { execute } from "./execute.js";

function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-windows",
    agent: {
      id: "agent-windows",
      companyId: "company-1",
      name: "Pi Agent",
      adapterType: "pi_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      cwd: root,
      command: "pi",
      model: "openai/gpt-5.4-mini",
      promptTemplate: 'Instructions with "quotes", %PATH%, & and newlines.\n'.repeat(1000),
      bootstrapPromptTemplate: 'Task with "quotes", %PATH%, & and newlines.\n'.repeat(1000),
      extraArgs: ["--no-extensions"],
    },
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

const success = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: JSON.stringify({
    type: "turn_end",
    message: { role: "assistant", content: "done" },
    toolResults: [],
  }),
  stderr: "",
  pid: 123,
  startedAt: "2026-10-05T10:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
  runProcess.mockReset();
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Pi Windows prompt transport", () => {
  it.each(["success", "failure", "timeout", "spawn error"] as const)(
    "keeps large prompts out of argv and cleans up after %s",
    async (outcome) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const ctx = context();
      const onMeta = vi.fn<NonNullable<AdapterExecutionContext["onMeta"]>>();
      ctx.onMeta = onMeta;
      let systemPromptPath = "";
      runProcess.mockImplementation(async (_runId, _target, _command, args, options) => {
        systemPromptPath = args[args.indexOf("--append-system-prompt") + 1];
        expect(args.join(" ").length).toBeLessThan(8191);
        expect(await fs.readFile(systemPromptPath, "utf8")).toBe(ctx.config.promptTemplate);
        expect(options.stdin).toBe(onMeta.mock.calls[0][0].prompt);
        expect(options.stdin).toContain(ctx.config.bootstrapPromptTemplate);
        expect(options.stdin!.length).toBeGreaterThan(32767);
        expect(args).toContain("--no-extensions");
        expect(args).toContain("--session");
        expect(args).not.toContain(options.stdin);
        if (outcome === "spawn error") throw new Error("spawn failed");
        return {
          ...success,
          exitCode: outcome === "failure" ? 1 : 0,
          timedOut: outcome === "timeout",
        };
      });

      if (outcome === "spawn error") {
        await expect(execute(ctx)).rejects.toThrow("spawn failed");
      } else {
        const result = await execute(ctx);
        expect(result.timedOut).toBe(outcome === "timeout");
      }
      expect(runProcess).toHaveBeenCalledOnce();
      await expect(fs.stat(path.dirname(systemPromptPath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves the existing argument transport on non-Windows hosts", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const ctx = context();
    const onMeta = vi.fn<NonNullable<AdapterExecutionContext["onMeta"]>>();
    ctx.onMeta = onMeta;
    runProcess.mockResolvedValue(success);

    await execute(ctx);

    const [, , , args, options] = runProcess.mock.calls[0];
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(ctx.config.promptTemplate);
    expect(args.at(-1)).toBe(onMeta.mock.calls[0][0].prompt);
    expect(options.stdin).toBeUndefined();
  });

  it("keeps the system prompt file available for a fresh-session retry", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const sessionPath = path.join(root, "stale-session.jsonl");
    await fs.writeFile(sessionPath, JSON.stringify({ type: "session", cwd: root }));
    const ctx = context({
      runtime: { sessionId: sessionPath, sessionParams: { cwd: root }, sessionDisplayId: null, taskKey: null },
    });
    const systemPromptPaths: string[] = [];
    runProcess.mockImplementation(async (_runId, _target, _command, args, options) => {
      const systemPromptPath = args[args.indexOf("--append-system-prompt") + 1];
      systemPromptPaths.push(systemPromptPath);
      expect(await fs.readFile(systemPromptPath, "utf8")).toBe(ctx.config.promptTemplate);
      expect(options.stdin!.length).toBeGreaterThan(32767);
      return systemPromptPaths.length === 1
        ? { ...success, exitCode: 1, stderr: "Unknown session" }
        : success;
    });

    const result = await execute(ctx);

    expect(runProcess).toHaveBeenCalledTimes(2);
    expect(result.clearSession).toBe(true);
    expect(systemPromptPaths[1]).toBe(systemPromptPaths[0]);
    await expect(fs.stat(path.dirname(systemPromptPaths[0]))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up the prompt file when invocation metadata fails before spawn", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    let systemPromptPath = "";
    const ctx = context({
      onMeta: async (meta) => {
        if (!meta.commandArgs) throw new Error("Missing invocation arguments");
        systemPromptPath = meta.commandArgs[meta.commandArgs.indexOf("--append-system-prompt") + 1];
        throw new Error("metadata failed");
      },
    });

    await expect(execute(ctx)).rejects.toThrow("metadata failed");

    expect(runProcess).not.toHaveBeenCalled();
    await expect(fs.stat(path.dirname(systemPromptPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves rendered instructions-file content and its path directive", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const instructionsPath = path.join(root, "instructions.md");
    const instructions = 'Instructions for {{agent.name}}: \u4f60\u597d "quoted" & %PATH%.\n'.repeat(1000);
    await fs.writeFile(instructionsPath, instructions);
    const ctx = context();
    ctx.config.instructionsFilePath = instructionsPath;
    let systemPromptPath = "";
    runProcess.mockImplementation(async (_runId, _target, _command, args) => {
      systemPromptPath = args[args.indexOf("--append-system-prompt") + 1];
      const systemPrompt = await fs.readFile(systemPromptPath, "utf8");
      expect(systemPrompt).toContain(instructions.replaceAll("{{agent.name}}", ctx.agent.name));
      expect(systemPrompt).toContain(`The above agent instructions were loaded from ${instructionsPath}.`);
      expect(systemPrompt.length).toBeGreaterThan(32767);
      expect(args.join(" ").length).toBeLessThan(8191);
      return success;
    });

    await execute(ctx);

    await expect(fs.stat(path.dirname(systemPromptPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")("delivers large prompts through a real Windows cmd wrapper", async () => {
    const commandPath = path.join(root, "fake-pi.cmd");
    const scriptPath = path.join(root, "fake-pi.cjs");
    const dumpPath = path.join(root, "prompt-dump.json");
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    await fs.writeFile(scriptPath, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const systemPromptPath = args[args.indexOf("--append-system-prompt") + 1];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({
    args, prompt, systemPromptPath, systemPrompt: fs.readFileSync(systemPromptPath, "utf8"),
  }));
  console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "done" }, toolResults: [] }));
});
`);
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
      "@paperclipai/adapter-utils/execution-target",
    );
    runProcess.mockImplementation(actual.runAdapterExecutionTargetProcess);
    const ctx = context();
    ctx.config.command = commandPath;
    const onMeta = vi.fn<NonNullable<AdapterExecutionContext["onMeta"]>>();
    ctx.onMeta = onMeta;

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const dump = JSON.parse(await fs.readFile(dumpPath, "utf8"));
    expect(dump.prompt).toBe(onMeta.mock.calls[0][0].prompt);
    expect(dump.systemPrompt).toBe(ctx.config.promptTemplate);
    expect(dump.args.join(" ").length).toBeLessThan(8191);
    await expect(fs.stat(path.dirname(dump.systemPromptPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
