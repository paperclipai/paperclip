import { describe, expect, it } from "vitest";
import {
  applySearchOperatorSuggestion,
  buildSearchPathFromQuery,
  parseSearchQuery,
  readSearchFiltersFromParams,
  searchOperatorSuggestions,
} from "./search-query-parser";

const context = {
  currentUserId: "user-1",
  agents: [
    { id: "agent-1", name: "Codex Coder", urlKey: "codex-coder" },
    { id: "agent-2", name: "QA" },
  ],
  projects: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Paperclip App", urlKey: "paperclip-app" },
  ],
  labels: [
    { id: "22222222-2222-4222-8222-222222222222", name: "bug" },
  ],
};

describe("parseSearchQuery", () => {
  it("parses status operators", () => {
    expect(parseSearchQuery("status:todo auth", context)).toMatchObject({
      query: "auth",
      filters: { status: ["todo"] },
      pills: [{ key: "status", value: "todo", label: "status:todo" }],
    });
  });

  it("parses assignee:me to the current user", () => {
    expect(parseSearchQuery("assignee:me", context).filters).toEqual({
      assigneeUserId: "user-1",
    });
  });

  it("parses assignee names including quoted multi-word names", () => {
    expect(parseSearchQuery("assignee:\"Codex Coder\" crash", context)).toMatchObject({
      query: "crash",
      filters: { assigneeAgentId: "agent-1" },
      pills: [{ key: "assignee", value: "Codex Coder", label: "assignee:Codex Coder" }],
    });
  });

  it("parses project names", () => {
    expect(parseSearchQuery("project:paperclip-app", context).filters).toEqual({
      projectId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("parses label names", () => {
    expect(parseSearchQuery("label:bug", context).filters).toEqual({
      labelId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("parses priority operators", () => {
    expect(parseSearchQuery("priority:high", context).filters).toEqual({
      priority: ["high"],
    });
  });

  it("parses updated:>7d as updatedWithin", () => {
    expect(parseSearchQuery("updated:>7d", context).filters).toEqual({
      updatedWithin: "7d",
    });
  });

  it("parses is:open quick filters", () => {
    expect(parseSearchQuery("is:open", context).filters).toEqual({
      status: ["backlog", "todo", "in_progress", "in_review", "blocked"],
    });
  });

  it("preserves quoted phrases in free text", () => {
    expect(parseSearchQuery("\"auth flake\" status:blocked", context)).toMatchObject({
      query: "\"auth flake\"",
      filters: { status: ["blocked"] },
    });
  });

  it("parses mixed free text and multiple operators", () => {
    expect(parseSearchQuery("auth status:in_progress priority:critical project:paperclip-app", context)).toMatchObject({
      query: "auth",
      filters: {
        status: ["in_progress"],
        priority: ["critical"],
        projectId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("falls unknown operators through to plain text", () => {
    expect(parseSearchQuery("owner:me auth", context)).toMatchObject({
      query: "owner:me auth",
      filters: {},
      pills: [],
    });
  });

  it("falls malformed values through to plain text", () => {
    expect(parseSearchQuery("status:notreal updated:>soon priority:urgent", context)).toMatchObject({
      query: "status:notreal updated:>soon priority:urgent",
      filters: {},
      pills: [],
    });
  });
});

describe("search query URLs", () => {
  it("builds /search paths with parsed filters", () => {
    expect(buildSearchPathFromQuery("auth status:todo updated:>7d", context)).toBe(
      "/search?q=auth&status=todo&updatedWithin=7d",
    );
  });

  it("reads filter params back from URLSearchParams", () => {
    const filters = readSearchFiltersFromParams(
      new URLSearchParams("q=auth&status=todo&status=blocked&priority=high&updatedWithin=7d"),
    );
    expect(filters).toEqual({
      status: ["todo", "blocked"],
      priority: ["high"],
      updatedWithin: "7d",
    });
  });
});

describe("search operator suggestions", () => {
  it("suggests syntax for the current partial token", () => {
    expect(searchOperatorSuggestions("auth sta").map((suggestion) => suggestion.token)).toEqual([
      "status:todo",
      "status:blocked",
    ]);
  });

  it("replaces only the current token when applying a suggestion", () => {
    expect(applySearchOperatorSuggestion("auth sta", "status:todo")).toBe("auth status:todo");
    expect(applySearchOperatorSuggestion("", "assignee:me")).toBe("assignee:me");
  });
});
