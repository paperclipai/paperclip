import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
  extractProjectMentionIds,
  extractRoutineMentionIds,
  extractSkillMentionIds,
  extractUserMentionIds,
  parseAgentMentionHref,
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

  it("ignores agent mentions inside inline code and fenced code blocks", () => {
    const liveHref = buildAgentMentionHref("agent-live");
    const codeHref = buildAgentMentionHref("agent-code");
    const markdown = [
      `Use [@Live](${liveHref}) here.`,
      "",
      `\`[@Code](${codeHref})\` should not count.`,
      "",
      "```md",
      `[@CodeFence](${buildAgentMentionHref("agent-fence")})`,
      "```",
    ].join("\n");

    expect(extractAgentMentionIds(markdown)).toEqual(["agent-live"]);
  });

  it("ignores agent mentions inside indented tilde fenced code blocks", () => {
    const liveHref = buildAgentMentionHref("agent-live");
    const codeHref = buildAgentMentionHref("agent-code");
    const markdown = [
      `Use [@Live](${liveHref}) here.`,
      "",
      "  ~~~md",
      `  [@Code](${codeHref})`,
      "  ~~~",
    ].join("\n");

    expect(extractAgentMentionIds(markdown)).toEqual(["agent-live"]);
  });

  it("does not treat fence lines with trailing text as closing fences", () => {
    const liveHref = buildAgentMentionHref("agent-live");
    const hiddenHref = buildAgentMentionHref("agent-hidden");
    const markdown = [
      `Use [@Live](${liveHref}) here.`,
      "",
      "```md",
      `[@Hidden](${hiddenHref})`,
      "```not-close",
      `[@StillHidden](${buildAgentMentionHref("agent-still-hidden")})`,
      "```",
    ].join("\n");

    expect(extractAgentMentionIds(markdown)).toEqual(["agent-live"]);
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
});
