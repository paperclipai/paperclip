import { describe, expect, it } from "vitest";
import { buildClaudeArgs, type BuildClaudeArgsOptions } from "./execute.js";

const baseOpts: BuildClaudeArgsOptions = {
  resumeSessionId: null,
  attemptInstructionsFilePath: undefined,
  dangerouslySkipPermissions: true,
  chrome: false,
  model: "claude-opus-4-6",
  env: {},
  effort: "",
  maxTurns: 0,
  extraArgs: [],
  addDir: "/tmp/prompt-bundle",
};

describe("buildClaudeArgs", () => {
  it("produces a stable prefix across calls with identical config", () => {
    const a = buildClaudeArgs(baseOpts);
    const b = buildClaudeArgs(baseOpts);
    expect(a).toEqual(b);
  });

  it("includes --exclude-dynamic-system-prompt-sections on fresh sessions", () => {
    const args = buildClaudeArgs(baseOpts);
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
  });

  it("omits --exclude-dynamic-system-prompt-sections on resumed sessions", () => {
    const args = buildClaudeArgs({ ...baseOpts, resumeSessionId: "sess-123" });
    expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
  });

  it("includes --resume on resumed sessions", () => {
    const args = buildClaudeArgs({ ...baseOpts, resumeSessionId: "sess-123" });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-123");
  });

  it("includes --model for standard Anthropic IDs", () => {
    const args = buildClaudeArgs(baseOpts);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-6");
  });

  it("skips --model for Anthropic IDs on Bedrock auth", () => {
    const args = buildClaudeArgs({
      ...baseOpts,
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    });
    expect(args).not.toContain("--model");
  });

  it("includes --model for Bedrock-native IDs on Bedrock auth", () => {
    const args = buildClaudeArgs({
      ...baseOpts,
      model: "us.anthropic.claude-opus-4-6-v1",
      env: { CLAUDE_CODE_USE_BEDROCK: "1" },
    });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("us.anthropic.claude-opus-4-6-v1");
  });

  it("includes --append-system-prompt-file only on fresh sessions", () => {
    const args = buildClaudeArgs({
      ...baseOpts,
      attemptInstructionsFilePath: "/path/to/AGENTS.md",
    });
    expect(args).toContain("--append-system-prompt-file");
  });

  it("omits --append-system-prompt-file on resumed sessions", () => {
    const args = buildClaudeArgs({
      ...baseOpts,
      resumeSessionId: "sess-123",
      attemptInstructionsFilePath: "/path/to/AGENTS.md",
    });
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("includes --effort when set", () => {
    const args = buildClaudeArgs({ ...baseOpts, effort: "high" });
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("includes --max-turns when positive", () => {
    const args = buildClaudeArgs({ ...baseOpts, maxTurns: 5 });
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("5");
  });

  it("appends extraArgs at the end", () => {
    const args = buildClaudeArgs({ ...baseOpts, extraArgs: ["--foo", "bar"] });
    expect(args.slice(-2)).toEqual(["--foo", "bar"]);
  });

  it("prefix is stable when only runtime-varying options change", () => {
    const fresh = buildClaudeArgs(baseOpts);
    const resumed = buildClaudeArgs({ ...baseOpts, resumeSessionId: "sess-123" });
    // The shared leading args (--print, -, --output-format, stream-json, --verbose)
    // are identical regardless of session state
    const sharedPrefix = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    expect(fresh.slice(0, sharedPrefix.length)).toEqual(sharedPrefix);
    expect(resumed.slice(0, sharedPrefix.length)).toEqual(sharedPrefix);
  });
});
