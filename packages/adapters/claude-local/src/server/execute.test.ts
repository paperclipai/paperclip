import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session-1", model: "claude-opus-4-8" }),
      JSON.stringify({
        type: "result",
        session_id: "session-1",
        result: "ok",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
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

import { execute } from "./execute.js";
import { resolveClaudeFallbackModel, DEFAULT_CLAUDE_FALLBACK_MODEL } from "./execute.js";

const cleanupDirs: string[] = [];

async function runLocalExecute(config: Record<string, unknown>): Promise<string[]> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-fallback-"));
  cleanupDirs.push(rootDir);
  const workspaceDir = path.join(rootDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  await execute({
    runId: "run-fallback",
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
    config: { command: "claude", cwd: workspaceDir, ...config },
    context: {
      paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
    },
    onLog: async () => {},
  });

  expect(runChildProcess).toHaveBeenCalledTimes(1);
  const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
  return call?.[2] ?? [];
}

describe("resolveClaudeFallbackModel", () => {
  it("honors an explicit fallback model", () => {
    expect(resolveClaudeFallbackModel("claude-haiku-4-6", "claude-opus-4-8")).toBe("claude-haiku-4-6");
  });

  it("disables the fallback for none/off-style values", () => {
    for (const value of ["none", "off", "false", "disabled", "0", "NONE"]) {
      expect(resolveClaudeFallbackModel(value, "claude-opus-4-8")).toBe("");
    }
  });

  it("drops a fallback identical to the primary model", () => {
    expect(resolveClaudeFallbackModel("claude-opus-4-8", "claude-opus-4-8")).toBe("");
  });

  it("defaults to a lower-load model when a primary model is pinned", () => {
    expect(resolveClaudeFallbackModel("", "claude-opus-4-8")).toBe(DEFAULT_CLAUDE_FALLBACK_MODEL);
  });

  it("does not default when the primary already is the default fallback", () => {
    expect(resolveClaudeFallbackModel("", DEFAULT_CLAUDE_FALLBACK_MODEL)).toBe("");
  });

  it("does not default when no primary model is pinned", () => {
    expect(resolveClaudeFallbackModel("", "")).toBe("");
  });
});

describe("claude execution --fallback-model wiring", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("passes an explicitly configured --fallback-model", async () => {
    const args = await runLocalExecute({ model: "claude-opus-4-8", fallbackModel: "claude-haiku-4-6" });
    const idx = args.indexOf("--fallback-model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-haiku-4-6");
  });

  it("defaults --fallback-model when a primary model is set but no fallback is configured", async () => {
    const args = await runLocalExecute({ model: "claude-opus-4-8" });
    const idx = args.indexOf("--fallback-model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(DEFAULT_CLAUDE_FALLBACK_MODEL);
  });

  it("omits --fallback-model when explicitly disabled with none", async () => {
    const args = await runLocalExecute({ model: "claude-opus-4-8", fallbackModel: "none" });
    expect(args).not.toContain("--fallback-model");
  });

  it("omits --fallback-model when no primary model is pinned", async () => {
    const args = await runLocalExecute({});
    expect(args).not.toContain("--fallback-model");
  });
});
