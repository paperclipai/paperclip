import { describe, expect, it } from "vitest";

// These test the guard logic that prevents runaway or dangerous execution

describe("Guard: dangerous command detection", () => {
  const DANGEROUS_PATTERNS = [
    /\brm\s+-rf\b/,
    /\bsudo\b/,
    /\bdd\b/,
    /\bfdisk\b/,
    /\bformat\b/,
  ];

  function isDangerousCommand(command: string): boolean {
    return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
  }

  it("blocks rm -rf", () => {
    expect(isDangerousCommand("rm -rf /app")).toBe(true);
    expect(isDangerousCommand("rm -rf /")).toBe(true);
  });

  it("blocks sudo", () => {
    expect(isDangerousCommand("sudo apt-get install")).toBe(true);
    expect(isDangerousCommand("sudo rm -rf")).toBe(true);
  });

  it("blocks dd", () => {
    expect(isDangerousCommand("dd if=/dev/zero of=/dev/sda")).toBe(true);
  });

  it("blocks fdisk", () => {
    expect(isDangerousCommand("fdisk /dev/sda")).toBe(true);
  });

  it("blocks format", () => {
    expect(isDangerousCommand("format C:")).toBe(true);
  });

  it("allows safe commands", () => {
    expect(isDangerousCommand("cat /app/file.txt")).toBe(false);
    expect(isDangerousCommand("git status")).toBe(false);
    expect(isDangerousCommand("npm test")).toBe(false);
    expect(isDangerousCommand("ls -la /app")).toBe(false);
  });

  it("allows rm (without -rf)", () => {
    expect(isDangerousCommand("rm /tmp/file.txt")).toBe(false);
  });

  it("allows rdiff (contains dd but not the dangerous pattern)", () => {
    expect(isDangerousCommand("rdiff-backup")).toBe(false);
  });
});

describe("Guard: token accumulation", () => {
  const MAX_TOTAL_TOKENS = 100_000;

  function checkTokenLimit(inputTokens: number, outputTokens: number): boolean {
    return inputTokens + outputTokens >= MAX_TOTAL_TOKENS;
  }

  it("allows under limit", () => {
    expect(checkTokenLimit(50_000, 40_000)).toBe(false);
  });

  it("stops at limit", () => {
    expect(checkTokenLimit(50_000, 50_000)).toBe(true);
  });

  it("stops over limit", () => {
    expect(checkTokenLimit(60_000, 50_000)).toBe(true);
  });

  it("stops at exact limit", () => {
    expect(checkTokenLimit(100_000, 0)).toBe(true);
  });
});

describe("Guard: tool call count capping", () => {
  const MAX_TOOLS_PER_TURN = 5;

  it("allows under limit", () => {
    const toolCalls = Array(3).fill({ id: "1", type: "function", function: { name: "bash", arguments: "" } });
    const safeCalls = toolCalls.slice(0, MAX_TOOLS_PER_TURN);
    expect(safeCalls).toHaveLength(3);
  });

  it("caps at limit", () => {
    const toolCalls = Array(10).fill({ id: "1", type: "function", function: { name: "bash", arguments: "" } });
    const safeCalls = toolCalls.slice(0, MAX_TOOLS_PER_TURN);
    expect(safeCalls).toHaveLength(MAX_TOOLS_PER_TURN);
  });
});

describe("Guard: message history size", () => {
  const MAX_MESSAGE_HISTORY = 1000;

  it("tracks message array growth", () => {
    const messages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 500; i++) {
      messages.push({ role: "user", content: `Turn ${i}` });
      messages.push({ role: "assistant", content: `Response ${i}` });
    }
    expect(messages.length).toBe(1000);
    expect(messages.length >= MAX_MESSAGE_HISTORY).toBe(true);
  });
});

describe("Guard: response validation", () => {
  it("validates choices array exists", () => {
    const validResponse = {
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    expect(Array.isArray(validResponse.choices) && validResponse.choices.length > 0).toBe(true);
  });

  it("rejects empty choices", () => {
    const invalidResponse = {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    expect(Array.isArray(invalidResponse.choices) && invalidResponse.choices.length > 0).toBe(false);
  });

  it("rejects missing choices", () => {
    const invalidResponse = {
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    expect(Array.isArray((invalidResponse as any).choices) && (invalidResponse as any).choices?.length > 0).toBe(false);
  });
});
