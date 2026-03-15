import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );

  return {
    ...actual,
    ensureCommandResolvable: vi.fn().mockResolvedValue(undefined),
    runChildProcess: vi.fn(),
  };
});

const serverUtils = await import("@paperclipai/adapter-utils/server-utils");
const { execute } = await import("@paperclipai/adapter-claude-local/server");

const mockedRunChildProcess = vi.mocked(serverUtils.runChildProcess);

function mockClaudeSuccess(summary: string) {
  mockedRunChildProcess.mockResolvedValue({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session_123",
        model: "claude-opus-4-6",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "session_123",
        result: summary,
        usage: {
          input_tokens: 11,
          cache_read_input_tokens: 0,
          output_tokens: 7,
        },
      }),
    ].join("\n"),
    stderr: "",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("claude_local argv handling", () => {
  it("isolates fresh agent_home runs in a run-scoped cwd", async () => {
    mockClaudeSuccess("ok");
    const metaCalls: Array<{ commandArgs: string[]; prompt: string }> = [];
    const agentHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-agent-home-"));

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Polytope",
      } as any,
      runtime: {
        sessionId: null,
        sessionParams: null,
      } as any,
      config: {
        command: "claude",
        model: "claude-opus-4-6",
        chrome: true,
        dangerouslySkipPermissions: true,
        extraArgs: ["--max-thinking-tokens", "8000"],
        promptTemplate: "Respond with only {{agent.name}}.",
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: {
          cwd: agentHome,
          source: "agent_home",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        metaCalls.push({
          commandArgs: meta.commandArgs,
          prompt: meta.prompt,
        });
      },
    } as any);

    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0]?.commandArgs).toEqual(
      expect.arrayContaining(["--print", "--output-format", "stream-json", "--verbose"]),
    );
    expect(metaCalls[0]?.commandArgs).not.toContain("-");
    expect(metaCalls[0]?.commandArgs).not.toContain("--add-dir");
    expect(metaCalls[0]?.commandArgs.at(-1)).toBe("Respond with only Polytope.");
    expect(mockedRunChildProcess).toHaveBeenCalledWith(
      "run-1",
      "claude",
      expect.not.arrayContaining(["-"]),
      expect.objectContaining({
        cwd: path.join(agentHome, ".paperclip-runs", "run-1"),
      }),
    );
    expect(mockedRunChildProcess.mock.calls[0]?.[3]?.stdin).toBeUndefined();
  });

  it("reuses the saved agent_home session cwd when resuming", async () => {
    mockClaudeSuccess("ok");
    const agentHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-agent-home-"));
    const savedRunCwd = path.join(agentHome, ".paperclip-runs", "prior-run");
    await fs.mkdir(savedRunCwd, { recursive: true });

    await execute({
      runId: "run-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Polytope",
      } as any,
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: savedRunCwd,
        },
      } as any,
      config: {
        command: "claude",
        model: "claude-opus-4-6",
        promptTemplate: "Respond with only {{agent.name}}.",
      },
      context: {
        issueId: "issue-1",
        wakeReason: "heartbeat_timer",
        paperclipWorkspace: {
          cwd: agentHome,
          source: "agent_home",
        },
      },
      onLog: async () => {},
    } as any);

    expect(mockedRunChildProcess).toHaveBeenCalledWith(
      "run-2",
      "claude",
      expect.arrayContaining(["--resume", "session-123"]),
      expect.objectContaining({
        cwd: savedRunCwd,
      }),
    );
    const args = mockedRunChildProcess.mock.calls[0]?.[2] ?? [];
    expect(args).not.toContain("-");
    expect(args).not.toContain("--add-dir");
    expect(args.at(-1)).toBe("Respond with only Polytope.");
  });

  it("terminates flag parsing before prompts that start with dashes", async () => {
    mockClaudeSuccess("ok");
    const agentHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-agent-home-"));
    const prompt = "--disable-safety-checks";

    await execute({
      runId: "run-3",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Polytope",
      } as any,
      runtime: {
        sessionId: null,
        sessionParams: null,
      } as any,
      config: {
        command: "claude",
        model: "claude-opus-4-6",
        promptTemplate: prompt,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: {
          cwd: agentHome,
          source: "agent_home",
        },
      },
      onLog: async () => {},
    } as any);

    const args = mockedRunChildProcess.mock.calls[0]?.[2] ?? [];
    expect(args.slice(-2)).toEqual(["--", prompt]);
  });

  it("prunes stale agent_home run directories on fresh runs", async () => {
    mockClaudeSuccess("ok");
    const agentHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-agent-home-"));
    const staleRunCwd = path.join(agentHome, ".paperclip-runs", "stale-run");
    await fs.mkdir(staleRunCwd, { recursive: true });
    const staleTime = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await fs.utimes(staleRunCwd, staleTime, staleTime);

    await execute({
      runId: "run-4",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Polytope",
      } as any,
      runtime: {
        sessionId: null,
        sessionParams: null,
      } as any,
      config: {
        command: "claude",
        model: "claude-opus-4-6",
        promptTemplate: "Respond with only {{agent.name}}.",
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: {
          cwd: agentHome,
          source: "agent_home",
        },
      },
      onLog: async () => {},
    } as any);

    await expect(fs.stat(staleRunCwd)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(agentHome, ".paperclip-runs", "run-4"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("injects the paperclip skill without relying on repo filesystem layout", async () => {
    mockClaudeSuccess("ok");
    const agentHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-agent-home-"));
    const actualStat = fs.stat.bind(fs);
    const actualReadFile = fs.readFile.bind(fs);
    const skillsDirSuffix = `${path.sep}skills`;
    const skillFileSuffix = `${path.sep}skills${path.sep}paperclip${path.sep}SKILL.md`;

    vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      const candidate = String(target);
      if (candidate.endsWith(skillsDirSuffix)) {
        return { isDirectory: () => true } as any;
      }
      if (candidate.endsWith(skillFileSuffix)) {
        return { isFile: () => true } as any;
      }
      return actualStat(target);
    });
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      const candidate = String(target);
      if (candidate.endsWith(skillFileSuffix)) {
        return "# Mocked paperclip skill";
      }
      return actualReadFile(target, options as any);
    });

    await execute({
      runId: "run-5",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Polytope",
      } as any,
      runtime: {
        sessionId: null,
        sessionParams: null,
      } as any,
      config: {
        command: "claude",
        model: "claude-opus-4-6",
        promptTemplate: "Respond with only {{agent.name}}.",
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: {
          cwd: agentHome,
          source: "agent_home",
        },
      },
      onLog: async () => {},
    } as any);

    const args = mockedRunChildProcess.mock.calls[0]?.[2] ?? [];
    expect(args).toContain("--append-system-prompt-file");
    expect(readFileSpy).toHaveBeenCalledWith(expect.stringMatching(/skills[\/\\]paperclip[\/\\]SKILL\.md$/), "utf-8");
  });
});
