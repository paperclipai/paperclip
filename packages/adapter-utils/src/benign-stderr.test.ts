import { describe, expect, it } from "vitest";
import { firstMeaningfulStderrLine, isBenignAdapterStderrLine } from "./benign-stderr.js";

const YOLO = "YOLO mode is enabled. All tool calls will be automatically approved.";

describe("isBenignAdapterStderrLine", () => {
  it("treats the approvals-bypass banner as benign", () => {
    expect(isBenignAdapterStderrLine(YOLO)).toBe(true);
  });

  it("treats adapter-injected diagnostics as benign", () => {
    expect(isBenignAdapterStderrLine("[paperclip] Confining the agent to the workspace.")).toBe(true);
  });

  it("never treats a real failure as benign", () => {
    expect(isBenignAdapterStderrLine("Error: boom")).toBe(false);
    expect(
      isBenignAdapterStderrLine(
        "GEMINI_SANDBOX is true but failed to determine command for sandbox; install docker or podman",
      ),
    ).toBe(false);
  });
});

describe("firstMeaningfulStderrLine", () => {
  it("skips banners to reach the real error", () => {
    expect(firstMeaningfulStderrLine(`${YOLO}\nError: boom`)).toBe("Error: boom");
  });

  it("skips the exact production stack of banners", () => {
    const stderr = [
      "[paperclip] Adapter execution timeout: timeoutSec=14400 (sandbox default).",
      "[paperclip] Gemini ACP default unavailable; falling back to Gemini CLI.",
      YOLO,
      "GEMINI_SANDBOX is true but failed to determine command for sandbox; install docker or podman",
    ].join("\n");
    expect(firstMeaningfulStderrLine(stderr)).toBe(
      "GEMINI_SANDBOX is true but failed to determine command for sandbox; install docker or podman",
    );
  });

  it("falls back to the first line when every line is benign", () => {
    expect(firstMeaningfulStderrLine(`${YOLO}\n[paperclip] note\n`)).toBe(YOLO);
  });

  it("returns an empty string for empty or whitespace input", () => {
    expect(firstMeaningfulStderrLine("")).toBe("");
    expect(firstMeaningfulStderrLine(" \n\t\n")).toBe("");
  });

  it("strips ANSI colour codes before matching", () => {
    expect(firstMeaningfulStderrLine(`${YOLO}\n[31mError: boom[0m`)).toBe("Error: boom");
  });
});
