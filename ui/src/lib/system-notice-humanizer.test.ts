import { describe, expect, it } from "vitest";
import { humanizeSystemNotice } from "./system-notice-humanizer";

describe("humanizeSystemNotice", () => {
  it("uses presentation title and tone when present", () => {
    const result = humanizeSystemNotice({
      body: "Paperclip automatically retried dispatch but it still has no live execution path.",
      presentation: {
        kind: "system_notice",
        tone: "danger",
        title: "Run recovery exhausted",
        detailsDefaultOpen: false,
      },
    });
    expect(result).toEqual({ title: "Run recovery exhausted", tone: "danger" });
  });

  it("classifies claude_auth_required retry failures", () => {
    const result = humanizeSystemNotice({
      body:
        "Paperclip automatically retried continuation for this assigned `in_progress` issue during terminal run " +
        "recovery, but it still has no live execution path. Latest retry failure: `claude_auth_required` - adapter " +
        "handshake failed. Moving it to `blocked` so it is visible for intervention.",
    });
    expect(result.title).toBe("Task paused — Claude needs re-authentication");
    expect(result.tone).toBe("warning");
  });

  it("classifies configuration_incomplete failures", () => {
    const result = humanizeSystemNotice({
      body:
        "Paperclip stopped before dispatching the adapter because required secret/env bindings are missing. " +
        "Latest retry failure: `configuration_incomplete`. Moving it to `blocked` with a source-scoped recovery action.",
    });
    expect(result.title).toBe("Task paused — a secret/config binding is missing");
    expect(result.tone).toBe("warning");
  });

  it("classifies missing secret bindings even without a failure code", () => {
    const result = humanizeSystemNotice({
      body:
        "Paperclip stopped before dispatching the adapter because required secret/env bindings are missing. " +
        "Moving it to `blocked` so an operator can bind the missing secret(s).",
    });
    expect(result.title).toBe("Task paused — a secret/config binding is missing");
  });

  it("classifies workspace validation failures", () => {
    const result = humanizeSystemNotice({
      body:
        "Paperclip stopped before launching the local adapter because the issue workspace failed validation. " +
        "This prevents git-sensitive adapters from running in an unrelated fallback cwd.",
    });
    expect(result.title).toBe("Task paused — workspace problem");
    expect(result.tone).toBe("warning");
  });

  it("names the recovery owner from the markdown link for generic no-live-execution-path notices", () => {
    const result = humanizeSystemNotice({
      body:
        "Paperclip automatically retried dispatch for this assigned `todo` issue during terminal run recovery, " +
        "but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.\n\n" +
        "- Recovery action: `ra-123`\n" +
        "- Recovery owner: [Dana the Manager](/PAP/agents/agent-9)\n" +
        "- Next action: the recovery owner should restore a live execution path.",
    });
    expect(result.title).toBe("Task paused — waiting on Dana the Manager");
    expect(result.tone).toBe("warning");
  });

  it("still humanizes no-live-execution-path notices without an owner link", () => {
    const result = humanizeSystemNotice({
      body:
        "Paperclip automatically retried dispatch, but it still has no live execution path. " +
        "Moving it to `blocked` so it is visible for intervention.",
    });
    expect(result.title).toBe("Task paused — waiting on a recovery owner");
  });

  it("falls back to System update plus a truncated first sentence", () => {
    const longFirstSentence =
      "The heartbeat scheduler observed an unusual condition while reconciling this issue's run ledger against the " +
      "control plane state and recorded the discrepancy for later review.";
    const result = humanizeSystemNotice({ body: `${longFirstSentence} Second sentence here.` });
    expect(result.title).toBe("System update");
    expect(result.tone).toBe("neutral");
    expect(result.detail).toBeDefined();
    expect(result.detail!.length).toBeLessThanOrEqual(80);
    expect(result.detail!.endsWith("…")).toBe(true);
  });

  it("keeps a short first sentence untruncated in the fallback detail", () => {
    const result = humanizeSystemNotice({ body: "Run rescheduled. More context follows." });
    expect(result).toEqual({
      title: "System update",
      tone: "neutral",
      detail: "Run rescheduled.",
    });
  });
});
