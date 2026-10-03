import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const runChildProcessMock = vi.hoisted(() => vi.fn());
const skillEntriesMock = vi.hoisted(() => vi.fn());
const linkSkillMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    ensureCommandResolvable: vi.fn(async () => {}),
    resolveCommandForLogs: vi.fn(async () => "crush"),
    readPaperclipRuntimeSkillEntries: skillEntriesMock,
    ensurePaperclipSkillSymlink: linkSkillMock,
    runChildProcess: runChildProcessMock,
  };
});

import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const roots: string[] = [];

async function context(overrides: Partial<AdapterExecutionContext> = {}): Promise<AdapterExecutionContext> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-crush-test-"));
  roots.push(cwd);
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Crush Agent",
      adapterType: "crush_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd, model: "nvidia/example-model" },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  };
}

const success = (stdout: string) => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "" });

describe("crush_local execute", () => {
  beforeEach(() => {
    runChildProcessMock.mockReset();
    skillEntriesMock.mockReset().mockResolvedValue([]);
    linkSkillMock.mockReset().mockResolvedValue("linked");
  });
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("runs headlessly and saves only this agent's session", async () => {
    const ctx = await context({
      runtimeTools: {
        version: 1,
        guidance: "Use the runtime tools",
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        rest: {
          connectionsSearch: "https://paperclip.test/runtime-tools/connections/search",
          connectionRequest: "https://paperclip.test/runtime-tools/connections/request",
        },
        bearerToken: "tool-token",
        expiresAt: "2026-09-29T00:00:00.000Z",
        tools: ["connections_search", "connection_request"],
      },
    });
    runChildProcessMock
      .mockResolvedValueOnce(success("Probe completed"))
      .mockResolvedValueOnce(success(JSON.stringify({ meta: { id: "session-1" } })));

    const result = await execute(ctx);
    const [runId, command, args, options] = runChildProcessMock.mock.calls[0];
    expect(runId).toBe("run-1");
    expect(command).toBe("crush");
    expect(args.slice(0, 2)).toEqual(["run", "--quiet"]);
    expect(args).toContain("--cwd");
    expect(args).toContain("--data-dir");
    expect(args).toContain("nvidia/example-model");
    expect(options.env.PAPERCLIP_API_KEY).toBe("run-token");
    expect(options.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBe("tool-token");
    const dataDir = args[args.indexOf("--data-dir") + 1];
    expect(options.env.CRUSH_SKILLS_DIR).toBe(path.join(dataDir, "skills"));
    expect(dataDir).toContain(path.join("company-1", "agent-1"));
    expect(runChildProcessMock.mock.calls[1][2]).toEqual([
      "session", "last", "--json", "--cwd", ctx.config.cwd, "--data-dir", dataDir,
    ]);
    expect(result).toMatchObject({ exitCode: 0, sessionId: "session-1", summary: "Probe completed" });
  });

  it("keeps skills for agents in different companies in separate directories", async () => {
    const first = await context();
    const second = await context({ agent: { ...first.agent, companyId: "company-2" } });
    first.config.paperclipSkillSync = { desiredSkills: ["company-skill"] };
    second.config.paperclipSkillSync = { desiredSkills: ["company-skill"] };
    skillEntriesMock.mockResolvedValue([
      { key: "company-skill", runtimeName: "company-skill", source: "C:/source/SKILL.md" },
    ]);
    runChildProcessMock
      .mockResolvedValueOnce(success("First done"))
      .mockResolvedValueOnce(success(JSON.stringify({ meta: { id: "first-session" } })))
      .mockResolvedValueOnce(success("Second done"))
      .mockResolvedValueOnce(success(JSON.stringify({ meta: { id: "second-session" } })));

    await execute(first);
    await execute(second);
    const firstSkills = runChildProcessMock.mock.calls[0][3].env.CRUSH_SKILLS_DIR;
    const secondSkills = runChildProcessMock.mock.calls[2][3].env.CRUSH_SKILLS_DIR;
    expect(firstSkills).toContain(path.join("company-1", "agent-1"));
    expect(secondSkills).toContain(path.join("company-2", "agent-1"));
    expect(firstSkills).not.toBe(secondSkills);
    expect(linkSkillMock.mock.calls.map((call) => call[1])).toEqual([
      path.join(firstSkills, "company-skill"),
      path.join(secondSkills, "company-skill"),
    ]);
  });

  it("rejects a remote execution target before launching a local process", async () => {
    const ctx = await context({
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/workspace",
      },
    });
    await expect(execute(ctx)).rejects.toThrow("supports local execution only");
    expect(runChildProcessMock).not.toHaveBeenCalled();
  });

  it("retries without a saved session when Crush reports it missing", async () => {
    const ctx = await context({
      config: {
        cwd: "",
        model: "nvidia/example-model",
        promptTemplate: "FULL AGENT TASK",
        bootstrapPromptTemplate: "BOOTSTRAP INSTRUCTIONS",
      },
      context: {
        paperclipWake: {
          reason: "issue_commented",
          issue: { id: "issue-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      },
      runtime: {
        sessionId: "old-session",
        sessionParams: { sessionId: "old-session" },
        sessionDisplayId: "old-session",
        taskKey: null,
      },
    });
    runChildProcessMock
      .mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "session not found" })
      .mockResolvedValueOnce(success("Recovered"))
      .mockResolvedValueOnce(success(JSON.stringify({ meta: { id: "new-session" } })));

    const result = await execute(ctx);
    expect(runChildProcessMock.mock.calls[0][2]).toContain("old-session");
    expect(runChildProcessMock.mock.calls[1][2]).not.toContain("old-session");
    const resumePrompt = runChildProcessMock.mock.calls[0][2].at(-1);
    const freshPrompt = runChildProcessMock.mock.calls[1][2].at(-1);
    expect(resumePrompt).not.toContain("FULL AGENT TASK");
    expect(freshPrompt).toContain("FULL AGENT TASK");
    expect(freshPrompt).toContain("BOOTSTRAP INSTRUCTIONS");
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "new-session",
      summary: "Recovered",
      clearSession: false,
    });
  });

  it("reports a provider failure even when Crush exits with code zero", async () => {
    const ctx = await context();
    runChildProcessMock
      .mockResolvedValueOnce(success("Agent processing failed: Service temporarily overloaded."))
      .mockResolvedValueOnce(success(JSON.stringify({
        meta: { id: "failed-session" },
        messages: [{ role: "assistant", parts: [{ type: "finish", reason: "error" }] }],
      })));

    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Service temporarily overloaded");
    expect(result.sessionId).toBeNull();
    expect(result.clearSession).toBe(true);
  });

  it("reports a provider failure when Crush cannot save a session", async () => {
    const ctx = await context();
    runChildProcessMock
      .mockResolvedValueOnce(success("Agent processing failed: provider unavailable"))
      .mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "session not found" });

    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, clearSession: true });
  });
});

describe("crush_local environment probe", () => {
  beforeEach(() => runChildProcessMock.mockReset());
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("uses the same model, data directory, and extra arguments as a normal run", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-crush-probe-"));
    roots.push(cwd);
    runChildProcessMock.mockResolvedValueOnce(success("hello"));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "crush_local",
      config: {
        cwd,
        model: "nvidia/example-model",
        extraArgs: ["--debug"],
      },
    });

    const args = runChildProcessMock.mock.calls[0][2] as string[];
    const env = runChildProcessMock.mock.calls[0][3].env as Record<string, string>;
    expect(result.status).toBe("pass");
    expect(args).toContain("--data-dir");
    expect(args).toContain("--debug");
    expect(args).toContain("nvidia/example-model");
    expect(env.CRUSH_SKILLS_DIR).toBe(path.join(args[args.indexOf("--data-dir") + 1], "skills"));
  });
});
