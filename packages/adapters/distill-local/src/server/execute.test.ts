import { describe, expect, it } from "vitest";
import { buildDistillArgs } from "./execute.js";

const base = {
  cwd: "/w",
  resumeSessionId: null,
  model: "",
  reasoningEffort: "",
  mode: "",
  maxTurns: 0,
  permissionMode: "",
  alwaysApprove: true,
  disableWebSearch: false,
  extraArgs: [],
  prompt: "do it",
};

describe("buildDistillArgs", () => {
  it("sends --model auto when no model is set so account routing is used instead of Distill's own default", () => {
    const args = buildDistillArgs(base);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "auto"]);
  });

  it("keeps the prompt last, right after --single, even with extra args", () => {
    const args = buildDistillArgs({ ...base, extraArgs: ["--no-subagents"] });
    expect(args.slice(-2)).toEqual(["--single", "do it"]);
  });

  it("maps every optional setting to its Distill CLI flag", () => {
    const joined = buildDistillArgs({
      ...base,
      resumeSessionId: "s1",
      model: "chatgpt/gpt-6.1-sol",
      reasoningEffort: "high",
      mode: "ultracode",
      maxTurns: 7,
      permissionMode: "acceptEdits",
      disableWebSearch: true,
    }).join(" ");
    for (const part of [
      "--resume s1",
      "--model chatgpt/gpt-6.1-sol",
      "--reasoning-effort high",
      "--mode ultracode",
      "--max-turns 7",
      "--permission-mode acceptEdits",
      "--always-approve",
      "--disable-web-search",
      "--output-format streaming-json",
    ]) {
      expect(joined).toContain(part);
    }
  });
});
