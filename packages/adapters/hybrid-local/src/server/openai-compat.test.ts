import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveBaseUrl, executeLocalModel, isDangerousCommand, terminateCommandProcess } from "./openai-compat.js";


describe("resolveBaseUrl", () => {
  it("returns the default URL when config is undefined", () => {
    expect(resolveBaseUrl(undefined)).toBe("http://127.0.0.1:11434/v1");
  });

  it("returns the default URL when config is empty string", () => {
    expect(resolveBaseUrl("")).toBe("http://127.0.0.1:11434/v1");
  });

  it("returns the default URL when config is whitespace", () => {
    expect(resolveBaseUrl("   ")).toBe("http://127.0.0.1:11434/v1");
  });

  it("returns the default URL when config is null", () => {
    expect(resolveBaseUrl(null)).toBe("http://127.0.0.1:11434/v1");
  });

  it("returns the default URL when config is a number", () => {
    expect(resolveBaseUrl(42)).toBe("http://127.0.0.1:11434/v1");
  });

  it("uses the configured URL when provided", () => {
    expect(resolveBaseUrl("http://192.168.1.100:1234/v1")).toBe("http://192.168.1.100:1234/v1");
  });

  it("trims whitespace from configured URL", () => {
    expect(resolveBaseUrl("  http://localhost:1234/v1  ")).toBe("http://localhost:1234/v1");
  });

  it("strips trailing slashes from configured URL", () => {
    expect(resolveBaseUrl("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
  });

  it("strips multiple trailing slashes", () => {
    expect(resolveBaseUrl("http://localhost:1234/v1///")).toBe("http://localhost:1234/v1");
  });
});

describe("executeLocalModel — systemPrompt injection", () => {
  const noopLog = vi.fn().mockResolvedValue(undefined);
  const baseOpts = {
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5-coder:7b",
    prompt: "Fix the bug",
    cwd: "/repo",
    enableTools: false,
    timeoutMs: 5_000,
    onLog: noopLog,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends only user message when no systemPrompt provided", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "qwen2.5-coder:7b",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });

    await executeLocalModel(baseOpts);

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("prepends system message when systemPrompt is provided", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "qwen2.5-coder:7b",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }),
    });

    await executeLocalModel({ ...baseOpts, systemPrompt: "You are a PlotSpark engineer." });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("You are a PlotSpark engineer.");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("Fix the bug");
  });

  it("system message appears before user message in tool-use mode", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "qwen2.5-coder:7b",
        choices: [{ message: { role: "assistant", content: "done", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }),
    });

    await executeLocalModel({ ...baseOpts, systemPrompt: "Arch context here.", enableTools: true });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });
});

describe("tool output truncation — constant validation", () => {
  it("MAX_TOOL_OUTPUT_CHARS produces a truncated string with notice when applied", () => {
    const MAX_TOOL_OUTPUT_CHARS = 8_000;
    const largeOutput = "x".repeat(20_000);

    const truncated = largeOutput.length > MAX_TOOL_OUTPUT_CHARS
      ? largeOutput.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n[output truncated: ${largeOutput.length} chars total]`
      : largeOutput;

    expect(truncated.length).toBeLessThan(largeOutput.length);
    expect(truncated).toContain("[output truncated:");
    expect(truncated).toContain("20000 chars total");
  });

  it("short output is not truncated", () => {
    const MAX_TOOL_OUTPUT_CHARS = 8_000;
    const shortOutput = "file1.txt\nfile2.txt\n";

    const result = shortOutput.length > MAX_TOOL_OUTPUT_CHARS
      ? shortOutput.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n[output truncated: ${shortOutput.length} chars total]`
      : shortOutput;

    expect(result).toBe(shortOutput);
    expect(result).not.toContain("[output truncated:");
  });
});

