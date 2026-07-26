import { describe, expect, it } from "vitest";
import { buildAntigravityArgs } from "./execute.js";
import { parseAntigravityOutput } from "./parse.js";
import { sessionCodec } from "./index.js";

describe("antigravity_local execute helpers", () => {
  it("builds agy print-mode args for fresh sessions", () => {
    expect(buildAntigravityArgs({
      prompt: "Do the work",
      printTimeout: "10m0s",
      sessionId: null,
      autoApprove: true,
      sandbox: false,
      extraDirs: ["/tmp/extra"],
      extraArgs: ["--log-file", "/tmp/agy.log"],
    })).toEqual([
      "--print",
      "Do the work",
      "--print-timeout",
      "10m0s",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/tmp/extra",
      "--log-file",
      "/tmp/agy.log",
    ]);
  });

  it("builds agy conversation resume args for saved sessions", () => {
    expect(buildAntigravityArgs({
      prompt: "Resume this",
      printTimeout: "5m0s",
      sessionId: "conv-123",
      autoApprove: false,
      sandbox: true,
      extraDirs: [],
      extraArgs: [],
    })).toEqual([
      "--print",
      "Resume this",
      "--print-timeout",
      "5m0s",
      "--conversation",
      "conv-123",
      "--sandbox",
    ]);
  });

  it("serializes conversation session ids", () => {
    expect(sessionCodec.deserialize({ conversationId: "conv-123", cwd: "/repo" })).toEqual({
      sessionId: "conv-123",
      cwd: "/repo",
    });
    expect(sessionCodec.serialize({ sessionId: "conv-123", cwd: "/repo" })).toEqual({
      sessionId: "conv-123",
      cwd: "/repo",
    });
    expect(sessionCodec.getDisplayId?.({ conversation_id: "conv-123" })).toBe("conv-123");
  });

  it("extracts conversation ids when agy prints them", () => {
    expect(parseAntigravityOutput("Conversation ID: conv-123\nDone").sessionId).toBe("conv-123");
  });
});

/**
 * Regression cover added 2026-07-26.
 *
 * Until this date the adapter NEVER emitted `--model`, and nothing read `config.model`. Every
 * agy lane therefore ran on agy's session default, `config.model` was silently ignored (no
 * effect, no warning), and the Google AI Pro plan's Claude Opus 4.6 / Claude Sonnet 4.6 /
 * GPT-OSS 120B bands — which draw on usage allowances SEPARATE from Gemini's, and which we pay
 * for — had never been consumed at all.
 *
 * It also produced the lane-health guard's 25 standing "antigravity_local agents naming a Gemini
 * model the adapter never selects" findings. They were exactly right: it could not select any.
 */
describe("antigravity_local model selection", () => {
  const base = {
    prompt: "p",
    printTimeout: "",
    sessionId: null,
    autoApprove: false,
    sandbox: false,
    extraDirs: [] as string[],
    extraArgs: [] as string[],
  };

  it("passes a configured model through to agy --model, verbatim", () => {
    // The display name, spaces and effort suffix included, is what agy accepts. Mangling it to
    // the dashed internal form (`claude-opus-4-6`) is rejected: "not recognized as a known model".
    expect(buildAntigravityArgs({ ...base, model: "Claude Opus 4.6 (Thinking)" }))
      .toEqual(["--print", "p", "--model", "Claude Opus 4.6 (Thinking)"]);
  });

  it("omits --model entirely when none is configured", () => {
    // Preserves the pre-2026-07-26 behaviour for agents that never set a model: agy uses its
    // own session default rather than being pinned to something we guessed.
    expect(buildAntigravityArgs({ ...base, model: null })).toEqual(["--print", "p"]);
    expect(buildAntigravityArgs({ ...base, model: "" })).toEqual(["--print", "p"]);
    expect(buildAntigravityArgs({ ...base, model: "   " })).toEqual(["--print", "p"]);
  });

  it("lets an explicit extraArgs --model win over config.model", () => {
    // extraArgs was the pre-fix workaround and some bench entries still rely on it, so it must
    // come last and therefore take precedence.
    const args = buildAntigravityArgs({
      ...base,
      model: "Gemini 3.1 Pro (High)",
      extraArgs: ["--model", "GPT-OSS 120B (Medium)"],
    });
    expect(args.slice(-2)).toEqual(["--model", "GPT-OSS 120B (Medium)"]);
  });
});
