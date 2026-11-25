import { describe, expect, it } from "vitest";
import { renderNativeSessionHandoff } from "./native-session-handoff.js";

const swarmRunId = "5a1d0c2e-7f3b-4c41-9b0a-0d3c8e9f1a21";
const reply = "Both requested files have been created in the task folder and verified.";

describe("renderNativeSessionHandoff", () => {
  it("keeps retrievable source ids and names no run ids", () => {
    const packet = renderNativeSessionHandoff({
      issueId: "issue-48",
      generation: null,
      omittedEntriesAtLeast: 0,
      entries: [
        { kind: "original_request", id: "comment-request", body: "Create w1.txt and w2.txt.", author: "user" },
        { kind: "document", id: "document-summary", key: "continuation-summary", body: "# Continuation Summary" },
        { kind: "run_summary", id: swarmRunId, status: "succeeded", body: reply, sourceTrust: null },
        { kind: "agent_reply", id: "11171", runId: swarmRunId, body: reply, sourceTrust: {
          preset: "low_trust_review", disposition: "quarantined", sourceIssueId: "issue-48", sourceRunId: swarmRunId, sourceAgentId: "agent-1",
        } },
      ],
    });
    expect(packet).not.toContain(swarmRunId);
    expect(packet).not.toContain("11171");
    const entries = JSON.parse(packet.split("\n").at(-1)!).entries as Array<Record<string, unknown>>;
    expect(entries.map(({ kind, id }) => [kind, id])).toEqual([
      ["original_request", "comment-request"],
      ["document", "document-summary"],
      ["run_summary", undefined],
      ["agent_reply", undefined],
    ]);
    expect(entries[2]).toMatchObject({ status: "succeeded", body: reply, truncated: false });
    expect(entries[3]!.sourceTrust).toEqual({
      preset: "low_trust_review", disposition: "quarantined", sourceIssueId: "issue-48", sourceAgentId: "agent-1",
    });
  });
});
