import { describe, expect, it } from "vitest";
import { appendTaskMarkdownNote, appendTaskMarkdownNoteWhenPresent } from "./task-context.js";

describe("appendTaskMarkdownNoteWhenPresent", () => {
  it("does not create task markdown for a run without an issue", () => {
    const context: Record<string, unknown> = { paperclipWorkspaces: [] };
    appendTaskMarkdownNoteWhenPresent(context, "note");
    expect(context).toEqual({ paperclipWorkspaces: [] });
  });

  it("appends to existing task markdown, and to compact variants only when they exist", () => {
    const context: Record<string, unknown> = {
      paperclipTaskMarkdown: "task\n",
      paperclipTaskMarkdownAssignment: "assigned",
      paperclipTaskMarkdownCompact: "short",
    };
    appendTaskMarkdownNoteWhenPresent(context, "note");
    expect(context).toEqual({
      paperclipTaskMarkdown: "task\nnote",
      paperclipTaskMarkdownAssignment: "assigned\nnote",
      paperclipTaskMarkdownCompact: "short\nnote",
    });
  });
});

describe("appendTaskMarkdownNote", () => {
  it("still creates the fields when absent, as the concurrent-hold path relies on", () => {
    const context: Record<string, unknown> = {};
    appendTaskMarkdownNote(context, "note");
    expect(context).toEqual({ paperclipTaskMarkdown: "note", paperclipTaskMarkdownAssignment: "note" });
  });
});
