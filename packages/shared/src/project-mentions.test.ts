import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildPipelineMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
  extractPipelineMentions,
  extractProjectMentionIds,
  extractRoutineMentionIds,
  extractSkillMentionIds,
  extractUserMentionIds,
  parseAgentMentionHref,
  parsePipelineMentionHref,
  parseProjectMentionHref,
  parseRoutineMentionHref,
  parseSkillMentionHref,
  parseUserMentionHref,
} from "./project-mentions.js";

describe("project-mentions", () => {
  it("round-trips project mentions with color metadata", () => {
    const href = buildProjectMentionHref("project-123", "#336699");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: "#336699",
    });
    expect(extractProjectMentionIds(`[@Paperclip App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips agent mentions with icon metadata", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: "code",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual(["agent-123"]);
  });

  it("round-trips user mentions", () => {
    const href = buildUserMentionHref("user-123");
    expect(parseUserMentionHref(href)).toEqual({
      userId: "user-123",
    });
    expect(extractUserMentionIds(`[@Taylor](${href})`)).toEqual(["user-123"]);
  });

  it("round-trips skill mentions with slug metadata", () => {
    const href = buildSkillMentionHref("skill-123", "release-changelog");
    expect(parseSkillMentionHref(href)).toEqual({
      skillId: "skill-123",
      slug: "release-changelog",
    });
    expect(extractSkillMentionIds(`[/release-changelog](${href})`)).toEqual(["skill-123"]);
  });

  it("round-trips routine mentions", () => {
    const href = buildRoutineMentionHref("routine-123");
    expect(parseRoutineMentionHref(href)).toEqual({
      routineId: "routine-123",
    });
    expect(extractRoutineMentionIds(`[/routine:Weekly review](${href})`)).toEqual(["routine-123"]);
  });

  it("round-trips pipeline mentions with stage metadata", () => {
    const href = buildPipelineMentionHref("pipeline-123", "asset-review");
    expect(parsePipelineMentionHref(href)).toEqual({
      pipelineId: "pipeline-123",
      stageKey: "asset-review",
    });
    expect(extractPipelineMentions(`[/pipeline:Assets / asset review](${href})`)).toEqual([
      { pipelineId: "pipeline-123", stageKey: "asset-review" },
    ]);
  });
});
