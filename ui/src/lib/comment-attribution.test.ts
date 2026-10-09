import { describe, expect, it } from "vitest";

import { resolveCommentAttribution } from "./comment-attribution";

const labels = new Map([["user-dotta", "Dotta"]]);
const resolveUserLabel = (id: string) => labels.get(id) ?? null;

describe("resolveCommentAttribution", () => {
  it("chips a non-assignee agent comment with the responsible user's name", () => {
    expect(resolveCommentAttribution({
      authorAgentId: "agent-fable",
      onBehalfOfUserId: "user-dotta",
      issueAssigneeAgentId: "agent-codex",
      resolveUserLabel,
    })).toEqual({ userName: "Dotta" });
  });

  it("stays silent for the assignee's own comments", () => {
    expect(resolveCommentAttribution({
      authorAgentId: "agent-fable",
      onBehalfOfUserId: "user-dotta",
      issueAssigneeAgentId: "agent-fable",
      resolveUserLabel,
    })).toBeNull();
  });

  it("stays silent for human and system comments", () => {
    expect(resolveCommentAttribution({
      authorAgentId: null,
      onBehalfOfUserId: "user-dotta",
      issueAssigneeAgentId: "agent-codex",
      resolveUserLabel,
    })).toBeNull();
  });

  it("stays silent when the server recorded no responsible user", () => {
    // Pre-migration comments have a null column; they must not render a chip.
    expect(resolveCommentAttribution({
      authorAgentId: "agent-fable",
      onBehalfOfUserId: null,
      issueAssigneeAgentId: "agent-codex",
      resolveUserLabel,
    })).toBeNull();
  });

  it("chips an unassigned task's agent comment", () => {
    expect(resolveCommentAttribution({
      authorAgentId: "agent-fable",
      onBehalfOfUserId: "user-dotta",
      issueAssigneeAgentId: null,
      resolveUserLabel,
    })).toEqual({ userName: "Dotta" });
  });

  it("degrades to a generic label instead of leaking a raw user id", () => {
    expect(resolveCommentAttribution({
      authorAgentId: "agent-fable",
      onBehalfOfUserId: "user-unknown",
      issueAssigneeAgentId: "agent-codex",
      resolveUserLabel,
    })).toEqual({ userName: "the responsible user" });

    expect(resolveCommentAttribution({
      authorAgentId: "agent-fable",
      onBehalfOfUserId: "user-dotta",
      issueAssigneeAgentId: "agent-codex",
    })).toEqual({ userName: "the responsible user" });
  });
});
