// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseMentionChipHref } from "./mention-chips";

// ============================================================================
// parseMentionChipHref
// ============================================================================

describe("parseMentionChipHref — agent mentions", () => {
  it("parses a valid agent mention href", () => {
    const result = parseMentionChipHref("agent://agent-id-123");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("agent");
    if (result?.kind === "agent") {
      expect(result.agentId).toBe("agent-id-123");
    }
  });

  it("parses agent icon from query param i", () => {
    const result = parseMentionChipHref("agent://agent-id-456?i=bot");
    expect(result?.kind).toBe("agent");
    if (result?.kind === "agent") {
      expect(result.icon).toBe("bot");
    }
  });

  it("parses agent icon from query param icon", () => {
    const result = parseMentionChipHref("agent://agent-id-789?icon=star");
    expect(result?.kind).toBe("agent");
    if (result?.kind === "agent") {
      expect(result.icon).toBe("star");
    }
  });

  it("returns null icon when no icon param is present", () => {
    const result = parseMentionChipHref("agent://agent-id-no-icon");
    expect(result?.kind).toBe("agent");
    if (result?.kind === "agent") {
      expect(result.icon).toBeNull();
    }
  });
});

describe("parseMentionChipHref — project mentions", () => {
  it("parses a valid project mention href", () => {
    const result = parseMentionChipHref("project://project-id-123");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("project");
    if (result?.kind === "project") {
      expect(result.projectId).toBe("project-id-123");
    }
  });

  it("parses project color from query param", () => {
    const result = parseMentionChipHref("project://project-id-456?color=ff5733");
    expect(result?.kind).toBe("project");
    if (result?.kind === "project") {
      expect(result.color).toBe("#ff5733");
    }
  });
});

describe("parseMentionChipHref — skill mentions", () => {
  it("parses a valid skill mention href", () => {
    const result = parseMentionChipHref("skill://skill-id-123");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("skill");
    if (result?.kind === "skill") {
      expect(result.skillId).toBe("skill-id-123");
    }
  });
});

describe("parseMentionChipHref — invalid input", () => {
  it("returns null for plain https URL", () => {
    const result = parseMentionChipHref("https://example.com");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = parseMentionChipHref("");
    expect(result).toBeNull();
  });

  it("returns null for plain text", () => {
    const result = parseMentionChipHref("not a url at all");
    expect(result).toBeNull();
  });

  it("returns null for unknown scheme", () => {
    const result = parseMentionChipHref("unknown://some-id");
    expect(result).toBeNull();
  });
});