describe("executeLocalModel — bash tool execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an ERROR tool result when bash exits non-zero", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "qwen2.5-coder:7b",
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  type: "function" as const,
                  function: { name: "bash", arguments: JSON.stringify({ command: "echo boom >&2; exit 7" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "qwen2.5-coder:7b",
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

    await executeLocalModel({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5-coder:7b",
      prompt: "Run a failing command",
      cwd: "/tmp",
      enableTools: true,
      timeoutMs: 15_000,
      onLog: vi.fn().mockResolvedValue(undefined),
    });

    const secondRequestBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string,
    ) as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };

    const toolMessage = secondRequestBody.messages.find((m) => m.role === "tool" && m.tool_call_id === "tool-1");
    expect(String(toolMessage?.content ?? "")).toContain("ERROR:");
    expect(String(toolMessage?.content ?? "")).toContain("boom");
  });

  it("caps captured bash output before tool-result truncation", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "qwen2.5-coder:7b",
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  type: "function" as const,
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: "python3 - <<'PY'\nprint('x' * 1100000)\nPY",
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "qwen2.5-coder:7b",
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

    await executeLocalModel({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5-coder:7b",
      prompt: "Run a noisy command",
      cwd: "/tmp",
      enableTools: true,
      timeoutMs: 15_000,
      onLog: vi.fn().mockResolvedValue(undefined),
    });

    const secondRequestBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string,
    ) as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };

    const toolMessage = secondRequestBody.messages.find((m) => m.role === "tool" && m.tool_call_id === "tool-1");
    expect(String(toolMessage?.content ?? "")).toContain("[output truncated:");
    expect(String(toolMessage?.content ?? "").length).toBeLessThan(9000);
  });
});

describe("dangerous command guards", () => {
  it("does not block common --format usage", () => {
    expect(isDangerousCommand("git log --format=\"%H %s\"")).toBe(false);
    expect(isDangerousCommand("git diff --format=stat")).toBe(false);
  });

  it("still blocks Windows drive format command", () => {
    expect(isDangerousCommand("format C:")).toBe(true);
  });
});

describe("terminateCommandProcess", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("signals both the direct process and its process group on unix platforms", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    terminateCommandProcess(4321, "SIGTERM");

    expect(killSpy).toHaveBeenCalledWith(4321, "SIGTERM");
    if (process.platform === "win32") {
      expect(killSpy).toHaveBeenCalledTimes(1);
    } else {
      expect(killSpy).toHaveBeenCalledWith(-4321, "SIGTERM");
    }
  });

  it("ignores missing processes when tearing down descendants", () => {
    const err = Object.assign(new Error("gone"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });

    expect(() => terminateCommandProcess(4321, "SIGKILL")).not.toThrow();
    expect(killSpy).toHaveBeenCalled();
  });
});

describe("tool-call truncation integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps assistant/tool history consistent when tool calls exceed per-turn cap", async () => {
    const toolCalls = Array.from({ length: 6 }, (_, i) => ({
      id: `tool-${i + 1}`,
      type: "function" as const,
      function: { name: "bash", arguments: JSON.stringify({ command: "echo ok" }) },
    }));

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "qwen2.5-coder:7b",
          choices: [{ message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "qwen2.5-coder:7b",
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 15, completion_tokens: 5 },
        }),
      });

    await executeLocalModel({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5-coder:7b",
      prompt: "Run tool checks",
      cwd: "/tmp",
      enableTools: true,
      timeoutMs: 15_000,
      onLog: vi.fn().mockResolvedValue(undefined),
    });

    const secondRequestBody = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string,
    ) as {
      messages: Array<{
        role: string;
        tool_calls?: Array<{ id: string }>;
        tool_call_id?: string;
        content?: string;
      }>;
    };

    const assistantWithTools = secondRequestBody.messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(assistantWithTools?.tool_calls).toHaveLength(5);

    const toolMessages = secondRequestBody.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(6);
    expect(toolMessages.some((m) => m.tool_call_id === "tool-6" && String(m.content ?? "").includes("Tool call skipped"))).toBe(true);
  });
});
