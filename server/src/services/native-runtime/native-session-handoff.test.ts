import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODEL_HIDDEN_RUN_ID_KEYS, withoutModelHiddenRunIds } from "@paperclipai/adapter-utils/model-facing-history";
import { renderNativeSessionHandoff } from "./native-session-handoff.js";

const modelFacingHistorySources = [
  "../../../../packages/shared/src/types/execution-continuation.ts",
  "../execution-continuation.ts",
  "../source-trust.ts",
  "./child-review-outcomes.ts",
  "./native-session-handoff.ts",
];

describe("model-facing history run ids", () => {
  it("decides every run-id field in the sources that feed the continuation and fresh-session history", () => {
    const names = new Set(modelFacingHistorySources.flatMap((source) =>
      readFileSync(new URL(source, import.meta.url), "utf8").match(/\b(?:runId|[a-z][A-Za-z]*RunId)\b/g) ?? []));
    expect([...names].filter((name) => !MODEL_HIDDEN_RUN_ID_KEYS.has(name)).sort()).toEqual([]);
  });

  it("hides the reviewer run of a child review outcome", () => {
    const outcome = { id: "interaction-1", kind: "request_confirmation", status: "accepted",
      result: { sourceRunId: "run-a", reviewerRunId: "run-b", decision: "approved", resolvedAt: null } };
    expect(withoutModelHiddenRunIds(outcome)).toEqual({ id: "interaction-1", kind: "request_confirmation", status: "accepted",
      result: { decision: "approved", resolvedAt: null } });
  });
});

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

  it("preserves other_agent author labels alongside agent and user entries", () => {
    const packet = renderNativeSessionHandoff({
      issueId: "chat-1",
      generation: 0,
      omittedEntriesAtLeast: 0,
      entries: [
        { kind: "original_request", id: "c-user", body: "Plan the launch", author: "user" },
        { kind: "message", id: "c-peer", body: "PEER NOTE", author: "other_agent", authorAgentId: "agent-peer" },
        { kind: "message", id: "c-own", body: "OWN REPLY", author: "agent", authorAgentId: "agent-self" },
      ],
    });
    const entries = JSON.parse(packet.split("\n").at(-1)!).entries as Array<Record<string, unknown>>;
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "c-user", author: "user", body: "Plan the launch" }),
      expect.objectContaining({ id: "c-peer", author: "other_agent", authorAgentId: "agent-peer", body: "PEER NOTE" }),
      expect.objectContaining({ id: "c-own", author: "agent", authorAgentId: "agent-self", body: "OWN REPLY" }),
    ]));
  });
});
