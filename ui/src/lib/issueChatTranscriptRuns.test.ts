import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { IssueChatLinkedRun } from "./issue-chat-messages";
import { MAX_ISSUE_CHAT_TRANSCRIPT_RUNS, resolveIssueChatTranscriptRuns } from "./issueChatTranscriptRuns";

function linkedRun(n: number, isoDate: string): IssueChatLinkedRun {
  return {
    runId: `run-${n}`,
    status: "succeeded",
    agentId: "agent-1",
    adapterType: "codex_local",
    createdAt: isoDate,
    startedAt: isoDate,
    finishedAt: isoDate,
    hasStoredOutput: true,
  } as IssueChatLinkedRun;
}

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

  it("caps linked runs to the limit, keeping the most recent by createdAt", () => {
    // 30 runs, run-0 oldest … run-29 newest.
    const linkedRuns = Array.from({ length: 30 }, (_, i) =>
      linkedRun(i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );

    const runs = resolveIssueChatTranscriptRuns({ linkedRuns });

    expect(runs.length).toBe(MAX_ISSUE_CHAT_TRANSCRIPT_RUNS);
    // Newest run retained, oldest dropped.
    const ids = runs.map((r) => r.id);
    expect(ids).toContain("run-29");
    expect(ids).not.toContain("run-0");
  });

  it("respects a custom limit", () => {
    const linkedRuns = Array.from({ length: 10 }, (_, i) =>
      linkedRun(i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );

    const runs = resolveIssueChatTranscriptRuns({ linkedRuns, limit: 3 });

    expect(runs.length).toBe(3);
    expect(runs.map((r) => r.id)).toEqual(["run-9", "run-8", "run-7"]);
  });

  it("always retains live/active runs even beyond the limit", () => {
    const linkedRuns = Array.from({ length: 25 }, (_, i) =>
      linkedRun(i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    const liveRuns = [
      { id: "live-1", status: "running", adapterType: "claude_local", logBytes: null, lastOutputBytes: 10 },
    ] as unknown as LiveRunForIssue[];

    const runs = resolveIssueChatTranscriptRuns({ linkedRuns, liveRuns, limit: 5 });

    const ids = runs.map((r) => r.id);
    // The live run is always present; linked runs fill the remaining slots.
    expect(ids).toContain("live-1");
    expect(runs.length).toBe(5);
  });
});
