import { afterEach, describe, expect, it } from "vitest";

import {
  ensureRemoteOpenCodeModelConfiguredAndAvailable,
  stripThinkBlocks,
} from "./execute.js";

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("stripThinkBlocks", () => {
  it("strips a single-line think block, leaving the rest", () => {
    expect(stripThinkBlocks("<think>internal reasoning</think>done")).toBe("done");
  });

  it("strips a multiline think block (dotall)", () => {
    const input = "<think>\nstep 1\nstep 2\n</think>Result text";
    expect(stripThinkBlocks(input)).toBe("Result text");
  });

  it("strips multiple think blocks", () => {
    const input = "<think>a</think>middle<think>b</think>end";
    expect(stripThinkBlocks(input)).toBe("middleend");
  });

  it("is inert when no think block is present", () => {
    const text = "Hello, this is normal output with no think tags.";
    expect(stripThinkBlocks(text)).toBe(text);
  });

  it("does not corrupt JSON payloads with no think tags", () => {
    const json = '{"key":"value","array":[1,2,3],"nested":{"ok":true}}';
    expect(stripThinkBlocks(json)).toBe(json);
  });

  it("does not match arbitrary angle-bracket words (only literal think tags)", () => {
    const text = "a <b>bold</b> word";
    expect(stripThinkBlocks(text)).toBe(text);
  });

  it("trims leading whitespace left after stripping a leading think block", () => {
    const input = "<think>reasoning</think>\n\nActual answer.";
    expect(stripThinkBlocks(input)).toBe("Actual answer.");
  });

  it("is non-greedy: two think blocks do not merge into one match", () => {
    const input = "<think>A</think>KEEP<think>B</think>";
    expect(stripThinkBlocks(input)).toBe("KEEP");
  });
});
