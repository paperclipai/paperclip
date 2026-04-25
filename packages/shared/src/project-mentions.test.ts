import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
  extractAgentUrlKeyMentions,
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

  describe("extractAgentUrlKeyMentions", () => {
    it("extracts url-key from /PREFIX/agents/url-key mentions", () => {
      const text = "Handing off to [@Morgan (SrSWE)](/GSTA/agents/morgan-srswe) for review.";
      expect(extractAgentUrlKeyMentions(text)).toEqual(["morgan-srswe"]);
    });

    it("extracts multiple url-key mentions", () => {
      const text = "[@Alex (SrSWE Lead)](/GSTA/agents/alex-srswe-lead) and [@Jordan (SrSWE)](/GSTA/agents/jordan-srswe) please review.";
      expect(extractAgentUrlKeyMentions(text)).toEqual(["alex-srswe-lead", "jordan-srswe"]);
    });

    it("deduplicates repeated mentions", () => {
      const text = "[@Morgan](/GSTA/agents/morgan-srswe) and again [@Morgan (SrSWE)](/GSTA/agents/morgan-srswe).";
      expect(extractAgentUrlKeyMentions(text)).toEqual(["morgan-srswe"]);
    });

    it("handles different company prefixes", () => {
      const text = "[@CTO](/PAP/agents/cto) please approve.";
      expect(extractAgentUrlKeyMentions(text)).toEqual(["cto"]);
    });

    it("returns empty array for no mentions", () => {
      expect(extractAgentUrlKeyMentions("No mentions here")).toEqual([]);
    });

    it("returns empty array for empty input", () => {
      expect(extractAgentUrlKeyMentions("")).toEqual([]);
    });

    it("ignores agent:// scheme mentions (handled by extractAgentMentionIds)", () => {
      const text = "[@Agent](agent://some-uuid)";
      expect(extractAgentUrlKeyMentions(text)).toEqual([]);
    });

    it("normalizes url-keys to lowercase", () => {
      const text = "[@CTO](/GSTA/agents/CTO)";
      expect(extractAgentUrlKeyMentions(text)).toEqual(["cto"]);
    });
  });
});
