import { describe, expect, it } from "vitest";
import { resolveIssueChatTranscriptRuns } from "./issueChatTranscriptRuns";

describe("resolveIssueChatTranscriptRuns", () => {
  it("uses adapterType from linked runs without requiring agent metadata", () => {
    const runs = resolveIssueChatTranscriptRuns({
      linkedRuns: [
        {
          runId: "run-1",
          status: "succeeded",
          agentId: "agent-1",
          adapterType: "codex_local",
          createdAt: "2026-04-09T12:00:00.000Z",
          startedAt: "2026-04-09T12:00:00.000Z",
          finishedAt: "2026-04-09T12:01:00.000Z",
          hasStoredOutput: true,
        },
      ],
    });

    expect(runs).toEqual([
      {
        id: "run-1",
        status: "succeeded",
        adapterType: "codex_local",
        hasStoredOutput: true,
      },
    ]);
  });
});
