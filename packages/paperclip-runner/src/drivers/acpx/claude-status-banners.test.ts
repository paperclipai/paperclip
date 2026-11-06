import { describe, expect, it } from "vitest";
import { classifyClaudeStatusBanner } from "./claude-status-banners.js";

describe("classifyClaudeStatusBanner", () => {
  it("classifies the claude-agent-acp compaction banners", () => {
    expect(classifyClaudeStatusBanner("Compacting...", null)).toMatchObject({ category: "context_compaction", phase: "running" });
    expect(classifyClaudeStatusBanner("\n\nCompacting completed.", null)).toMatchObject({ category: "context_compaction", phase: "completed" });
    expect(classifyClaudeStatusBanner("\n\nCompacting failed: Conversation too long", null)).toMatchObject({
      category: "context_compaction", phase: "failed", severity: "warning", summary: "Conversation too long",
    });
    expect(classifyClaudeStatusBanner("\n\nCompacting failed.", null)?.summary).toBe("Context compaction failed.");
  });

  it("parses model fallback into the original and fallback models", () => {
    const banner = classifyClaudeStatusBanner(
      "**Model fallback:** claude-opus-5-5 declined this request (cyber); retried with claude-sonnet-5-5. The session will continue on claude-sonnet-5-5.\n\nExplanation.",
      null,
    );
    expect(banner).toMatchObject({
      category: "model_fallback",
      details: [
        { name: "Original model", value: "claude-opus-5-5" },
        { name: "Fallback model", value: "claude-sonnet-5-5" },
        { name: "Reason", value: "declined the request (cyber)" },
      ],
    });
  });

  it("classifies prominent SDK informational banners", () => {
    expect(classifyClaudeStatusBanner("**Warning:** Stop hook blocked continuation", null)).toMatchObject({
      category: "provider_informational", severity: "warning", summary: "Stop hook blocked continuation",
    });
    expect(classifyClaudeStatusBanner("**Notice:** Using cached credentials", null)?.severity).toBe("info");
  });

  it("leaves model output alone, including identical text from a streamed message", () => {
    expect(classifyClaudeStatusBanner("Compacting...", "msg_01")).toBeNull();
    expect(classifyClaudeStatusBanner("**Warning:** this API is deprecated", "msg_01")).toBeNull();
    expect(classifyClaudeStatusBanner("Compacting the bundle now.", null)).toBeNull();
    expect(classifyClaudeStatusBanner("Done.", null)).toBeNull();
  });
});
