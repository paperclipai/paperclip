import { describe, expect, it } from "vitest";
import { summarizeHeartbeatRunResultJson } from "../services/heartbeat-run-summary.ts";

describe("summarizeHeartbeatRunResultJson", () => {
  it("includes blog pipeline result fields in the summary", () => {
    const summary = summarizeHeartbeatRunResultJson({
      blogRunId: "run-123",
      currentStep: "publish",
      status: "published",
      publishedUrl: "https://fluxaivory.com/test-post/",
      postId: 321,
      message: "publish complete",
    });

    expect(summary).toEqual({
      blogRunId: "run-123",
      currentStep: "publish",
      status: "published",
      publishedUrl: "https://fluxaivory.com/test-post/",
      postId: 321,
      message: "publish complete",
    });
  });
});
