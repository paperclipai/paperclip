import { describe, expect, it } from "vitest";
import { buildClaudeCodeExecArgs } from "./claude-code-args.js";

describe("buildClaudeCodeExecArgs", () => {
  it("builds basic exec args with print and json output", () => {
    const result = buildClaudeCodeExecArgs({});

    expect(result.args).toEqual([
      "--print",
      "--verbose",
      "--output-format=stream-json",
    ]);
    expect(result.model).toBe("");
    expect(result.effort).toBe("");
  });

  it("applies model when specified", () => {
    const result = buildClaudeCodeExecArgs({ model: "claude-opus-4-7" });

    expect(result.args).toEqual([
      "--print",
      "--verbose",
      "--output-format=stream-json",
      "--model",
      "claude-opus-4-7",
    ]);
    expect(result.model).toBe("claude-opus-4-7");
  });

  it("applies effort when specified", () => {
    const result = buildClaudeCodeExecArgs({ effort: "high" });

    expect(result.args).toEqual([
      "--print",
      "--verbose",
      "--output-format=stream-json",
      "--effort",
      "high",
    ]);
    expect(result.effort).toBe("high");
  });

  it("resumes session when resumeSessionId is provided", () => {
    const result = buildClaudeCodeExecArgs({}, { resumeSessionId: "session_abc123" });

    expect(result.args).toEqual([
      "--print",
      "--verbose",
      "--output-format=stream-json",
      "--resume",
      "session_abc123",
    ]);
  });

  it("combines model, effort, and extra args", () => {
    const result = buildClaudeCodeExecArgs({
      model: "claude-sonnet-4-6",
      effort: "medium",
      extraArgs: ["--no-input"],
    });

    expect(result.args).toEqual([
      "--print",
      "--verbose",
      "--output-format=stream-json",
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "medium",
      "--no-input",
    ]);
  });

  it("prefers extraArgs over args for backward compatibility", () => {
    const result = buildClaudeCodeExecArgs({
      extraArgs: ["--custom-flag"],
      args: ["--ignored"],
    });

    expect(result.args).toContain("--custom-flag");
    expect(result.args).not.toContain("--ignored");
  });

  it("handles empty config gracefully", () => {
    const result = buildClaudeCodeExecArgs(null);
    expect(result.args).toEqual([
      "--print",
      "--verbose",
      "--output-format=stream-json",
    ]);
  });

  it("trims whitespace from model and effort", () => {
    const result = buildClaudeCodeExecArgs({
      model: "  claude-haiku-4-6  ",
      effort: "  low  ",
    });

    expect(result.model).toBe("claude-haiku-4-6");
    expect(result.effort).toBe("low");
  });
});