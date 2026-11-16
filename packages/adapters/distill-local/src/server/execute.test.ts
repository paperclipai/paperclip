import { describe, expect, it } from "vitest";
import { buildDistillArgs, buildDistillConfigOverlay } from "./execute.js";

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

describe("buildDistillConfigOverlay", () => {
  const empty = { workerModel: "", workerEffort: "", mainVariant: "", workerVariant: "" };

  it("returns null when nothing is set so the host config.toml applies unchanged", () => {
    expect(buildDistillConfigOverlay(empty)).toBeNull();
  });

  it("maps worker and variant settings to Distill [models] keys", () => {
    expect(
      JSON.parse(
        buildDistillConfigOverlay({
          workerModel: "deepseek-v4.1-flash-eco",
          workerEffort: "low",
          mainVariant: "nitro",
          workerVariant: "floor",
        })!,
      ),
    ).toEqual({
      models: { worker: "deepseek-v4.1-flash-eco", worker_effort: "low", main_variant: "nitro", worker_variant: "floor" },
    });
  });

  it("disables the worker with an empty string, which Distill reads as main model does all the work", () => {
    expect(JSON.parse(buildDistillConfigOverlay({ ...empty, workerModel: "none" })!).models.worker).toBe("");
  });

  it("merges into an existing GROK_CONFIG instead of dropping its other keys", () => {
    const existing = JSON.stringify({ features: { web_fetch: true }, models: { default_reasoning_effort: "high" } });
    expect(JSON.parse(buildDistillConfigOverlay({ ...empty, workerModel: "glm-5.3", existing })!)).toEqual({
      features: { web_fetch: true },
      models: { default_reasoning_effort: "high", worker: "glm-5.3" },
    });
  });
});
