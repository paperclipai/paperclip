import { describe, expect, it } from "vitest";
import {
  createIssueChecklistItemSchema,
  createIssueLinkSchema,
  createIssueSchema,
  reorderIssueSchema,
  updateIssueChecklistItemSchema,
  updateIssueLinkSchema,
  updateIssueSchema,
} from "./issue.js";

describe("issue validators", () => {
  it("accepts date-only due dates on create and update", () => {
    expect(createIssueSchema.parse({
      title: "Ship the launch checklist",
      dueDate: "2026-02-28",
    }).dueDate).toBe("2026-02-28");

    expect(updateIssueSchema.parse({ dueDate: "2026-03-01" }).dueDate).toBe("2026-03-01");
    expect(updateIssueSchema.parse({ dueDate: null }).dueDate).toBeNull();
  });

  it("rejects invalid or timestamp-like due dates", () => {
    expect(() => createIssueSchema.parse({
      title: "Invalid calendar date",
      dueDate: "2026-02-30",
    })).toThrow();

    expect(() => updateIssueSchema.parse({
      dueDate: "2026-02-28T12:00:00.000Z",
    })).toThrow();
  });

  it("validates checklist item create and update payloads", () => {
    expect(createIssueChecklistItemSchema.parse({ title: "  Write tests  " })).toEqual({ title: "Write tests" });
    expect(updateIssueChecklistItemSchema.parse({ completed: true })).toEqual({ completed: true });
    expect(updateIssueChecklistItemSchema.parse({ title: "  Polish UI  ", position: 2 })).toEqual({
      title: "Polish UI",
      position: 2,
    });

    expect(() => createIssueChecklistItemSchema.parse({ title: "" })).toThrow();
    expect(() => updateIssueChecklistItemSchema.parse({})).toThrow();
  });

  it("validates issue link create and update payloads", () => {
    expect(createIssueLinkSchema.parse({
      url: "  https://example.com/spec  ",
      title: "  Spec  ",
    })).toEqual({
      url: "https://example.com/spec",
      title: "Spec",
    });
    expect(updateIssueLinkSchema.parse({ title: null })).toEqual({ title: null });

    expect(() => createIssueLinkSchema.parse({ url: "ftp://example.com/spec" })).toThrow();
    expect(() => updateIssueLinkSchema.parse({})).toThrow();
  });

  it("accepts Apple Notes issue link URLs without allowing unsafe schemes", () => {
    expect(createIssueLinkSchema.parse({
      url: "https://www.icloud.com/notes/0123456789#SharedNote",
    })).toMatchObject({
      url: "https://www.icloud.com/notes/0123456789#SharedNote",
    });
    expect(createIssueLinkSchema.parse({
      url: "applenotes://showNote?identifier=ABCDEF",
    })).toMatchObject({
      url: "applenotes://showNote?identifier=ABCDEF",
    });
    expect(updateIssueLinkSchema.parse({
      url: "notes://showNote?identifier=ABCDEF",
    })).toMatchObject({
      url: "notes://showNote?identifier=ABCDEF",
    });

    expect(() => createIssueLinkSchema.parse({ url: "javascript:alert(1)" })).toThrow(/Apple Notes/);
    expect(() => createIssueLinkSchema.parse({ url: "file:///tmp/note.txt" })).toThrow(/Apple Notes/);
  });

  it("validates issue reorder payloads", () => {
    expect(reorderIssueSchema.parse({
      status: "todo",
      beforeIssueId: null,
    })).toEqual({
      status: "todo",
      beforeIssueId: null,
    });
    expect(reorderIssueSchema.parse({
      status: "blocked",
      beforeIssueId: "11111111-1111-4111-8111-111111111111",
    })).toEqual({
      status: "blocked",
      beforeIssueId: "11111111-1111-4111-8111-111111111111",
    });

    expect(() => reorderIssueSchema.parse({ status: "waiting" })).toThrow();
    expect(() => reorderIssueSchema.parse({ status: "todo", beforeIssueId: "PAP-1" })).toThrow();
  });
});
