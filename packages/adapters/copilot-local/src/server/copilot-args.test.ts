import { describe, expect, it } from "vitest";
import { DEFAULT_COPILOT_LOCAL_ALLOW_TOOLS } from "../index.js";
import { buildCopilotArgs } from "./copilot-args.js";

describe("copilot args", () => {
  it("uses programmatic prompt mode with JSONL output and no ask_user", () => {
    const result = buildCopilotArgs({}, "Do work");

    expect(result.args).toContain("-p");
    expect(result.args).toContain("Do work");
    expect(result.args).toContain("--output-format=json");
    expect(result.args).toContain("--no-ask-user");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("gpt-5.3-codex");
  });

  it("defaults to explicit allowlists without broad allow-all flags", () => {
    const result = buildCopilotArgs({}, "Do work");

    expect(result.allowTools).toEqual([...DEFAULT_COPILOT_LOCAL_ALLOW_TOOLS]);
    expect(result.args).toContain(`--allow-tool=${DEFAULT_COPILOT_LOCAL_ALLOW_TOOLS.join(",")}`);
    expect(result.hasBroadAllowAll).toBe(false);
    expect(result.args).not.toContain("--allow-all");
    expect(result.args).not.toContain("--yolo");
  });

  it("allows config to override command args, model, cwd-neutral allow tools, and urls", () => {
    const result = buildCopilotArgs({
      model: "claude-sonnet-4.6",
      allowTools: ["shell(git status)", "read"],
      allowUrls: ["https://docs.github.com/copilot/*"],
      extraArgs: ["--stream=off"],
    }, "Do work");

    expect(result.model).toBe("claude-sonnet-4.6");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("claude-sonnet-4.6");
    expect(result.args).toContain("--allow-tool=shell(git status),read");
    expect(result.args).toContain("--allow-url=https://docs.github.com/copilot/*");
    expect(result.args).toContain("--stream=off");
  });
});
