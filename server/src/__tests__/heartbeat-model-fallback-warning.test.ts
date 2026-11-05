import { describe, expect, it, vi } from "vitest";
import { postNativeModelFallbackWarning } from "../services/heartbeat.js";

describe("model fallback warning", () => {
  it("records the substitution and shows a run-attributed warning on the task", async () => {
    const addComment = vi.fn(async () => ({} as never));
    const onEvent = vi.fn(async () => undefined);
    await postNativeModelFallbackWarning({ issuesSvc: { addComment }, onEvent,
      issueId: "issue", runId: "run", requestedModel: "gpt-6.1-sol", effectiveModel: "gpt-5.6-sol", codexCliVersion: "0.156.0" });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      eventType: "runner.model_fallback", stream: "system", level: "warn",
      payload: { requestedModel: "gpt-6.1-sol", effectiveModel: "gpt-5.6-sol", codexCliVersion: "0.156.0" },
    }));
    expect(addComment).toHaveBeenCalledExactlyOnceWith("issue", expect.stringContaining("Work will continue with the compatible model"),
      { runId: "run" }, { authorType: "system",
        presentation: { kind: "system_notice", tone: "warning", title: "Using gpt-5.6-sol", density: "compact", detailsDefaultOpen: false } });
    expect(onEvent.mock.invocationCallOrder[0]).toBeLessThan(addComment.mock.invocationCallOrder[0]!);
  });
});
