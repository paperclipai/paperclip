import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  canonicalizeAgentMentionLinks,
  extractAgentMentionIds,
  extractProjectMentionIds,
  extractSkillMentionIds,
  extractUserMentionIds,
  parseAgentMentionHref,
  parseProjectMentionHref,
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
});

describe("canonicalizeAgentMentionLinks", () => {
  const STAMAT_ID = "4cc20438-8403-4f37-995a-b91d7f6734b8";
  const OVERLORD_ID = "5772a3a1-4c7e-4da0-9e18-72b327db736c";
  const agents = [
    { id: STAMAT_ID, name: "Stamat" },
    { id: OVERLORD_ID, name: "Overlord" },
  ];

  it("rewrites bad Stamat-CTO label with Overlord ID to canonical Stamat mention", () => {
    const input = `[@Stamat-CTO](agent://${OVERLORD_ID})`;
    expect(canonicalizeAgentMentionLinks(input, agents)).toBe(
      `[@Stamat](agent://${STAMAT_ID})`,
    );
  });

  it("leaves correct Overlord mention unchanged", () => {
    const input = `[@Overlord](agent://${OVERLORD_ID})`;
    expect(canonicalizeAgentMentionLinks(input, agents)).toBe(input);
  });

  it("does not rewrite when label has no matching agent", () => {
    const input = `[@UnknownAgent](agent://${OVERLORD_ID})`;
    expect(canonicalizeAgentMentionLinks(input, agents)).toBe(input);
  });

  it("leaves mention unchanged when label ID is already correct", () => {
    const input = `[@Stamat-CTO](agent://${STAMAT_ID})`;
    expect(canonicalizeAgentMentionLinks(input, agents)).toBe(input);
  });

  it("rewrites Name (Role) parenthesized suffix pattern", () => {
    const input = `[@Stamat (CTO)](agent://${OVERLORD_ID})`;
    expect(canonicalizeAgentMentionLinks(input, agents)).toBe(
      `[@Stamat](agent://${STAMAT_ID})`,
    );
  });

  it("does not rewrite when multiple agents share the same name prefix", () => {
    const ambiguous = [
      { id: "id-1", name: "Stamat" },
      { id: "id-2", name: "Stamat" },
    ];
    const input = `[@Stamat-CTO](agent://${OVERLORD_ID})`;
    expect(canonicalizeAgentMentionLinks(input, ambiguous)).toBe(input);
  });

  it("rewrites multiple mentions in one body independently", () => {
    const body = `[@Stamat-CTO](agent://${OVERLORD_ID}) and [@Overlord](agent://${OVERLORD_ID})`;
    const result = canonicalizeAgentMentionLinks(body, agents);
    expect(result).toBe(
      `[@Stamat](agent://${STAMAT_ID}) and [@Overlord](agent://${OVERLORD_ID})`,
    );
  });

  it("returns body unchanged when agents list is empty", () => {
    const input = `[@Stamat-CTO](agent://${OVERLORD_ID})`;
    expect(canonicalizeAgentMentionLinks(input, [])).toBe(input);
  });
});
