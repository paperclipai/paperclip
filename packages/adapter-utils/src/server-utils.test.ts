import { describe, expect, it } from "vitest";
import {
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
  joinPromptSections,
} from "./server-utils.js";

describe("normalizePaperclipWakePayload", () => {
  it("returns null for empty or invalid input", () => {
    expect(normalizePaperclipWakePayload(null)).toBeNull();
    expect(normalizePaperclipWakePayload(undefined)).toBeNull();
    expect(normalizePaperclipWakePayload({})).toBeNull();
    expect(normalizePaperclipWakePayload("string")).toBeNull();
  });

  it("normalizes a payload with comments", () => {
    const result = normalizePaperclipWakePayload({
      reason: "issue_comment_mentioned",
      issue: { id: "issue-1", identifier: "DSPA-100", title: "Test issue", status: "in_progress", priority: "high" },
      commentIds: ["c1"],
      latestCommentId: "c1",
      comments: [{ id: "c1", issueId: "issue-1", body: "Hello", author: { type: "agent", id: "a1" } }],
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("issue_comment_mentioned");
    expect(result!.issue?.identifier).toBe("DSPA-100");
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].body).toBe("Hello");
  });

  it("normalizes a payload with only commentIds", () => {
    const result = normalizePaperclipWakePayload({
      commentIds: ["c1", "c2"],
      comments: [],
    });
    expect(result).not.toBeNull();
    expect(result!.commentIds).toEqual(["c1", "c2"]);
    expect(result!.comments).toHaveLength(0);
  });

  it("filters out empty comment bodies", () => {
    const result = normalizePaperclipWakePayload({
      comments: [
        { body: "valid", author: {} },
        { body: "", author: {} },
        { body: "   ", author: {} },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(1);
    expect(result!.comments[0].body).toBe("valid");
  });
});

describe("renderPaperclipWakePrompt", () => {
  it("returns empty string for null/invalid payload", () => {
    expect(renderPaperclipWakePrompt(null)).toBe("");
    expect(renderPaperclipWakePrompt({})).toBe("");
  });

  it("renders a wake prompt with comments", () => {
    const result = renderPaperclipWakePrompt({
      reason: "issue_comment_mentioned",
      issue: { id: "i1", identifier: "DSPA-42", title: "Test" },
      comments: [{ id: "c1", body: "Please review", author: { type: "agent", id: "a1" }, createdAt: "2026-04-04T12:00:00Z" }],
    });
    expect(result).toContain("Paperclip Wake Payload");
    expect(result).toContain("DSPA-42");
    expect(result).toContain("Please review");
  });

  it("renders a resumed session prompt", () => {
    const result = renderPaperclipWakePrompt(
      {
        reason: "issue_comment_mentioned",
        issue: { id: "i1", identifier: "DSPA-42" },
        comments: [{ body: "Update", author: {} }],
      },
      { resumedSession: true },
    );
    expect(result).toContain("Paperclip Resume Delta");
    expect(result).not.toContain("Paperclip Wake Payload");
  });
});

describe("joinPromptSections", () => {
  it("joins non-empty sections with default separator", () => {
    expect(joinPromptSections(["a", "b", "c"])).toBe("a\n\nb\n\nc");
  });

  it("filters out empty, null, and undefined sections", () => {
    expect(joinPromptSections(["a", "", null, undefined, "b"])).toBe("a\n\nb");
  });

  it("trims whitespace from sections", () => {
    expect(joinPromptSections(["  a  ", "  b  "])).toBe("a\n\nb");
  });

  it("uses custom separator", () => {
    expect(joinPromptSections(["a", "b"], "\n---\n")).toBe("a\n---\nb");
  });

  it("returns empty string when all sections are empty", () => {
    expect(joinPromptSections(["", null, undefined, "   "])).toBe("");
  });
});
